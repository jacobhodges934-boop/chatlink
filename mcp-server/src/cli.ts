#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath, resolveToken } from "./config.js";
import { startConnector } from "./connector.js";

const HTTP_PORT = 27183;
const HEALTH_URL = `http://127.0.0.1:${HTTP_PORT}/health`;
const SHUTDOWN_URL = `http://127.0.0.1:${HTTP_PORT}/shutdown`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entryPoint(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), name);
}

async function delegateToServer(args: string[]): Promise<void> {
  process.argv = [process.argv[0], entryPoint("index.js"), ...args];
  await import("./index.js");
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

function spawnDetachedDaemon(): void {
  const child = spawn(process.execPath, [entryPoint("index.js"), "--daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function waitForHealth(timeoutMs: number): Promise<HealthPayload | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth();
    if (health) return health;
    await sleep(250);
  }
  return null;
}

function printHealth(health: HealthPayload): void {
  process.stdout.write(JSON.stringify(health, null, 2) + "\n");
}

async function startDaemon(): Promise<void> {
  const existing = await fetchHealth();
  if (existing) {
    process.stderr.write(`ChatLink daemon 已运行: pid=${existing.pid}, instanceId=${existing.instanceId}\n`);
    return;
  }

  spawnDetachedDaemon();
  const health = await waitForHealth(START_TIMEOUT_MS);
  if (!health) {
    process.stderr.write(`ChatLink daemon 启动超时 (${START_TIMEOUT_MS}ms)。\n`);
    process.exit(1);
  }
  process.stdout.write(`ChatLink daemon 已启动: pid=${health.pid}, http://127.0.0.1:${HTTP_PORT}/mcp\n`);
}

async function stopDaemon(): Promise<void> {
  const health = await fetchHealth();
  if (!health) {
    process.stdout.write("ChatLink daemon 未运行。\n");
    return;
  }

  const token = resolveToken();
  try {
    const response = await fetch(SHUTDOWN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
  } catch (err) {
    process.stderr.write(`调用关闭接口失败，尝试 SIGTERM pid=${health.pid}: ${String(err)}\n`);
    try {
      process.kill(health.pid, "SIGTERM");
    } catch (killErr) {
      process.stderr.write(`SIGTERM 失败: ${String(killErr)}\n`);
      process.exit(1);
    }
  }

  for (let i = 0; i < 40; i++) {
    if (!(await fetchHealth())) {
      process.stdout.write("ChatLink daemon 已停止。\n");
      return;
    }
    await sleep(250);
  }
  process.stderr.write("ChatLink daemon 关闭请求已发送，但进程仍可响应 /health。\n");
  process.exit(1);
}

async function status(): Promise<void> {
  const health = await fetchHealth();
  if (!health) {
    process.stdout.write("ChatLink daemon 未运行。\n");
    return;
  }
  printHealth(health);
}

async function doctor(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const health = await fetchHealth();
  const token = resolveToken();
  const checks = [
    { name: "Node.js >= 18", ok: nodeMajor >= 18, detail: process.version },
    { name: "HTTP daemon", ok: Boolean(health), detail: health ? `pid=${health.pid}, sessions=${health.sessionCount}` : "not running" },
    { name: "Bridge port 27182 / Chrome extension", ok: health?.bridgeConnected === true, detail: health ? (health.bridgeConnected ? "connected" : "not connected") : "daemon not running" },
    { name: "Token config", ok: token.length > 0, detail: getConfigPath() },
  ];

  for (const check of checks) {
    process.stdout.write(`${check.ok ? "OK" : "WARN"}  ${check.name}: ${check.detail}\n`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    await delegateToServer([]);
    return;
  }

  if (command === "--token" || command === "--http" || command.startsWith("--")) {
    await delegateToServer([command, ...rest]);
    return;
  }

  switch (command) {
    case "daemon":
      await delegateToServer(["--daemon", ...rest]);
      return;
    case "connect":
      await startConnector();
      return;
    case "start":
      await startDaemon();
      return;
    case "stop":
      await stopDaemon();
      return;
    case "status":
      await status();
      return;
    case "doctor":
      await doctor();
      return;
    default:
      process.stderr.write(
        "Usage: chatlink [daemon|connect|start|stop|status|doctor|--token|--http]\n"
      );
      process.exit(1);
  }
}

void main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
