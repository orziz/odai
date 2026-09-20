export const RUNTIME_CONTRACT: 7;
export const MANIFEST_SCHEMA: 3;
export const ROLE_NAMES: readonly ["controller", "researcher", "planner", "reviewer", "frontend"];
export const REFERENCE_NAMES: readonly ["dao", "planning", "craft", "verification", "support", "leverage", "care", "human-safety"];
export const MODULE_NAMES: readonly ["core", "entry", "delegation"];
export const MODULE_FILE_NAMES: readonly ["entry", "delegation"];
export type RoleName = typeof ROLE_NAMES[number];
export type ReferenceName = typeof REFERENCE_NAMES[number];
export type ModuleName = typeof MODULE_NAMES[number];
export interface CompositionTopology {
  readonly moduleFiles: Readonly<Record<typeof MODULE_FILE_NAMES[number], string>>;
  readonly roleFiles: Readonly<Record<RoleName, string>>;
  readonly referenceFiles: Readonly<Record<ReferenceName, string>>;
  readonly rolePresets: Readonly<Record<RoleName, { readonly modules: readonly ModuleName[]; readonly references: readonly ReferenceName[] }>>;
}
export function validateCompositionManifest(manifest: unknown): Readonly<CompositionTopology>;
export function stripEntryMetadata(text: string): string;
export function composeEntry(manifest: unknown, contents: Readonly<Record<string, string>>): string;
export function composeCore(manifest: unknown, contents: Readonly<Record<string, string>>): string;
export function composeRoleContract(role: string, manifest: unknown, contents: Readonly<Record<string, string>>, options?: { embedded?: boolean }): string;
