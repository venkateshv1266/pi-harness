import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

const THINKING_SUFFIX_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Splits "provider/model:thinking" → ref + thinking level, mirroring pi's
 * model-role reference convention (settings roles like "openrouter/z-ai/glm-5.3:max").
 * The suffix counts only when it names a thinking level, so model ids that
 * contain a colon (e.g. "z-ai/glm-5.3:batch") keep matching verbatim. */
export function parseModelRef(rawRef: string): { ref: string; thinking?: ModelThinkingLevel } {
  const trimmed = rawRef.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const suffix = trimmed.slice(colon + 1);
    if (THINKING_SUFFIX_LEVELS.includes(suffix)) {
      const ref = trimmed.slice(0, colon).trim();
      if (ref) return { ref, thinking: suffix as ModelThinkingLevel };
    }
  }
  return { ref: trimmed };
}
