import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/config.js";
import { ENTRY_DELIMITER } from "../src/constants.js";
import { normalizeMemoryLookupText } from "../src/store/memory-lookup.js";
import { MemoryStore } from "../src/store/memory-store.js";

test("memory entries preserve delimiter and metadata format", () => {
  const store = new MemoryStore(loadConfig(path.join(os.tmpdir(), "jev-memory-missing-config.json")));
  const rawStore = store as unknown as {
    encodeEntry: (text: string, created: string, lastReferenced: string, project?: string) => string;
    decodeEntry: (raw: string) => { text: string; created: string; lastReferenced: string; project: string | null };
  };
  const encoded = rawStore.encodeEntry("A durable fact", "2026-01-01", "2026-01-02");
  const decoded = rawStore.decodeEntry(encoded);

  assert.match(encoded, /<!-- created=2026-01-01, last=2026-01-02 -->/);
  const entries = [encoded, "Another fact"].join(ENTRY_DELIMITER).split(ENTRY_DELIMITER);
  assert.equal(entries.length, 2);
  assert.equal(rawStore.decodeEntry(entries[1]).text, "Another fact");
  assert.deepEqual(decoded, {
    text: "A durable fact",
    created: "2026-01-01",
    lastReferenced: "2026-01-02",
    project: null,
  });
});

test("memory lookup text is normalized", () => {
  assert.equal(normalizeMemoryLookupText("  USE  TypeScript\nEverywhere "), "USE  TypeScript");
});

test("config defaults load from an isolated path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jev-memory-smoke-"));
  try {
    const config = loadConfig(path.join(tempDir, "config.json"));
    assert.equal(config.memoryDir, undefined);
    assert.equal(config.memoryMode, "policy-only");
    assert.equal(config.sessionSearch?.variant, "legacy");
    assert.match(DEFAULT_CONFIG_PATH, /jev-memory-config\.json$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
