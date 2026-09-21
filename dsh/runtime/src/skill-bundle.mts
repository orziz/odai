import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeRoleContract, validateCompositionManifest, stripEntryMetadata, ROLE_NAMES, REFERENCE_NAMES, ORCHESTRATION_URL } from "#odai-contracts";
import type { OrchestrationManifest } from "#odai-contracts";
import { GOVERNANCE_CONTRACT, loadGovernanceBundle, captureBundleFiles, bundleFile, parseSkillVersion, compareSkillVersions } from "./governance-bundle.mjs";
import type { GovernanceBundle, GovernanceManifest } from "./governance-bundle.mjs";
export { loadGovernanceBundle, readSkillManifest, parseSkillVersion, compareSkillVersions } from "./governance-bundle.mjs";
export type { ParsedSkillVersion } from "./governance-bundle.mjs";

export const ODAI_RUNTIME_CONTRACT = GOVERNANCE_CONTRACT;
export const SKILL_MANIFEST_FILE = "manifest.json";
export const SKILL_SOURCE_MODES = Object.freeze(["bundled", "auto", "user"] as const);
export type SkillSourceMode = (typeof SKILL_SOURCE_MODES)[number];
export const ODAI_ROLE_NAMES = ROLE_NAMES;
export const ODAI_REFERENCE_NAMES = REFERENCE_NAMES;
export type OdaiRoleName = (typeof ODAI_ROLE_NAMES)[number];
export type OdaiReferenceName = (typeof ODAI_REFERENCE_NAMES)[number];
export type SkillManifest = GovernanceManifest;
export interface OrchestrationBundle {
  readonly root: string;
  readonly manifest: OrchestrationManifest;
  readonly skillBody: string;
  readonly digest: string;
  readonly fileContents: Readonly<Record<string, string>>;
}
// DSH owns this composition. Neither source manifest contains the other's files.
export interface SkillBundle extends Omit<GovernanceBundle, "digest" | "fileContents" | "referenceContracts"> {
  readonly governance: GovernanceBundle;
  readonly orchestration: OrchestrationBundle;
  readonly coreContract: string;
  readonly delegationContract: string;
  readonly roleContracts: Readonly<Record<string, string>>;
  readonly referenceContracts: Readonly<Record<string, string>>;
  readonly referencePaths: Readonly<Record<OdaiReferenceName, string>>;
  readonly requiredFiles: readonly string[];
  readonly digest: string;
  readonly fileContents: Readonly<Record<string, string>>;
}
export interface LoadSkillBundleOptions {
  source?: string;
  provider?: string;
  // Explicit trusted caller input, used for captured evolution snapshots only.
  // External governance discovery never selects a neighboring orchestration.
  orchestrationRoot?: string;
}
export interface SkillBundleSelection {
  readonly mode: SkillSourceMode;
  readonly status: "selected" | "fallback";
  readonly reasonCode: string;
  readonly detail?: string;
  readonly bundle: SkillBundle;
  readonly candidate?: SkillBundle;
}
export interface ChooseSkillBundleOptions { mode?: unknown; bundled?: SkillBundle; candidate?: SkillBundle; candidateError?: unknown }
const PROJECT_SOURCES = new Set(["project-dsh", "project-agents", "custom"]);
const USER_SOURCES = new Set(["user-dsh", "user-agents"]);

export function loadOrchestrationBundle(root = fileURLToPath(ORCHESTRATION_URL)): Readonly<OrchestrationBundle> {
  root = resolve(root);
  const raw: unknown = JSON.parse(readFileSync(bundleFile(root, "manifest.json"), "utf8"));
  const manifest = validateCompositionManifest(raw);
  parseSkillVersion(manifest.version, "orchestration version");
  const captured = captureBundleFiles(root, manifest.requiredFiles, manifest);
  const skillBody = stripEntryMetadata(Buffer.from(captured.fileContents["SKILL.md"] ?? "", "base64").toString("utf8"));
  if (!skillBody) throw new TypeError("orchestration entry is empty");
  return Object.freeze({ root, manifest, skillBody, ...captured });
}
export function loadSkillBundle(skillPath: string, options: LoadSkillBundleOptions = {}): Readonly<SkillBundle> {
  const governance = loadGovernanceBundle(skillPath, options);
  const orchestration = loadOrchestrationBundle(options.orchestrationRoot);
  const contents = Object.freeze(Object.fromEntries(Object.entries(orchestration.fileContents).map(([file, bytes]) => [file, Buffer.from(bytes, "base64").toString("utf8")])));
  const input = { runtimeContract: governance.manifest.runtimeContract, skillBody: governance.skillBody, referenceContracts: governance.referenceContracts };
  const roleContracts = Object.freeze(Object.fromEntries(ODAI_ROLE_NAMES.map(role => [role, composeRoleContract(role, input, orchestration.manifest, contents, { embedded: true })])));
  const delegationContract = contents[orchestration.manifest.delegationFile]?.trim();
  const orchestrationReference = contents[orchestration.manifest.referenceFiles.orchestration]?.trim();
  if (!delegationContract || !orchestrationReference) throw new Error("orchestration contract is empty");
  const referenceContracts = Object.freeze({ ...governance.referenceContracts, orchestration: orchestrationReference });
  const referencePaths = Object.freeze({ ...governance.manifest.referenceFiles, orchestration: `orchestration/${orchestration.manifest.referenceFiles.orchestration}` });
  const fileContents = Object.freeze({ ...governance.fileContents,
    ...Object.fromEntries(Object.entries(orchestration.fileContents).map(([file, bytes]) => [`orchestration/${file}`, bytes])) });
  const requiredFiles = Object.freeze([...governance.manifest.requiredFiles, ...orchestration.manifest.requiredFiles.map(file => `orchestration/${file}`)]);
  const digest = createHash("sha256").update(JSON.stringify({ contract: "odai-dsh-composition/1", governance: governance.digest, orchestration: orchestration.digest })).digest("hex");
  const bundle: SkillBundle = { ...governance, governance, orchestration, coreContract: governance.skillBody,
    delegationContract, roleContracts, referenceContracts, referencePaths, requiredFiles, digest, fileContents };
  Object.defineProperty(bundle, "fileContents", { value: fileContents, enumerable: false });
  return Object.freeze(bundle);
}
export function readSkillBundleFile(bundle: SkillBundle, relativePath: string): Buffer {
  if (!bundle?.requiredFiles?.includes(relativePath)) throw new TypeError(`unknown Odai composition file: ${String(relativePath)}`);
  const encoded = bundle.fileContents[relativePath];
  if (typeof encoded !== "string") throw new Error(`Odai composition snapshot is missing ${relativePath}`);
  return Buffer.from(encoded, "base64");
}
function fallbackSelection(mode: SkillSourceMode, bundled: SkillBundle, reasonCode: string, detail?: string, candidate?: SkillBundle): Readonly<SkillBundleSelection> {
  return Object.freeze({ mode, status: "fallback", reasonCode, ...(detail === undefined ? {} : { detail }), bundle: bundled, ...(candidate ? { candidate } : {}) });
}
function selected(mode: SkillSourceMode, bundle: SkillBundle, reasonCode: string, candidate?: SkillBundle): Readonly<SkillBundleSelection> {
  return Object.freeze({ mode, status: "selected", reasonCode, bundle, ...(candidate ? { candidate } : {}) });
}
export function chooseSkillBundle(options: ChooseSkillBundleOptions = {}): Readonly<SkillBundleSelection> {
  const { mode, bundled, candidate, candidateError } = options;
  if (typeof mode !== "string" || !(SKILL_SOURCE_MODES as readonly string[]).includes(mode)) throw new TypeError(`unknown Odai skill source mode: ${String(mode)}`);
  const sourceMode = mode as SkillSourceMode;
  if (!bundled) throw new TypeError("bundled Odai skill is required");
  if (sourceMode === "bundled") return selected(sourceMode, bundled, "bundled-configured");
  if (candidateError) return fallbackSelection(sourceMode, bundled, "external-invalid", candidateError instanceof Error ? candidateError.message : String(candidateError));
  if (!candidate) return sourceMode === "auto" ? selected(sourceMode, bundled, "external-not-installed") : fallbackSelection(sourceMode, bundled, "user-source-missing", "no compatible user-level Odai skill is installed");
  if (candidate.manifest.runtimeContract !== ODAI_RUNTIME_CONTRACT) return fallbackSelection(sourceMode, bundled, "runtime-contract-mismatch", `candidate runtimeContract ${candidate.manifest.runtimeContract} is incompatible with runtime contract ${ODAI_RUNTIME_CONTRACT}`, candidate);
  const versionOrder = compareSkillVersions(candidate.manifest.versionParts, bundled.manifest.versionParts);
  if (versionOrder === 0) {
    if (candidate.governance.digest === bundled.governance.digest) return selected(sourceMode, bundled, "external-equivalent", candidate);
    return fallbackSelection(sourceMode, bundled, "same-version-content-conflict", `candidate ${candidate.manifest.skillVersion} differs from the bundled content with the same version`, candidate);
  }
  if (sourceMode === "user") {
    if (!USER_SOURCES.has(candidate.source) && candidate.source !== "custom") return fallbackSelection(sourceMode, bundled, "user-source-invalid", `source ${candidate.source} is not user-level`, candidate);
    return selected(sourceMode, candidate, "user-configured", candidate);
  }
  if (PROJECT_SOURCES.has(candidate.source)) return selected(sourceMode, candidate, "project-scope-override", candidate);
  if (USER_SOURCES.has(candidate.source)) return versionOrder > 0 ? selected(sourceMode, candidate, "newer-user-skill", candidate) : fallbackSelection(sourceMode, bundled, "user-skill-older", `candidate ${candidate.manifest.skillVersion} is older than bundled ${bundled.manifest.skillVersion}`, candidate);
  return fallbackSelection(sourceMode, bundled, "external-source-unsupported", `source ${candidate.source} cannot provide Odai governance`, candidate);
}
