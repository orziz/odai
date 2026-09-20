// Pure, trusted contract compiler. Callers supply captured data; this module
// never imports or executes code from a selected (possibly external) bundle.
export const RUNTIME_CONTRACT = 7;
export const MANIFEST_SCHEMA = 3;
export const ROLE_NAMES = Object.freeze(["controller", "researcher", "planner", "reviewer", "frontend"]);
export const REFERENCE_NAMES = Object.freeze(["dao", "planning", "craft", "verification", "support", "leverage", "care", "human-safety"]);
export const MODULE_NAMES = Object.freeze(["core", "entry", "delegation"]);
export const MODULE_FILE_NAMES = Object.freeze(["entry", "delegation"]);
const CORE_HEADINGS = Object.freeze(["精神内核", "当前判断", "共同行动边界"]);
const REQUIRED_REFERENCES = Object.freeze({ controller: [], researcher: [], planner: ["planning"], reviewer: ["verification"], frontend: ["craft"] });

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function exactKeys(value, names, label) {
  object(value, label);
  if (Object.keys(value).sort().join("\0") !== [...names].sort().join("\0")) throw new TypeError(`${label} has invalid owners or fields`);
}
function safePath(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && !value.includes("\\") && !/^(?:\/|[A-Za-z]:)/u.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}
function names(value, allowed, label) {
  if (!Array.isArray(value) || value.some((name) => !allowed.includes(name)) || new Set(value).size !== value.length) {
    throw new TypeError(`${label} must contain unique known names`);
  }
  return Object.freeze([...value]);
}
export function validateCompositionManifest(manifest) {
  object(manifest, "manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.runtimeContract !== RUNTIME_CONTRACT) throw new TypeError("unsupported Odai composition contract");
  if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.some((file) => !safePath(file))
    || new Set(manifest.requiredFiles).size !== manifest.requiredFiles.length) throw new TypeError("invalid requiredFiles");
  const topology = {};
  const paths = new Set();
  for (const [field, owners] of [["moduleFiles", MODULE_FILE_NAMES], ["roleFiles", ROLE_NAMES], ["referenceFiles", REFERENCE_NAMES]]) {
    exactKeys(manifest[field], owners, field);
    topology[field] = Object.freeze(Object.fromEntries(owners.map((owner) => {
      const file = manifest[field][owner];
      if (!safePath(file) || !manifest.requiredFiles.includes(file)) throw new TypeError(`${field}.${owner} is unsafe or undeclared`);
      if (paths.has(file)) throw new TypeError("contract owners must use distinct paths");
      paths.add(file);
      return [owner, file];
    })));
  }
  if (topology.moduleFiles.entry !== "SKILL.md") throw new TypeError("entry owner must be SKILL.md");
  exactKeys(manifest.rolePresets, ROLE_NAMES, "rolePresets");
  topology.rolePresets = Object.freeze(Object.fromEntries(ROLE_NAMES.map((role) => {
    const preset = manifest.rolePresets[role];
    exactKeys(preset, ["modules", "references"], `rolePresets.${role}`);
    const modules = names(preset.modules, MODULE_NAMES, `${role} modules`);
    const required = role === "controller" ? ["core", "entry"] : ["core", "delegation"];
    if (modules.join("\0") !== required.join("\0")) throw new TypeError(`${role} must include its core and ${required[1]} modules in order`);
    const references = names(preset.references, REFERENCE_NAMES, `${role} references`);
    if (REQUIRED_REFERENCES[role].some((name) => !references.includes(name))) throw new TypeError(`${role} is missing a required reference owner`);
    return [role, Object.freeze({ modules, references })];
  })));
  return Object.freeze(topology);
}
export function stripEntryMetadata(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
}
function body(contents, path, entry = false) {
  const text = contents[path];
  if (typeof text !== "string" || !text.trim()) throw new TypeError(`contract body is unavailable: ${path}`);
  const result = entry ? stripEntryMetadata(text) : text.trim();
  if (!result) throw new TypeError(`contract body is empty: ${path}`);
  return result;
}
// SKILL.md stays a complete, directly usable entry. Only this compiler knows
// how to project its shared sections into delegated contexts; there is no
// separately maintained copy of the spiritual core or judgment principles.
function entryParts(text) {
  const headings = [...text.matchAll(/^## ([^\r\n]+)\r?$/gmu)];
  const sections = headings.map((match, index) => ({
    name: match[1].trim(),
    text: text.slice(match.index, headings[index + 1]?.index ?? text.length).trim(),
    body: text.slice(match.index + match[0].length, headings[index + 1]?.index ?? text.length).trim(),
  }));
  for (const heading of CORE_HEADINGS) {
    const matches = sections.filter(section => section.name === heading);
    if (matches.length !== 1) throw new TypeError(`core section must appear exactly once: ${heading}`);
    if (!matches[0].body) throw new TypeError(`core section is empty: ${heading}`);
  }
  const core = sections.filter(section => CORE_HEADINGS.includes(section.name)).map(section => section.text).join("\n\n");
  const entry = [text.slice(0, headings[0]?.index ?? text.length).trim(),
    ...sections.filter(section => !CORE_HEADINGS.includes(section.name)).map(section => section.text)].filter(Boolean).join("\n\n");
  return { core, entry };
}
export function composeEntry(manifest, contents) {
  const topology = validateCompositionManifest(manifest);
  return body(contents, topology.moduleFiles.entry, true);
}
export function composeCore(manifest, contents) {
  return entryParts(composeEntry(manifest, contents)).core;
}
export function composeRoleContract(role, manifest, contents, { embedded = false } = {}) {
  const topology = validateCompositionManifest(manifest);
  if (!ROLE_NAMES.includes(role)) throw new TypeError(`unknown responsibility: ${role}`);
  const preset = topology.rolePresets[role];
  const parts = entryParts(body(contents, topology.moduleFiles.entry, true));
  // Embedded hosts already provide the same snapshot's core/entry. Delegation
  // remains in every specialist contract; permissions are always host-owned.
  const modules = preset.modules.filter((name) => !embedded || (name !== "core" && name !== "entry"));
  return [
    ...(role === "controller" && !embedded
      ? [body(contents, topology.moduleFiles.entry, true)]
      : modules.map(name => name === "delegation" ? body(contents, topology.moduleFiles.delegation) : parts[name])),
    body(contents, topology.roleFiles[role]),
    ...preset.references.map((name) => `## Canonical ${name} reference\n\n${body(contents, topology.referenceFiles[name])}`),
  ].join("\n\n");
}
