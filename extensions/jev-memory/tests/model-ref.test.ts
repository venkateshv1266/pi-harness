import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseModelRef } from "../src/handlers/model-ref.js";
import {
  findExactModelReferenceMatch,
  resolveReviewModels,
} from "../src/handlers/review-memory-ops.js";
import { buildChildPiPromptArgs, hasChildLlmOverrides } from "../src/handlers/pi-child-process.js";

function fakeModel(provider: string, id: string): Model<Api> {
  return { provider, id } as unknown as Model<Api>;
}

const MODELS: Model<Api>[] = [
  fakeModel("openrouter", "deepseek/deepseek-v4.1-flash"),
  fakeModel("openrouter", "z-ai/glm-5.3"),
  fakeModel("openrouter", "z-ai/glm-5.3:batch"),
];

test("parseModelRef splits a valid thinking suffix", () => {
  assert.deepEqual(parseModelRef("deepseek/deepseek-v4.1-flash:max"), {
    ref: "deepseek/deepseek-v4.1-flash",
    thinking: "max",
  });
  assert.deepEqual(parseModelRef("z-ai/glm-5.3:off"), { ref: "z-ai/glm-5.3", thinking: "off" });
  assert.deepEqual(parseModelRef("  a/b:high  "), { ref: "a/b", thinking: "high" });
});

test("parseModelRef leaves non-thinking suffixes alone", () => {
  assert.deepEqual(parseModelRef("z-ai/glm-5.3:batch"), { ref: "z-ai/glm-5.3:batch" });
  assert.deepEqual(parseModelRef("a/b:MAX"), { ref: "a/b:MAX" });
  assert.deepEqual(parseModelRef("a/b"), { ref: "a/b" });
  assert.deepEqual(parseModelRef(":max"), { ref: ":max" });
});

test("findExactModelReferenceMatch resolves :thinking references", () => {
  const flash = MODELS[0]!;
  assert.equal(findExactModelReferenceMatch("deepseek/deepseek-v4.1-flash:max", MODELS), flash);
  assert.equal(
    findExactModelReferenceMatch("openrouter/deepseek/deepseek-v4.1-flash:max", MODELS),
    flash,
  );
  assert.equal(findExactModelReferenceMatch("z-ai/glm-5.3:batch:low", MODELS), MODELS[2]!);
});

test("findExactModelReferenceMatch keeps colon ids matching verbatim", () => {
  assert.equal(findExactModelReferenceMatch("z-ai/glm-5.3:batch", MODELS), MODELS[2]!);
  assert.equal(findExactModelReferenceMatch("z-ai/glm-5.3:unknown", MODELS), undefined);
});

test("resolveReviewModels resolves a :thinking primary override", () => {
  const registry = { getAll: () => MODELS } as unknown as Parameters<typeof resolveReviewModels>[1];
  const resolved = resolveReviewModels(undefined, registry, {
    llmModelOverride: "deepseek/deepseek-v4.1-flash:max",
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.id, "deepseek/deepseek-v4.1-flash");
});

test("buildChildPiPromptArgs strips the suffix into --thinking", () => {
  const args = buildChildPiPromptArgs(
    "review",
    { llmModelOverride: "deepseek/deepseek-v4.1-flash:max" },
    [],
    undefined,
  );
  assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4.1-flash");
  assert.equal(args[args.indexOf("--thinking") + 1], "max");
  assert.equal(args.includes("deepseek/deepseek-v4.1-flash:max"), false);
});

test("llmThinkingOverride wins over the :thinking suffix", () => {
  const args = buildChildPiPromptArgs(
    "review",
    { llmModelOverride: "deepseek/deepseek-v4.1-flash:max", llmThinkingOverride: "low" },
    [],
    undefined,
  );
  assert.equal(args[args.indexOf("--thinking") + 1], "low");
});

test("plain override without a suffix still defaults thinking to off", () => {
  const args = buildChildPiPromptArgs("review", { llmModelOverride: "z-ai/glm-5.3" }, [], undefined);
  assert.equal(args[args.indexOf("--thinking") + 1], "off");
});

test("hasChildLlmOverrides detects a suffix-only override", () => {
  assert.equal(hasChildLlmOverrides({ llmModelOverride: "deepseek/deepseek-v4.1-flash:max" }), true);
});
