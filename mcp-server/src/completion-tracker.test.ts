import assert from "node:assert/strict";
import test from "node:test";
import {
  applyObservation,
  createBaseline,
  createCompletionState,
  extractNewAssistantText,
  normalizeForComparison,
  reconcileFinalRead,
  type CompletionDecision,
  type CompletionMessage,
  type CompletionState,
} from "./completion-tracker.js";

const baselineMessages: CompletionMessage[] = [
  { role: "user", content: "Start" },
  { role: "assistant", content: "Old reply" },
];

function messagesWithAssistant(content: string): CompletionMessage[] {
  return [...baselineMessages, { role: "assistant", content }];
}

function startState(options: {
  now?: number;
  timeoutMs?: number;
  sawExplicitGenerating?: boolean;
} = {}): CompletionState {
  return createCompletionState({
    baseline: createBaseline(baselineMessages),
    now: options.now ?? 0,
    timeoutMs: options.timeoutMs ?? 30_000,
    sawExplicitGenerating: options.sawExplicitGenerating,
    timings: {
      explicitEndQuietMs: 800,
      explicitEndStablePolls: 1,
      contentStabilityMs: 3_500,
      contentStabilityPolls: 2,
    },
  });
}

function observe(
  state: CompletionState,
  now: number,
  content: string,
  isGenerating?: boolean,
): CompletionDecision {
  return applyObservation(state, {
    now,
    messages: messagesWithAssistant(content),
    isGenerating,
  });
}

test("normalizes whitespace for comparison", () => {
  assert.equal(normalizeForComparison(" one\n\n two\tthree "), "one two three");
});

test("extracts assistant text added after baseline", () => {
  const baseline = createBaseline(baselineMessages);
  assert.equal(extractNewAssistantText(messagesWithAssistant("New reply"), baseline), "New reply");
});

test("long pause while still generating does not finish", () => {
  let result = observe(startState(), 100, "Draft", true);
  assert.equal(result.kind, "continue");

  result = observe(result.state, 10_000, "Draft", true);

  assert.equal(result.kind, "continue");
  assert.equal(result.state.sawExplicitGenerating, true);
  assert.equal(result.state.lastAssistantText, "Draft");
});

test("generating to idle transition requests explicit-end verification", () => {
  let result = observe(startState(), 100, "Done", true);
  assert.equal(result.kind, "continue");

  result = observe(result.state, 1_000, "Done", false);

  assert.equal(result.kind, "verify");
  assert.equal(result.reason, "explicit_end");
  assert.equal(result.text, "Done");
});

test("unknown to unknown completes through content stability without explicit generating", () => {
  let result = observe(startState(), 100, "Stable answer");
  assert.equal(result.kind, "continue");

  result = observe(result.state, 2_000, "Stable answer");
  assert.equal(result.kind, "continue");

  result = observe(result.state, 4_000, "Stable answer");

  assert.equal(result.kind, "verify");
  assert.equal(result.reason, "content_stability");
  assert.equal(result.state.sawExplicitGenerating, false);
});

test("text changes reset stability", () => {
  let result = observe(startState(), 100, "First");
  result = observe(result.state, 1_000, "First");
  assert.equal(result.state.stablePolls, 1);

  result = observe(result.state, 1_500, "First plus more");

  assert.equal(result.kind, "continue");
  assert.equal(result.state.stablePolls, 0);
  assert.equal(result.state.lastAssistantText, "First plus more");
});

test("timeout reports partial content when content exists", () => {
  let result = observe(startState({ timeoutMs: 1_000 }), 100, "Partial");
  result = observe(result.state, 1_000, "Partial", true);

  assert.equal(result.kind, "timeout");
  assert.equal(result.partial, true);
  assert.equal(result.text, "Partial");
});

test("timeout reports no partial content when no assistant content exists", () => {
  const result = applyObservation(startState({ timeoutMs: 1_000 }), {
    now: 1_000,
    messages: baselineMessages,
  });

  assert.equal(result.kind, "timeout");
  assert.equal(result.partial, false);
  assert.equal(result.text, "");
});

test("final reread continues polling when content changed", () => {
  let result = observe(startState({ sawExplicitGenerating: true }), 100, "Almost done", true);
  result = observe(result.state, 1_000, "Almost done", false);
  assert.equal(result.kind, "verify");

  const reconciled = reconcileFinalRead(result.state, {
    now: 1_500,
    messages: messagesWithAssistant("Actually done"),
    isGenerating: false,
  });

  assert.equal(reconciled.kind, "continue");
  assert.equal(reconciled.text, "Actually done");
  assert.equal(reconciled.state.stablePolls, 0);
  assert.equal(reconciled.state.pendingVerificationReason, undefined);
});
