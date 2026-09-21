import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isUnknownRecord } from "./runtime-types.mjs";

export const GOVERNANCE_CONTRACT = 8;
export const GOVERNANCE_SCHEMA = 5;
export const GOVERNANCE_REFERENCE_NAMES = Object.freeze(["dao", "planning", "craft", "verification", "support", "leverage", "care", "human-safety"] as const);
export type GovernanceReferenceName = (typeof GOVERNANCE_REFERENCE_NAMES)[number];
export interface ParsedSkillVersion { readonly core: readonly [string, string, string]; readonly prerelease: readonly string[] }
export interface GovernanceManifest {
  readonly schemaVersion: 5;
  readonly name: "odai";
  readonly skillVersion: string;
  readonly versionParts: ParsedSkillVersion;
  readonly runtimeContract: number;
  readonly referenceFiles: Readonly<Record<GovernanceReferenceName, string>>;
  readonly requiredFiles: readonly string[];
}
export interface GovernanceBundle {
  readonly path: string;
  readonly root: string;
  readonly source: string;
  readonly provider: string;
  readonly manifest: GovernanceManifest;
  readonly skillText: string;
  readonly skillBody: string;
  readonly referenceContracts: Readonly<Record<GovernanceReferenceName, string>>;
  readonly digest: string;
  readonly fileContents: Readonly<Record<string, string>>;
}
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
export function parseSkillVersion(value: unknown, field = "skillVersion"): Readonly<ParsedSkillVersion> {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const match = value.match(VERSION_PATTERN);
  if (!match) throw new TypeError(`${field} must use SemVer 2.0.0 syntax`);
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  for (const identifier of prerelease) {
    if (/^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) throw new TypeError(`${field} has a numeric prerelease identifier with a leading zero`);
  }
  return Object.freeze({ core: Object.freeze([match[1], match[2], match[3]] as const), prerelease: Object.freeze(prerelease) });
}
function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
export function compareSkillVersions(left: string | ParsedSkillVersion, right: string | ParsedSkillVersion): number {
  const a = typeof left === "string" ? parseSkillVersion(left) : left;
  const b = typeof right === "string" ? parseSkillVersion(right) : right;
  for (let i = 0; i < 3; i++) {
    const x = a.core[i], y = b.core[i];
    if (x === undefined || y === undefined) throw new TypeError("skillVersion core must contain three identifiers");
    const delta = compareNumeric(x, y);
    if (delta) return delta;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/u.test(x), ny = /^\d+$/u.test(y);
    const delta = nx && ny ? compareNumeric(x, y) : nx !== ny ? nx ? -1 : 1 : x === y ? 0 : x < y ? -1 : 1;
    if (delta) return delta;
  }
  return 0;
}
export function bundleFile(root: string, file: unknown): string {
  if (typeof file !== "string" || !file || file !== file.trim() || file.includes("\\") || /^(?:\/|[A-Za-z]:)/u.test(file)
    || file.split("/").some(part => !part || part === "." || part === "..")) throw new TypeError(`unsafe bundle file: ${String(file)}`);
  const target = resolve(root, file);
  const actual = realpathSync(target);
  const fromRoot = relative(realpathSync(root), actual);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) throw new Error(`bundle file escapes its root: ${file}`);
  return actual;
}
export function captureBundleFiles(root: string, files: readonly string[], identity: unknown): { digest: string; fileContents: Readonly<Record<string, string>> } {
  const hash = createHash("sha256").update(JSON.stringify(identity));
  const contents: Record<string, string> = {};
  for (const file of [...files].sort()) {
    const bytes = readFileSync(bundleFile(root, file));
    hash.update("\0").update(file).update("\0").update(bytes);
    contents[file] = bytes.toString("base64");
  }
  return { digest: hash.digest("hex"), fileContents: Object.freeze(contents) };
}
export function governanceManifestValue(manifest: GovernanceManifest) {
  return { schemaVersion: manifest.schemaVersion, name: manifest.name, skillVersion: manifest.skillVersion,
    runtimeContract: manifest.runtimeContract, referenceFiles: { ...manifest.referenceFiles }, requiredFiles: [...manifest.requiredFiles] };
}
export function readSkillManifest(root: string): Readonly<GovernanceManifest> {
  const value: unknown = JSON.parse(readFileSync(bundleFile(root, "manifest.json"), "utf8"));
  if (!isUnknownRecord(value)) throw new TypeError("governance manifest must be an object");
  const fields = new Set(["schemaVersion", "name", "skillVersion", "runtimeContract", "referenceFiles", "requiredFiles"]);
  if (Object.keys(value).some(key => !fields.has(key))) throw new TypeError("governance manifest has unknown fields");
  if (value.schemaVersion !== GOVERNANCE_SCHEMA || value.runtimeContract !== GOVERNANCE_CONTRACT) throw new TypeError("unsupported governance schema or runtime contract");
  if (value.name !== "odai" || typeof value.skillVersion !== "string") throw new TypeError("invalid governance identity");
  if (!Array.isArray(value.requiredFiles) || !value.requiredFiles.length || value.requiredFiles.some(file => typeof file !== "string")
    || new Set(value.requiredFiles).size !== value.requiredFiles.length || !value.requiredFiles.includes("SKILL.md")) throw new TypeError("invalid governance requiredFiles");
  const requiredFiles = value.requiredFiles as string[];
  for (const file of requiredFiles) bundleFile(root, file);
  if (!isUnknownRecord(value.referenceFiles) || Object.keys(value.referenceFiles).sort().join("\0") !== [...GOVERNANCE_REFERENCE_NAMES].sort().join("\0")) throw new TypeError("invalid governance reference owners");
  const references: Record<string, string> = {};
  for (const name of GOVERNANCE_REFERENCE_NAMES) {
    const file = value.referenceFiles[name];
    if (typeof file !== "string" || file === "SKILL.md" || !requiredFiles.includes(file)) throw new TypeError(`invalid governance reference ${name}`);
    references[name] = file;
  }
  if (new Set(Object.values(references)).size !== GOVERNANCE_REFERENCE_NAMES.length) throw new TypeError("governance reference owners must use distinct files");
  return Object.freeze({ schemaVersion: GOVERNANCE_SCHEMA, name: "odai", skillVersion: value.skillVersion,
    versionParts: parseSkillVersion(value.skillVersion), runtimeContract: GOVERNANCE_CONTRACT,
    referenceFiles: Object.freeze(references) as GovernanceManifest["referenceFiles"], requiredFiles: Object.freeze(requiredFiles) });
}
export function loadGovernanceBundle(skillPath: string, options: { source?: string; provider?: string } = {}): Readonly<GovernanceBundle> {
  const entryPath = resolve(skillPath), root = dirname(entryPath);
  const manifest = readSkillManifest(root);
  const captured = captureBundleFiles(root, manifest.requiredFiles, governanceManifestValue(manifest));
  const read = (file: string) => Buffer.from(captured.fileContents[file] ?? "", "base64").toString("utf8");
  const skillText = read("SKILL.md").trim();
  const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter || !/^name:\s*odai\s*$/mu.test(frontmatter[1] ?? "")) throw new TypeError("governance entry must declare name odai");
  const skillBody = skillText.slice(frontmatter[0].length).trim();
  if (!skillBody) throw new TypeError("governance entry is empty");
  const referenceContracts = Object.freeze(Object.fromEntries(GOVERNANCE_REFERENCE_NAMES.map(name => {
    const body = read(manifest.referenceFiles[name]).trim();
    if (!body) throw new TypeError(`governance reference ${name} is empty`);
    return [name, body];
  }))) as GovernanceBundle["referenceContracts"];
  return Object.freeze({ path: entryPath, root, source: options.source ?? "bundled", provider: options.provider ?? "odai-dsh-runtime",
    manifest, skillText, skillBody, referenceContracts, ...captured });
}
