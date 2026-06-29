export interface CompletionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionBaseline {
  messages: CompletionMessage[];
  assistantContent: string;
}

export interface CompletionTimingConfig {
  explicitEndQuietMs: number;
  explicitEndStablePolls: number;
  contentStabilityMs: number;
  contentStabilityPolls: number;
}

export interface CompletionState {
  baseline: CompletionBaseline;
  startedAt: number;
  deadlineAt: number;
  lastAssistantText: string;
  lastChangedAt: number;
  sawExplicitGenerating: boolean;
  sawAssistantContent: boolean;
  stablePolls: number;
  timings: CompletionTimingConfig;
  pendingVerificationReason?: "explicit_end" | "content_stability";
}

export interface CompletionObservation {
  now: number;
  messages: readonly CompletionMessage[];
  isGenerating?: boolean;
}

export interface CompletionDecision {
  kind: "continue" | "verify" | "timeout";
  reason?: "explicit_end" | "content_stability" | "timeout";
  text: string;
  partial?: boolean;
  state: CompletionState;
}

export const defaultCompletionTimings: CompletionTimingConfig = {
  explicitEndQuietMs: 800,
  explicitEndStablePolls: 1,
  contentStabilityMs: 3_500,
  contentStabilityPolls: 2,
};

export function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function createBaseline(messages: readonly CompletionMessage[]): CompletionBaseline {
  const normalizedMessages = messages.map((message) => ({
    role: message.role,
    content: normalizeForComparison(message.content),
  }));
  const assistantContent =
    [...normalizedMessages].reverse().find((message) => message.role === "assistant")?.content ?? "";

  return { messages: normalizedMessages, assistantContent };
}

export function extractNewAssistantText(
  messages: readonly CompletionMessage[],
  baseline: CompletionBaseline,
): string {
  let newMessages = [...messages];

  if (baseline.messages.length > 0 && messages.length >= baseline.messages.length) {
    const prefixStillMatches = baseline.messages.every((base, idx) => {
      const current = messages[idx];
      return current?.role === base.role && normalizeForComparison(current.content) === base.content;
    });

    if (prefixStillMatches) {
      newMessages = messages.slice(baseline.messages.length);
    } else {
      const lastBase = baseline.messages[baseline.messages.length - 1];
      let matchIdx = -1;
      for (let idx = messages.length - 1; idx >= 0; idx--) {
        if (
          messages[idx].role === lastBase.role &&
          normalizeForComparison(messages[idx].content) === lastBase.content
        ) {
          matchIdx = idx;
          break;
        }
      }
      if (matchIdx >= 0) newMessages = messages.slice(matchIdx + 1);
    }
  }

  const newAssistantText = newMessages
    .filter((message) => message.role === "assistant" && message.content.trim().length > 0)
    .map((message) => message.content.trim())
    .join("\n\n")
    .trim();
  if (newAssistantText) return newAssistantText;

  const currentAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim().length > 0);
  if (currentAssistant && normalizeForComparison(currentAssistant.content) !== baseline.assistantContent) {
    return currentAssistant.content.trim();
  }

  return "";
}

export function createCompletionState(options: {
  baseline: CompletionBaseline | readonly CompletionMessage[];
  now: number;
  timeoutMs: number;
  sawExplicitGenerating?: boolean;
  timings?: Partial<CompletionTimingConfig>;
}): CompletionState {
  const baseline =
    "assistantContent" in options.baseline ? options.baseline : createBaseline(options.baseline);

  return {
    baseline,
    startedAt: options.now,
    deadlineAt: options.now + options.timeoutMs,
    lastAssistantText: "",
    lastChangedAt: options.now,
    sawExplicitGenerating: options.sawExplicitGenerating ?? false,
    sawAssistantContent: false,
    stablePolls: 0,
    timings: { ...defaultCompletionTimings, ...options.timings },
  };
}

export function applyObservation(
  state: CompletionState,
  observation: CompletionObservation,
): CompletionDecision {
  let next = { ...state };

  if (observation.isGenerating === true) {
    next.sawExplicitGenerating = true;
  }

  const assistantText = extractNewAssistantText(observation.messages, next.baseline);

  if (assistantText) {
    next.sawAssistantContent = true;
    if (assistantText !== next.lastAssistantText) {
      next = {
        ...next,
        lastAssistantText: assistantText,
        lastChangedAt: observation.now,
        stablePolls: 0,
        pendingVerificationReason: undefined,
      };
    } else {
      next = { ...next, stablePolls: next.stablePolls + 1 };
    }
  }

  if (observation.now >= next.deadlineAt) {
    return {
      kind: "timeout",
      reason: "timeout",
      text: next.lastAssistantText,
      partial: next.lastAssistantText.length > 0,
      state: next,
    };
  }

  const idle = observation.isGenerating !== true;
  const quietForMs = observation.now - next.lastChangedAt;

  if (
    next.lastAssistantText &&
    next.sawExplicitGenerating &&
    idle &&
    next.stablePolls >= next.timings.explicitEndStablePolls &&
    quietForMs >= next.timings.explicitEndQuietMs
  ) {
    next = { ...next, pendingVerificationReason: "explicit_end" };
    return { kind: "verify", reason: "explicit_end", text: next.lastAssistantText, state: next };
  }

  if (
    next.lastAssistantText &&
    next.sawAssistantContent &&
    idle &&
    next.stablePolls >= next.timings.contentStabilityPolls &&
    quietForMs >= next.timings.contentStabilityMs
  ) {
    next = { ...next, pendingVerificationReason: "content_stability" };
    return { kind: "verify", reason: "content_stability", text: next.lastAssistantText, state: next };
  }

  return { kind: "continue", text: next.lastAssistantText, state: next };
}

export function reconcileFinalRead(
  state: CompletionState,
  observation: CompletionObservation,
): CompletionDecision {
  const finalText = extractNewAssistantText(observation.messages, state.baseline);

  if (!finalText || finalText === state.lastAssistantText) {
    return {
      kind: "verify",
      reason: state.pendingVerificationReason ?? "content_stability",
      text: state.lastAssistantText,
      state,
    };
  }

  const next = {
    ...state,
    lastAssistantText: finalText,
    lastChangedAt: observation.now,
    sawAssistantContent: true,
    stablePolls: 0,
    pendingVerificationReason: undefined,
  };

  return { kind: "continue", text: finalText, state: next };
}
