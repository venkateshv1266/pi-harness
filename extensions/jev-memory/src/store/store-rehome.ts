import * as fs from "node:fs/promises";
import * as path from "node:path";

export const STORE_FILES = ["MEMORY.md", "USER.md", "failures.md", "STANDING.md", "sessions.db"] as const;

export interface StoreRehomeOptions {
  agentRoot: string;
  targetDir: string;
  rename?: (source: string, target: string) => Promise<void>;
  notify?: (message: string) => void;
}

export interface StoreRehomeResult {
  migrated: boolean;
  targetDir: string;
  archivedLegacyDir?: string;
}

async function entryExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hasStoreFiles(storeDir: string): Promise<boolean> {
  for (const file of STORE_FILES) {
    if (await entryExists(path.join(storeDir, file))) return true;
  }
  return false;
}

async function copyEntries(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  entries.sort((a, b) => {
    const aDatabase = a.name === "sessions.db";
    const bDatabase = b.name === "sessions.db";
    return Number(aDatabase) - Number(bDatabase) || a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyEntries(source, target);
    } else if (!await entryExists(target)) {
      await fs.copyFile(source, target);
    }
  }
}

async function archiveLegacyDir(
  legacyDir: string,
  rename: (source: string, target: string) => Promise<void>,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = `${Date.now()}${attempt ? `-${attempt}` : ""}`;
    const archive = `${legacyDir}.migrated-${suffix}`;
    if (await entryExists(archive)) continue;
    try {
      await rename(legacyDir, archive);
      return archive;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return undefined;
    }
  }
  return undefined;
}

function notifyMigration(targetDir: string, notify?: (message: string) => void): void {
  const message = `memory store migrated to ${targetDir}`;
  try {
    notify?.(message);
    if (!notify) console.info(message);
  } catch {
    try {
      console.info(message);
    } catch (fallbackError) {
      void fallbackError;
    }
  }
}

export async function rehomeLegacyStore(options: StoreRehomeOptions): Promise<StoreRehomeResult> {
  const rename = options.rename ?? ((source, target) => fs.rename(source, target));
  const legacyDir = path.join(options.agentRoot, "pi-hermes-memory");
  const result: StoreRehomeResult = { migrated: false, targetDir: options.targetDir };

  if (await hasStoreFiles(options.targetDir)) return result;
  if (!await hasStoreFiles(legacyDir)) return result;

  try {
    await rename(legacyDir, options.targetDir);
  } catch {
    await copyEntries(legacyDir, options.targetDir);
    result.archivedLegacyDir = await archiveLegacyDir(legacyDir, rename);
  }

  result.migrated = true;
  notifyMigration(options.targetDir, options.notify);
  return result;
}
