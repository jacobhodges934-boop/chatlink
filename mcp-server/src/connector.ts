#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ResultSchema,
  type JSONRPCRequest,
  type Notification,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToken } from "./config.js";

const HTTP_PORT = 27183;
const HEALTH_URL = `http://127.0.0.1:${HTTP_PORT}/health`;
const MCP_URL = `http://127.0.0.1:${HTTP_PORT}/mcp`;
const SERVER_VERSION = "0.5.0";
const START_TIMEOUT_MS = 10_000;

type HealthPayload = {
  status: string;
  pid: number;
  instanceId: string;
  version: string;
  bridgeConnected: boolean;
  sessionCount: number;
  uptime: number;
};

let client: Client | undefined;
let httpTransport: StreamableHTTPClientTransport | undefined;
let reconnecting: Promise<Client> | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHealth(): Promise<HealthPayload | null> {
  try {
    const response = await fetch(HEALTH_URL, { method: "GET" });
    if (!response.ok) return null;
    return (await response.json()) as HealthPayload;
  } catch {
    return null;
  }
}

function daemonEntryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

function spawnDaemon(): void {
  const child = spawn(process.execPath, [daemonEntryPoint(), "--daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function ensureDaemon(): Promise<void> {
  if (await fetchHealth()) return;
  spawnDaemon();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await fetchHealth()) return;
    await sleep(250);
  }
  throw new Error(`ChatLink daemon did not become healthy within ${START_TIMEOUT_MS}ms.`);
}

async function resetClient(): Promise<void> {
  const oldTransport = httpTransport;
  client = undefined;
  httpTransport = undefined;
  if (oldTransport) {
    try {
      await oldTransport.close();
    } catch {
      // Best effort reconnect cleanup.
    }
  }
}

async function connectHttpClient(): Promise<Client> {
  await ensureDaemon();
  const token = resolveToken();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 5_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 3,
    },
  });

  const nextClient = new Client({ name: "chatlink-connector", version: SERVER_VERSION }, { capabilities: {} });
  transport.onclose = () => {
    client = undefined;
    httpTransport = undefined;
  };
  transport.onerror = (err) => {
    process.stderr.write(`[ChatLink connector] HTTP transport error: ${String(err)}\n`);
  };

  await nextClient.connect(transport);
  client = nextClient;
  httpTransport = transport;
  return nextClient;
}

async function getClient(): Promise<Client> {
  if (client) return client;
  reconnecting ??= connectHttpClient().finally(() => {
    reconnecting = undefined;
  });
  return await reconnecting;
}

async function withClient<T>(fn: (activeClient: Client) => Promise<T>): Promise<T> {
  try {
    return await fn(await getClient());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Session deleted by TTL or daemon restart — exit, don't reconnect.
    if (msg.includes("400") || msg.includes("404") || msg.includes("Session") || msg.includes("session")) {
      process.stderr.write(`[ChatLink connector] Session terminated by daemon: ${msg}\n`);
      void cleanupAndExit(0);
      throw err;
    }
    process.stderr.write(`[ChatLink connector] Reconnecting after transient error: ${msg}\n`);
    await resetClient();
    return await fn(await getClient());
  }
}

async function cleanupAndExit(exitCode = 0): Promise<never> {
  const transport = httpTransport;
  if (transport) {
    try {
      await transport.terminateSession();
    } catch (err) {
      process.stderr.write(`[ChatLink connector] Failed to terminate HTTP MCP session: ${String(err)}\n`);
    }
  }
  await resetClient();
  process.exit(exitCode);
}

export async function startConnector(): Promise<void> {
  await ensureDaemon();

  const server = new McpServer(
    { name: "chatlink-connector", version: SERVER_VERSION },
    {
      capabilities: {
        completions: {},
        prompts: {},
        resources: {},
        tools: {},
      },
    }
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.listTools(request.params));
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.callTool(request.params, CallToolResultSchema));
  });
  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.listResources(request.params));
  });
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.listResourceTemplates(request.params));
  });
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.readResource(request.params));
  });
  server.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.listPrompts(request.params));
  });
  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.getPrompt(request.params));
  });
  server.server.setRequestHandler(CompleteRequestSchema, async (request) => {
    return await withClient((activeClient) => activeClient.complete(request.params));
  });
  server.server.fallbackRequestHandler = async (request: JSONRPCRequest) => {
    return await withClient((activeClient) => activeClient.request(request as never, ResultSchema)) as Result;
  };
  server.server.fallbackNotificationHandler = async (notification: Notification) => {
    await withClient((activeClient) => activeClient.notification(notification as never));
  };

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  process.stdin.once("end", () => {
    void cleanupAndExit(0);
  });
  process.stdin.once("close", () => {
    void cleanupAndExit(0);
  });
  process.once("SIGINT", () => {
    void cleanupAndExit(0);
  });
  process.once("SIGTERM", () => {
    void cleanupAndExit(0);
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  void startConnector().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    void cleanupAndExit(1);
  });
}
