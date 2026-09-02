/**
 * Claude Compatibility Extension
 *
 * Makes pi discover Claude Code resources that pi does NOT pick up by
 * default. Claude Code stores project memory and skills inside a `.claude/`
 * folder; pi only reads bare CLAUDE.md/AGENTS.md and .pi/skills|.agents/skills.
 *
 * On every session start / reload, walks cwd -> filesystem root and, for
 * each `<dir>/.claude` found (this includes `~/.claude` when cwd is under
 * the user's home):
 *
 *   1. Registers individual `<dir>/.claude/skills/<name>` dirs as skill
 *      paths (via resources_discover), skipping any skill whose name is
 *      already provided by pi's own default global skill directories
 *      (~/.pi/agent/skills, ~/.agents/skills). This avoids name-collision
 *      warnings: when both a pi-native and a Claude version exist with the
 *      same name, the pi-native one wins silently.
 *   2. Loads `<dir>/.claude/CLAUDE.md` as additional system-prompt context
 *      (via before_agent_start) so that Claude memory file applies.
 *
 * This single extension replaces the earlier global wiring (the
 * ~/.pi/agent/AGENTS.md -> ~/.claude/CLAUDE.md symlink and the settings.json
 * `skills` array entry for ~/.claude/skills). One mechanism, mirrors Claude
 * Code's "walk cwd -> root and accumulate .claude/" behaviour.
 *
 * Caveat: `~/.claude` is only reached when the home directory is an
 * ancestor of cwd, i.e. when pi is started somewhere under the user's home
 * directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Cached per-session state (refreshed on session_start / resources_discover).
let claudeContextBlobs: { path: string; content: string }[] = [];
let claudeSkillPaths: string[] = [];

/** Resolve and canonicalize, tolerating missing paths. */
function tryReal(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Walk from `cwd` up to the filesystem root, yielding directory paths in
 * order from innermost (cwd) to outermost (root).
 */
function walkUp(cwd: string): string[] {
  const dirs: string[] = [];
  const root = path.parse(cwd).root; // "/" on POSIX, "C:\\" on Windows
  let cur = path.resolve(cwd);
  while (true) {
    dirs.push(cur);
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break; // safety
    cur = parent;
  }
  return dirs;
}

/** Directories pi scans by default for global skills. */
const PI_DEFAULT_GLOBAL_SKILL_DIRS = [
  path.join(os.homedir(), ".pi", "agent", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
];

/**
 * Collect the set of skill names already discoverable in pi's own default
 * global skill directories. Skills in `.claude/skills` with these names are
 * skipped to avoid name-collision warnings (pi-native wins).
 *
 * Per the Agent Skills standard as implemented by pi: a skill is a directory
 * containing SKILL.md, or (only in ~/.pi/agent/skills and .pi/skills) a root
 * .md file discovered as an individual skill. We account for both.
 */
function getGlobalSkillNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of PI_DEFAULT_GLOBAL_SKILL_DIRS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) {
          names.add(entry.name);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Root .md files in these dirs are discovered as individual skills.
        // Use the filename without extension as the skill name.
        names.add(entry.name.slice(0, -3));
      }
    }
  }
  return names;
}

/**
 * Enumerate the individual skill subdirectories (each containing SKILL.md)
 * inside a `.claude/skills` directory. Returns absolute paths.
 */
function listSkillSubdirs(skillsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const subs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
      subs.push(path.join(skillsDir, entry.name));
    }
  }
  return subs;
}

/**
 * Discover `.claude/` resources for the given cwd by walking cwd -> root.
 * Covers both the user-level `~/.claude` (when cwd is under home) and any
 * project-local `<repo>/.claude` directories along the way.
 *
 * Returns individual skill directory paths (not parent skill folders) so we
 * can skip names that collide with pi's default global skills.
 */
function discoverClaudeResources(cwd: string): {
  contextFiles: { path: string; content: string }[];
  skillPaths: string[];
} {
  const contextFiles: { path: string; content: string }[] = [];
  const skillPaths: string[] = [];
  const seenContext = new Set<string>();
  const seenSkills = new Set<string>();
  const globalNames = getGlobalSkillNames();
  let skippedCollisions = 0;

  for (const dir of walkUp(cwd)) {
    const claudeDir = path.join(dir, ".claude");
    const realClaudeDir = tryReal(claudeDir);
    if (!realClaudeDir) continue;

    // 1. CLAUDE.md inside .claude/
    const ctxFile = path.join(claudeDir, "CLAUDE.md");
    const realCtx = tryReal(ctxFile);
    if (realCtx && !seenContext.has(realCtx)) {
      try {
        const content = fs.readFileSync(ctxFile, "utf8").trim();
        if (content) {
          seenContext.add(realCtx);
          contextFiles.push({ path: ctxFile, content });
        }
      } catch {
        // ignore unreadable file
      }
    }

    // 2. skills inside .claude/skills/ -> individual skill dirs
    const skillsDir = path.join(claudeDir, "skills");
    const realSkillsDir = tryReal(skillsDir);
    if (!realSkillsDir) continue;

    for (const sub of listSkillSubdirs(realSkillsDir)) {
      const name = path.basename(sub);
      if (globalNames.has(name)) {
        // pi-native version already loaded from a default global dir; skip
        // to avoid a name-collision warning.
        skippedCollisions++;
        continue;
      }
      const realSub = tryReal(sub);
      if (realSub && !seenSkills.has(realSub)) {
        seenSkills.add(realSub);
        skillPaths.push(realSub);
      }
    }
  }

  if (skippedCollisions > 0) {
    claudeSkippedCollisions = skippedCollisions;
  } else {
    claudeSkippedCollisions = 0;
  }
  return { contextFiles, skillPaths };
}

// Exposed for the session_start notify message.
let claudeSkippedCollisions = 0;

export default function claudeCompatExtension(pi: ExtensionAPI) {
  // Refresh cache whenever a session starts / resumes / reloads.
  pi.on("session_start", async (_event, ctx) => {
    const { contextFiles, skillPaths } = discoverClaudeResources(ctx.cwd);
    claudeContextBlobs = contextFiles;
    claudeSkillPaths = skillPaths;

    if (contextFiles.length > 0 || skillPaths.length > 0 || claudeSkippedCollisions > 0) {
      const parts: string[] = [];
      if (contextFiles.length) parts.push(`${contextFiles.length} .claude/CLAUDE.md`);
      if (skillPaths.length) parts.push(`${skillPaths.length} .claude skills`);
      if (claudeSkippedCollisions > 0) parts.push(`${claudeSkippedCollisions} collision(s) skipped`);
      ctx.ui.notify(`Claude-compat: ${parts.join(", ")}`, "info");
    }
  });

  // Contribute individual .claude/skills/<name> dirs as skill paths.
  pi.on("resources_discover", async (event) => {
    // Recompute in case cwd changed (e.g. new session); keep cache in sync.
    const { contextFiles, skillPaths } = discoverClaudeResources(event.cwd);
    claudeContextBlobs = contextFiles;
    claudeSkillPaths = skillPaths;

    return { skillPaths };
  });

  // Inject project .claude/CLAUDE.md contents into the system prompt.
  pi.on("before_agent_start", async (event) => {
    if (claudeContextBlobs.length === 0) return;

    const blocks = claudeContextBlobs
      .map(
        (f) =>
          `### ${f.path}\n\n<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`
      )
      .join("\n\n");

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Project-local Claude context (.claude/CLAUDE.md)\n\n` +
        `The following project-local memory files were discovered inside \`<dir>/.claude/CLAUDE.md\` ` +
        `while walking from the current directory up to the filesystem root. Treat them with the same ` +
        `weight as AGENTS.md/CLAUDE.md context files.\n\n` +
        blocks +
        `\n`,
    };
  });
}
