import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rehomeLegacyStore } from "../src/store/store-rehome.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jev-memory-rehome-"));
}

test("renames a legacy store with its memory and database intact", async () => {
  const agentRoot = await tempRoot();
  const legacy = join(agentRoot, "pi-hermes-memory");
  const target = join(agentRoot, "jev-memory");
  await mkdir(legacy);
  await writeFile(join(legacy, "MEMORY.md"), "memory");
  await writeFile(join(legacy, "sessions.db"), "database");

  const result = await rehomeLegacyStore({ agentRoot, targetDir: target });

  assert.equal(result.migrated, true);
  assert.equal(await readFile(join(target, "MEMORY.md"), "utf8"), "memory");
  assert.equal(await readFile(join(target, "sessions.db"), "utf8"), "database");
  await assert.rejects(() => readdir(legacy));

  const second = await rehomeLegacyStore({ agentRoot, targetDir: target });
  assert.equal(second.migrated, false);
  assert.equal(await readFile(join(target, "MEMORY.md"), "utf8"), "memory");
  assert.equal(await readFile(join(target, "sessions.db"), "utf8"), "database");
  await rm(agentRoot, { recursive: true, force: true });
});

test("is idempotent and does not migrate when the target already has store files", async () => {
  const agentRoot = await tempRoot();
  const legacy = join(agentRoot, "pi-hermes-memory");
  const target = join(agentRoot, "jev-memory");
  await mkdir(legacy);
  await mkdir(target);
  await writeFile(join(legacy, "MEMORY.md"), "legacy");
  await writeFile(join(target, "MEMORY.md"), "target");

  const first = await rehomeLegacyStore({ agentRoot, targetDir: target });
  const second = await rehomeLegacyStore({ agentRoot, targetDir: target });

  assert.equal(first.migrated, false);
  assert.equal(second.migrated, false);
  assert.equal(await readFile(join(target, "MEMORY.md"), "utf8"), "target");
  assert.equal(await readFile(join(legacy, "MEMORY.md"), "utf8"), "legacy");
  await rm(agentRoot, { recursive: true, force: true });
});

test("copies then archives the legacy store when rename fails", async () => {
  const agentRoot = await tempRoot();
  const legacy = join(agentRoot, "pi-hermes-memory");
  const target = join(agentRoot, "jev-memory");
  await mkdir(legacy);
  await writeFile(join(legacy, "MEMORY.md"), "memory");
  await writeFile(join(legacy, "sessions.db"), "database");
  let failed = false;
  const rename = async (source: string, destination: string): Promise<void> => {
    if (!failed) {
      failed = true;
      const error = new Error("cross-device") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    }
    const { rename: fsRename } = await import("node:fs/promises");
    await fsRename(source, destination);
  };

  const result = await rehomeLegacyStore({ agentRoot, targetDir: target, rename });

  assert.equal(result.migrated, true);
  assert.match(result.archivedLegacyDir ?? "", /pi-hermes-memory\.migrated-\d+/);
  assert.equal(await readFile(join(target, "MEMORY.md"), "utf8"), "memory");
  assert.equal(await readFile(join(target, "sessions.db"), "utf8"), "database");
  assert.equal(await readFile(join(result.archivedLegacyDir ?? "", "MEMORY.md"), "utf8"), "memory");
  await rm(agentRoot, { recursive: true, force: true });
});
