import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * CLI reserved slash commands. Skill names that collide are still discoverable
 * and listed by /skills, but cannot steal these `/` command slots.
 */
export const RESERVED_SLASH_COMMANDS = new Set([
  "model",
  "models",
  "provider",
  "providers",
  "reasoning",
  "context",
  "settings",
  "language",
  "lang",
  "auth",
  "agents",
  "doctor",
  "setup",
  "status",
  "audit",
  "evidence",
  "sessions",
  "continue",
  "rollback",
  "authorize",
  "run",
  "init",
  "policy",
  "help",
  "retry",
  "exit",
  "skills",
]);

/**
 * Roots odai-cli exposes as a skill host.
 * - workspace (+ parents up to monorepo, stop before $HOME): skills/, .agents/skills/
 * - user: ~/.agents/skills/
 * - optional ODAI_SKILLS_PATH
 * - packaged odai snapshot (system fallback listing)
 *
 * Listing (/skills, `odai skills`) uses every install path.
 * Enable/resolve (/skill-name, --skill) uses first primary hit by name.
 */
export function skillDiscoveryRoots({
  workspaceRoot = process.cwd(),
  env = process.env,
  includeUserAgents = true,
  includePackagedOdai = true,
  maxParentDepth = 5,
} = {}) {
  const roots = [];
  const seen = new Set();
  const homeRaw = env.HOME || env.USERPROFILE || homedir() || "";
  const home = homeRaw ? path.resolve(homeRaw) : "";
  const add = (root, scope, kind) => {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push({ root: resolved, scope, kind });
  };

  // Workspace first so enable/resolve primary prefers project over user/package.
  // Walk monorepo parents so running inside cli/ still sees sibling skills/.
  // Stop before $HOME — home is not a monorepo root (avoids mislabeling ~/.agents).
  let current = path.resolve(workspaceRoot);
  for (let depth = 0; depth <= maxParentDepth; depth += 1) {
    if (home && current === home) break;
    const scope = depth === 0 ? "workspace" : "workspace-parent";
    add(path.join(current, "skills"), scope, "skills");
    add(path.join(current, ".agents", "skills"), scope, "agents");
    const parent = path.dirname(current);
    if (parent === current) break;
    if (home && parent === home) break;
    current = parent;
  }

  if (includeUserAgents && home) {
    add(path.join(home, ".agents", "skills"), "user", "agents");
  }

  const extra = String(env.ODAI_SKILLS_PATH || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const root of extra) {
    add(root, "config", "extra");
  }

  if (includePackagedOdai) {
    add(packageSkillsRoot(), "package", "skills");
  }

  return roots;
}

/**
 * Discover installed skills.
 * @param {object} options
 * @param {boolean} [options.uniqueByName=true] When true (resolve/enable), first hit wins.
 *   When false (listing), every discovered install path is returned.
 */
export function discoverSkillsSync({
  workspaceRoot = process.cwd(),
  env = process.env,
  includeUserAgents = true,
  includePackagedOdai = true,
  uniqueByName = true,
} = {}) {
  const all = [];
  const byName = new Map();

  for (const source of skillDiscoveryRoots({
    workspaceRoot,
    env,
    includeUserAgents,
    includePackagedOdai,
  })) {
    if (!existsSync(source.root) || !safeIsDirectory(source.root)) continue;
    let entries = [];
    try {
      entries = readdirSync(source.root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillRoot = path.join(source.root, entry.name);
      const skillFile = path.join(skillRoot, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      let entryText = "";
      try {
        entryText = readFileSync(skillFile, "utf8");
      } catch {
        continue;
      }
      const meta = parseSkillFrontmatter(entryText);
      const name = normalizeSkillName(meta.name || entry.name);
      if (!name) continue;
      const record = {
        name,
        description: meta.description || "",
        root: skillRoot,
        entry: skillFile,
        scope: source.scope,
        sourceKind: source.kind,
        sourceRoot: source.root,
        reservedClash: RESERVED_SLASH_COMMANDS.has(name),
        system: name === "odai",
        entrySha256: sha256(entryText),
        primary: false,
      };
      all.push(record);
      if (!byName.has(name)) {
        byName.set(name, record);
        record.primary = true;
      }
    }
  }

  // Ensure system odai always appears in listings even if discovery missed it.
  if (!byName.has("odai")) {
    const packaged = path.join(packageSkillsRoot(), "odai");
    if (existsSync(path.join(packaged, "SKILL.md"))) {
      const entryText = readFileSync(path.join(packaged, "SKILL.md"), "utf8");
      const record = {
        name: "odai",
        description: parseSkillFrontmatter(entryText).description || "odai system governance skill",
        root: packaged,
        entry: path.join(packaged, "SKILL.md"),
        scope: "package",
        sourceKind: "skills",
        sourceRoot: packageSkillsRoot(),
        reservedClash: false,
        system: true,
        entrySha256: sha256(entryText),
        primary: true,
      };
      all.push(record);
      byName.set("odai", record);
    }
  } else {
    for (const skill of all) {
      if (skill.name === "odai") skill.system = true;
    }
    byName.get("odai").primary = true;
  }

  if (uniqueByName) {
    return [...byName.values()].sort((a, b) => compareSkills(a, b));
  }
  // Full inventory for /skills: every install path, including name collisions.
  return all.sort((a, b) => compareSkills(a, b) || a.root.localeCompare(b.root));
}

export async function discoverSkills(options = {}) {
  return discoverSkillsSync(options);
}

/**
 * Full listing for /skills and `odai skills` — every discovered install, not deduped.
 */
export function listAllSkills(options = {}) {
  return discoverSkillsSync({ ...options, uniqueByName: false });
}

export function findSkillByName(name, options = {}) {
  const normalized = normalizeSkillName(name);
  if (!normalized) return undefined;
  // Prefer primary (workspace-first) for enable/load.
  return discoverSkillsSync({ ...options, uniqueByName: true }).find((skill) => skill.name === normalized);
}

/**
 * Load a skill pack for prompt injection (craft layer). odai is system.
 */
export async function loadExternalSkillPack(name, {
  workspaceRoot = process.cwd(),
  env = process.env,
} = {}) {
  const skill = findSkillByName(name, { workspaceRoot, env });
  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }
  const entryText = await readFile(skill.entry, "utf8");
  return {
    ...skill,
    entryText,
    entrySha256: sha256(entryText),
  };
}

export function parseSkillFrontmatter(text = "") {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function normalizeSkillName(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function matchSkillsInTask(task = "", skills = []) {
  const text = String(task || "");
  if (!text.trim()) return [];
  const hits = [];
  const seen = new Set();
  for (const skill of skills) {
    if (!skill?.name || skill.name === "odai" || seen.has(skill.name)) continue;
    const pattern = new RegExp(`(?:^|\\s|/)(${escapeRegExp(skill.name)})(?:\\s|$|[\\/:,])`, "i");
    if (pattern.test(text) || text.includes(`/${skill.name}`)) {
      seen.add(skill.name);
      hits.push(skill.name);
    }
  }
  return hits;
}

export function formatSkillsReport({
  skills = [],
  active = [],
  workspaceRoot = process.cwd(),
} = {}) {
  const activeSet = new Set(active);
  const uniqueNames = new Set(skills.map((skill) => skill.name).filter(Boolean));
  const lines = [
    `skills discovered: ${skills.length} install(s), ${uniqueNames.size} unique name(s)`,
    `workspace: ${workspaceRoot}`,
    `session active: ${activeSet.size > 0 ? [...activeSet].join(", ") : "(odai only)"}`,
    "",
  ];
  if (skills.length === 0) {
    lines.push("(no skills found under skills/, .agents/skills/, monorepo parents, or ~/.agents/skills/)");
  }
  for (const skill of skills) {
    const flags = [
      skill.system ? "system" : skill.scope,
      skill.sourceKind,
      skill.primary ? "primary" : "shadow",
      skill.name === "odai" || activeSet.has(skill.name) ? "on" : "off",
      skill.reservedClash ? "reserved-name" : "",
    ].filter(Boolean);
    lines.push(`- /${skill.name}  [${flags.join(", ")}]`);
    if (skill.description) {
      lines.push(`    ${skill.description}`);
    }
    lines.push(`    ${skill.root}`);
  }
  lines.push("");
  lines.push("This list is the full inventory (every install path). Duplicate names show as primary + shadow.");
  lines.push("Use /skill-name to enable for this session; /skill-name off to disable.");
  lines.push("odai is always the system governance skill.");
  return lines.join("\n");
}

function compareSkills(a, b) {
  if (a.system !== b.system) return a.system ? -1 : 1;
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return 0;
}

function safeIsDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function packageSkillsRoot() {
  const bundled = path.join(packageRoot(), "skills");
  const development = path.join(packageRoot(), "..", "skills");
  if (
    path.basename(packageRoot()) === "cli" &&
    existsSync(path.join(packageRoot(), "..", ".git")) &&
    existsSync(path.join(development, "odai", "SKILL.md"))
  ) {
    return development;
  }
  return bundled;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
