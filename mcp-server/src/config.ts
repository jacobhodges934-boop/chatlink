// ── Centralized timing configuration ──────────────────────────────────────
// Policy values, not every numeric literal. Local loop counters and
// single-use string lengths stay where they are used.

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
