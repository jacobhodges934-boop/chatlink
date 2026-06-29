// ── Centralized timing configuration ──────────────────────────────────────
// Policy values, not every numeric literal. Local loop counters and
// single-use string lengths stay where they are used.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export const protocolTimings = {
  listTabsTimeoutMs: 10_000,
  getContentTimeoutMs: 20_000,
  artifactsTimeoutMs: 60_000,
  sendTimeoutMs: 25_000,
} as const;

export const delegateTimings = {
  /** First N polls run at fast interval to catch short replies. */
  fastPollMs: 700,
  /** Remaining polls run at this slower interval. */
  slowPollMs: 1250,
  /** How many fast polls before switching to slow. */
  fastPollCount: 6,
  /** Quiet period for explicit-end signal before final re-read. */
  explicitEndQuietMs: 3000,
  /** Delay before final re-read. */
  finalReadDelayMs: 500,
  /** Minimum content stability for the fallback path. */
  contentStabilityMs: 5000,
  /** Consecutive stable polls needed for explicit-end. */
  explicitEndStablePolls: 2,
  /** Consecutive stable polls needed for content-stability. */
  contentStabilityPolls: 3,
  /** Minimum deadline (seconds). */
  minimumTimeoutSeconds: 5,
} as const;

export const connectionTimings = {
  bridgeRetryDelayMs: 500,
  bridgeMaxRetries: 12,
} as const;

// ── Token persistence ────────────────────────────────────────────────────

function getConfigDir(): string {
  if (process.env.CHATLINK_CONFIG_DIR) return process.env.CHATLINK_CONFIG_DIR;
  const home = homedir();
  const p = platform();
  if (p === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "ChatLink");
  }
  if (p === "darwin") return join(home, "Library", "Application Support", "ChatLink");
  // linux / others → XDG
  const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return join(xdg, "chatlink");
}

const TOKEN_LENGTH = 64; // 32 bytes → 64 hex chars

function generateToken(): string {
  return randomBytes(TOKEN_LENGTH / 2).toString("hex");
}

let _resolvedToken: string | null = null;

/**
 * Resolve the ChatLink HTTP token with the following priority:
 * 1. CHATLINK_TOKEN environment variable
 * 2. Persisted token in config directory
 * 3. First-run: generate and persist a new token
 *
 * Token is stored atomically via temp-file + rename.
 * On concurrent first-start, only the first writer wins.
 */
export function resolveToken(): string {
  if (_resolvedToken) return _resolvedToken;

  // 1. Environment variable overrides everything
  if (process.env.CHATLINK_TOKEN) {
    _resolvedToken = process.env.CHATLINK_TOKEN;
    return _resolvedToken;
  }

  const configDir = getConfigDir();
  const configPath = join(configDir, "config.json");

  // 2. Try reading persisted token
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw);
      if (cfg && typeof cfg.token === "string" && cfg.token.length === TOKEN_LENGTH) {
        _resolvedToken = cfg.token as string;
        return cfg.token as string;
      }
      // Token missing or malformed — regenerate
      process.stderr.write("ChatLink: persisted token invalid, regenerating.\n");
    }
  } catch (err) {
    // File missing or corrupt — continue to generation
    process.stderr.write(`ChatLink: reading config failed (${String(err)}), regenerating.\n`);
  }

  // 3. First run: generate and persist
  const token = generateToken();
  try {
    mkdirSync(configDir, { recursive: true });
    const cfg = { token };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600, // Owner read/write only
    });
  } catch (err) {
    process.stderr.write(`ChatLink: failed to persist token: ${String(err)}\n`);
  }

  _resolvedToken = token;
  return token;
}

/** Return the config directory path (for display purposes). */
export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}
