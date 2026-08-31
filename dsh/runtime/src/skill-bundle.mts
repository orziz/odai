import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export const ODAI_RUNTIME_CONTRACT = 6;
export const SKILL_MANIFEST_FILE = "manifest.json";
export const SKILL_SOURCE_MODES = Object.freeze(["bundled", "auto", "user"] as const);

export type SkillSourceMode = (typeof SKILL_SOURCE_MODES)[number];

export interface ParsedSkillVersion {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[];
}

export const ODAI_ROLE_NAMES = Object.freeze(["controller", "researcher", "planner", "reviewer", "frontend"] as const);
export const ODAI_REFERENCE_NAMES = Object.freeze([
  "dao",
  "planning",
  "craft",
  "verification",
  "support",
  "leverage",
  "care",
  "human-safety",
] as const);

export type OdaiRoleName = (typeof ODAI_ROLE_NAMES)[number];
export type OdaiReferenceName = (typeof ODAI_REFERENCE_NAMES)[number];

export interface SkillManifest {
  readonly schemaVersion: 2;
  readonly name: "odai";
  readonly skillVersion: string;
  readonly versionParts: ParsedSkillVersion;
  readonly runtimeContract: number;
  readonly roleFiles: Readonly<Record<OdaiRoleName, string>>;
  readonly referenceFiles: Readonly<Record<OdaiReferenceName, string>>;
  readonly requiredFiles: readonly string[];
}

export interface SkillBundle {
  readonly path: string;
  readonly root: string;
  readonly source: string;
  readonly provider: string;
  readonly manifest: SkillManifest;
  readonly skillText: string;
  readonly roleContracts: Readonly<Record<string, string>>;
  readonly referenceContracts: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly fileContents: Readonly<Record<string, string>>;
}

export interface LoadSkillBundleOptions {
  source?: string;
  provider?: string;
}

export interface SkillBundleSelection {
  readonly mode: SkillSourceMode;
  readonly status: "selected" | "fallback";
  readonly reasonCode: string;
  readonly detail?: string;
  readonly bundle: SkillBundle;
  readonly candidate?: SkillBundle;
}

export interface ChooseSkillBundleOptions {
  mode?: unknown;
  bundled?: SkillBundle;
  candidate?: SkillBundle;
  candidateError?: unknown;
}

const MANIFEST_FIELDS = new Set<string>([
  "schemaVersion",
  "name",
  "skillVersion",
  "runtimeContract",
  "roleFiles",
  "referenceFiles",
  "requiredFiles",
]);
const PROJECT_SOURCES = new Set<string>(["project-dsh", "project-agents", "custom"]);
const USER_SOURCES = new Set<string>(["user-dsh", "user-agents"]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function assertPlainObject(value: unknown, field: string): UnknownRecord {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function isSkillSourceMode(value: unknown): value is SkillSourceMode {
  return typeof value === "string" && (SKILL_SOURCE_MODES as readonly string[]).includes(value);
}

export function parseSkillVersion(value: unknown, field = "skillVersion"): Readonly<ParsedSkillVersion> {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const match = value.match(VERSION_PATTERN);
  if (!match) throw new TypeError(`${field} must use SemVer 2.0.0 syntax`);
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  for (const identifier of prerelease) {
    if (/^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new TypeError(`${field} has a numeric prerelease identifier with a leading zero`);
    }
  }
  return Object.freeze({
    core: Object.freeze([match[1], match[2], match[3]] as const),
    prerelease: Object.freeze(prerelease),
  });
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined) return -1;
    if (rightValue === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftValue);
    const rightNumeric = /^\d+$/u.test(rightValue);
    if (leftNumeric && rightNumeric) {
      const difference = compareNumericIdentifier(leftValue, rightValue);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

export function compareSkillVersions(
  left: string | ParsedSkillVersion,
  right: string | ParsedSkillVersion,
): number {
  const leftVersion = typeof left === "string" ? parseSkillVersion(left, "left skillVersion") : left;
  const rightVersion = typeof right === "string" ? parseSkillVersion(right, "right skillVersion") : right;
  for (let index = 0; index < 3; index += 1) {
    const leftIdentifier = leftVersion.core[index];
    const rightIdentifier = rightVersion.core[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      throw new TypeError("skillVersion core must contain three identifiers");
    }
    const difference = compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function resolveBundleFile(root: string, relativePath: unknown): string {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new TypeError("skill manifest requiredFiles entries must be non-empty strings");
  }
  const segments = relativePath.split("/");
  if (relativePath !== relativePath.trim()
    || relativePath.includes("\\")
    || isAbsolute(relativePath)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`skill manifest contains unsafe required file ${JSON.stringify(relativePath)}`);
  }
  const target = resolve(root, ...segments);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new TypeError(`skill manifest required file escapes its bundle: ${relativePath}`);
  }
  return target;
}

function parseOwnedFiles<Name extends string>(
  skillRoot: string,
  value: unknown,
  field: string,
  names: readonly Name[],
  requiredFiles: readonly string[],
): Readonly<Record<Name, string>> {
  const entries = assertPlainObject(value, field);
  const unknownNames = Object.keys(entries).filter((name) => !names.includes(name as Name));
  if (unknownNames.length > 0) throw new TypeError(`${field} has unknown owners: ${unknownNames.join(", ")}`);
  const files = names.map((name) => {
    const relativePath = entries[name];
    if (typeof relativePath !== "string" || relativePath.trim() === "") {
      throw new TypeError(`${field}.${name} must be a non-empty string`);
    }
    resolveBundleFile(skillRoot, relativePath);
    if (!requiredFiles.includes(relativePath)) {
      throw new TypeError(`${field}.${name} must also appear in requiredFiles`);
    }
    return [name, relativePath] as const;
  });
  const paths = files.map(([, relativePath]) => relativePath);
  if (new Set(paths).size !== paths.length) throw new TypeError(`${field} must map each owner to a unique file`);
  return Object.freeze(Object.fromEntries(files)) as Readonly<Record<Name, string>>;
}

function assertRealPathInside(rootRealPath: string, target: string, label: string): string {
  const targetRealPath = realpathSync(target);
  const fromRoot = relative(rootRealPath, targetRealPath);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Odai skill bundle path escapes through a symlink: ${label}`);
  }
  return targetRealPath;
}

export function readSkillManifest(skillRoot: string): Readonly<SkillManifest> {
  const rootRealPath = realpathSync(skillRoot);
  const manifestPath = resolve(skillRoot, SKILL_MANIFEST_FILE);
  let parsed: unknown;
  try {
    const manifestRealPath = assertRealPathInside(rootRealPath, manifestPath, SKILL_MANIFEST_FILE);
    parsed = JSON.parse(readFileSync(manifestRealPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read Odai skill manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = assertPlainObject(parsed, `Odai skill manifest ${manifestPath}`);
  const unknownFields = Object.keys(manifest).filter((field) => !MANIFEST_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new TypeError(`Odai skill manifest ${manifestPath} has unknown fields: ${unknownFields.join(", ")}`);
  }
  if (manifest.schemaVersion !== 2) {
    throw new TypeError(`Odai skill manifest ${manifestPath} has unsupported schemaVersion ${String(manifest.schemaVersion)}`);
  }
  if (manifest.name !== "odai") throw new TypeError(`Odai skill manifest ${manifestPath} must name odai`);
  if (typeof manifest.skillVersion !== "string") {
    throw new TypeError(`Odai skill manifest ${manifestPath}.skillVersion must be a string`);
  }
  const skillVersion = manifest.skillVersion;
  const versionParts = parseSkillVersion(skillVersion, `Odai skill manifest ${manifestPath}.skillVersion`);
  if (typeof manifest.runtimeContract !== "number" || !Number.isSafeInteger(manifest.runtimeContract) || manifest.runtimeContract <= 0) {
    throw new TypeError(`Odai skill manifest ${manifestPath}.runtimeContract must be a positive integer`);
  }
  if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.length === 0) {
    throw new TypeError(`Odai skill manifest ${manifestPath}.requiredFiles must be a non-empty array`);
  }
  const requiredFiles = manifest.requiredFiles.map((file) => {
    if (typeof file !== "string" || file.trim() === "") {
      throw new TypeError("skill manifest requiredFiles entries must be non-empty strings");
    }
    resolveBundleFile(skillRoot, file);
    return file;
  });
  if (new Set(requiredFiles).size !== requiredFiles.length) {
    throw new TypeError(`Odai skill manifest ${manifestPath}.requiredFiles contains duplicates`);
  }
  if (!requiredFiles.includes("SKILL.md")) {
    throw new TypeError(`Odai skill manifest ${manifestPath} is missing required runtime file SKILL.md`);
  }
  const roleFiles = parseOwnedFiles(
    skillRoot,
    manifest.roleFiles,
    `Odai skill manifest ${manifestPath}.roleFiles`,
    ODAI_ROLE_NAMES,
    requiredFiles,
  );
  const referenceFiles = parseOwnedFiles(
    skillRoot,
    manifest.referenceFiles,
    `Odai skill manifest ${manifestPath}.referenceFiles`,
    ODAI_REFERENCE_NAMES,
    requiredFiles,
  );
  const ownerPaths = [...Object.values(roleFiles), ...Object.values(referenceFiles)];
  if (new Set(ownerPaths).size !== ownerPaths.length) {
    throw new TypeError(`Odai skill manifest ${manifestPath} must map each role and reference owner to a unique file`);
  }
  return Object.freeze({
    schemaVersion: 2,
    name: "odai",
    skillVersion,
    versionParts,
    runtimeContract: manifest.runtimeContract,
    roleFiles,
    referenceFiles,
    requiredFiles: Object.freeze(requiredFiles),
  });
}

export function loadSkillBundle(skillPath: string, options: LoadSkillBundleOptions = {}): Readonly<SkillBundle> {
  const entryPath = resolve(skillPath);
  const root = dirname(entryPath);
  const rootRealPath = realpathSync(root);
  const manifest = readSkillManifest(root);
  const digest = createHash("sha256");
  const contents = new Map<string, Buffer>();
  digest.update(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    skillVersion: manifest.skillVersion,
    runtimeContract: manifest.runtimeContract,
    roleFiles: manifest.roleFiles,
    referenceFiles: manifest.referenceFiles,
    requiredFiles: manifest.requiredFiles,
  }));

  for (const relativePath of [...manifest.requiredFiles].sort()) {
    const path = resolveBundleFile(root, relativePath);
    if (!existsSync(path)) throw new Error(`Odai skill bundle ${root} is missing ${relativePath}`);
    const realPath = assertRealPathInside(rootRealPath, path, relativePath);
    const content = readFileSync(realPath);
    contents.set(relativePath, content);
    digest.update("\0");
    digest.update(relativePath);
    digest.update("\0");
    digest.update(content);
  }

  const skillContent = contents.get("SKILL.md");
  if (!skillContent) throw new Error(`Odai skill bundle ${root} is missing SKILL.md`);
  const skillText = skillContent.toString("utf8").trim();
  if (!skillText) throw new Error(`Odai canonical skill is empty: ${entryPath}`);
  const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  if (!frontmatter || !/^name:\s*odai\s*$/mu.test(frontmatter)) {
    throw new Error(`Odai canonical skill entry does not declare name odai: ${entryPath}`);
  }

  const roleContracts: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
    ODAI_ROLE_NAMES.map((role) => {
      const relativePath = manifest.roleFiles[role];
      const content = contents.get(relativePath);
      if (!content) throw new Error(`Odai canonical ${role} role is unavailable: ${resolve(root, relativePath)}`);
      const text = content.toString("utf8").trim();
      if (!text) throw new Error(`Odai canonical ${role} role is unavailable: ${resolve(root, relativePath)}`);
      return [role, text];
    }),
  ));
  const referenceContracts: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
    ODAI_REFERENCE_NAMES.map((reference) => {
      const relativePath = manifest.referenceFiles[reference];
      const text = contents.get(relativePath)?.toString("utf8").trim();
      if (!text) throw new Error(`Odai canonical ${reference} reference is unavailable: ${resolve(root, relativePath)}`);
      return [reference, text];
    }),
  ));
  const fileContents: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
    [...contents].map(([relativePath, content]) => [relativePath, content.toString("base64")]),
  ));

  const bundle: SkillBundle = {
    path: entryPath,
    root,
    source: typeof options.source === "string" && options.source ? options.source : "bundled",
    provider: typeof options.provider === "string" && options.provider ? options.provider : "odai-dsh-runtime",
    manifest,
    skillText,
    roleContracts,
    referenceContracts,
    digest: digest.digest("hex"),
    fileContents,
  };
  Object.defineProperty(bundle, "fileContents", { value: fileContents, enumerable: false });
  return Object.freeze(bundle);
}

export function readSkillBundleFile(bundle: SkillBundle, relativePath: string): Buffer {
  if (!bundle || typeof bundle !== "object" || !bundle.manifest?.requiredFiles?.includes(relativePath)) {
    throw new TypeError(`unknown Odai skill bundle file: ${String(relativePath)}`);
  }
  const encoded = bundle.fileContents?.[relativePath];
  if (typeof encoded !== "string") throw new Error(`Odai skill bundle snapshot is missing ${relativePath}`);
  return Buffer.from(encoded, "base64");
}

function fallbackSelection(
  mode: SkillSourceMode,
  bundled: SkillBundle,
  reasonCode: string,
  detail?: string,
  candidate?: SkillBundle,
): Readonly<SkillBundleSelection> {
  return Object.freeze({
    mode,
    status: "fallback",
    reasonCode,
    ...(detail === undefined ? {} : { detail }),
    bundle: bundled,
    ...(candidate ? { candidate } : {}),
  });
}

function selected(
  mode: SkillSourceMode,
  bundle: SkillBundle,
  reasonCode: string,
  candidate?: SkillBundle,
): Readonly<SkillBundleSelection> {
  return Object.freeze({
    mode,
    status: "selected",
    reasonCode,
    bundle,
    ...(candidate ? { candidate } : {}),
  });
}

export function chooseSkillBundle(options: ChooseSkillBundleOptions = {}): Readonly<SkillBundleSelection> {
  const { mode, bundled, candidate, candidateError } = options;
  if (!isSkillSourceMode(mode)) throw new TypeError(`unknown Odai skill source mode: ${String(mode)}`);
  if (!bundled) throw new TypeError("bundled Odai skill is required");
  if (mode === "bundled") return selected(mode, bundled, "bundled-configured");
  if (candidateError) {
    return fallbackSelection(mode, bundled, "external-invalid", candidateError instanceof Error ? candidateError.message : String(candidateError));
  }
  if (!candidate) {
    return mode === "auto"
      ? selected(mode, bundled, "external-not-installed")
      : fallbackSelection(mode, bundled, "user-source-missing", "no compatible user-level Odai skill is installed");
  }
  if (candidate.manifest.runtimeContract !== ODAI_RUNTIME_CONTRACT) {
    return fallbackSelection(
      mode,
      bundled,
      "runtime-contract-mismatch",
      `candidate runtimeContract ${candidate.manifest.runtimeContract} is incompatible with runtime contract ${ODAI_RUNTIME_CONTRACT}`,
      candidate,
    );
  }

  const versionOrder = compareSkillVersions(candidate.manifest.versionParts, bundled.manifest.versionParts);
  if (versionOrder === 0) {
    if (candidate.digest === bundled.digest) return selected(mode, bundled, "external-equivalent", candidate);
    return fallbackSelection(
      mode,
      bundled,
      "same-version-content-conflict",
      `candidate ${candidate.manifest.skillVersion} differs from the bundled content with the same version`,
      candidate,
    );
  }

  if (mode === "user") {
    if (!USER_SOURCES.has(candidate.source) && candidate.source !== "custom") {
      return fallbackSelection(mode, bundled, "user-source-invalid", `source ${candidate.source} is not user-level`, candidate);
    }
    return selected(mode, candidate, "user-configured", candidate);
  }
  if (PROJECT_SOURCES.has(candidate.source)) return selected(mode, candidate, "project-scope-override", candidate);
  if (USER_SOURCES.has(candidate.source)) {
    return versionOrder > 0
      ? selected(mode, candidate, "newer-user-skill", candidate)
      : fallbackSelection(
          mode,
          bundled,
          "user-skill-older",
          `candidate ${candidate.manifest.skillVersion} is older than bundled ${bundled.manifest.skillVersion}`,
          candidate,
        );
  }
  return fallbackSelection(mode, bundled, "external-source-unsupported", `source ${candidate.source} cannot provide Odai governance`, candidate);
}
