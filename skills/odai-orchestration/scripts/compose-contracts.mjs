// Trusted, data-only orchestration compiler. Governance loads independently.
export const RUNTIME_CONTRACT = 8;
export const MANIFEST_SCHEMA = 1;
export const ORCHESTRATION_URL = new URL("../", import.meta.url);
export const ROLE_NAMES = Object.freeze(["controller", "researcher", "planner", "reviewer", "frontend"]);
export const REFERENCE_NAMES = Object.freeze(["dao", "planning", "craft", "verification", "support", "leverage", "care", "human-safety", "orchestration"]);
const REQUIRED_REFERENCES = { controller: ["orchestration"], researcher: [], planner: ["planning"], reviewer: ["verification"], frontend: ["craft"] };
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function exactKeys(value, keys, label) {
  object(value, label);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError(`${label} has invalid fields`);
}
function safePath(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && !value.includes("\\") && !/^(?:\/|[A-Za-z]:)/u.test(value)
    && value.split("/").every(part => part && part !== "." && part !== "..");
}
export function validateCompositionManifest(manifest) {
  exactKeys(manifest, ["schemaVersion", "name", "version", "governanceContract", "delegationFile", "roleFiles", "rolePresets", "referenceFiles", "requiredFiles"], "orchestration manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.name !== "odai-orchestration" || manifest.governanceContract !== RUNTIME_CONTRACT) throw new TypeError("unsupported orchestration contract");
  if (typeof manifest.version !== "string" || !manifest.version) throw new TypeError("orchestration version is required");
  if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.some(file => !safePath(file))
    || new Set(manifest.requiredFiles).size !== manifest.requiredFiles.length) throw new TypeError("invalid orchestration requiredFiles");
  exactKeys(manifest.roleFiles, ROLE_NAMES, "roleFiles");
  exactKeys(manifest.rolePresets, ROLE_NAMES, "rolePresets");
  exactKeys(manifest.referenceFiles, ["orchestration"], "referenceFiles");
  const owned = [manifest.delegationFile, ...Object.values(manifest.roleFiles), ...Object.values(manifest.referenceFiles)];
  if (new Set(owned).size !== owned.length || owned.some(file => !safePath(file) || !manifest.requiredFiles.includes(file))) throw new TypeError("orchestration owners must use distinct declared files");
  const presets = {};
  for (const role of ROLE_NAMES) {
    const preset = manifest.rolePresets[role];
    exactKeys(preset, ["references"], `rolePresets.${role}`);
    if (!Array.isArray(preset.references) || new Set(preset.references).size !== preset.references.length
      || preset.references.some(name => !REFERENCE_NAMES.includes(name))
      || REQUIRED_REFERENCES[role].some(name => !preset.references.includes(name))) throw new TypeError(`${role} has invalid reference dependencies`);
    presets[role] = Object.freeze({ references: Object.freeze([...preset.references]) });
  }
  return Object.freeze({ ...manifest, roleFiles: Object.freeze({ ...manifest.roleFiles }),
    rolePresets: Object.freeze(presets), referenceFiles: Object.freeze({ ...manifest.referenceFiles }), requiredFiles: Object.freeze([...manifest.requiredFiles]) });
}
export function stripEntryMetadata(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
}
function body(contents, file) {
  const text = contents[file];
  if (typeof text !== "string" || !text.trim()) throw new TypeError(`contract body is unavailable: ${file}`);
  return text.trim();
}
export function composeRoleContract(role, governance, manifest, contents, { embedded = false } = {}) {
  const extension = validateCompositionManifest(manifest);
  if (!ROLE_NAMES.includes(role)) throw new TypeError(`unknown responsibility: ${role}`);
  if (governance.runtimeContract !== extension.governanceContract || !governance.skillBody?.trim()) throw new TypeError("incompatible or empty governance input");
  return [
    ...(!embedded ? [governance.skillBody.trim()] : []),
    ...(role === "controller" ? [stripEntryMetadata(body(contents, "SKILL.md"))] : [body(contents, extension.delegationFile)]),
    body(contents, extension.roleFiles[role]),
    ...extension.rolePresets[role].references.map(name => {
      const text = name === "orchestration" ? body(contents, extension.referenceFiles.orchestration) : governance.referenceContracts[name];
      if (typeof text !== "string" || !text.trim()) throw new TypeError(`reference ${name} is unavailable`);
      return `## ${name} reference\n\n${text.trim()}`;
    }),
  ].join("\n\n");
}
