export const RUNTIME_CONTRACT: 9;
export const MANIFEST_SCHEMA: 1;
export const ORCHESTRATION_URL: URL;
export const ROLE_NAMES: readonly ["controller", "researcher", "planner", "reviewer", "frontend"];
export const REFERENCE_NAMES: readonly ["dao", "planning", "craft", "verification", "memory", "leverage", "care", "human-safety", "orchestration"];
export type RoleName = typeof ROLE_NAMES[number];
export type ReferenceName = typeof REFERENCE_NAMES[number];
export interface OrchestrationManifest {
  readonly schemaVersion: 1;
  readonly name: "odai-orchestration";
  readonly version: string;
  readonly governanceContract: 9;
  readonly delegationFile: string;
  readonly roleFiles: Readonly<Record<RoleName, string>>;
  readonly referenceFiles: Readonly<Record<"orchestration", string>>;
  readonly rolePresets: Readonly<Record<RoleName, { readonly references: readonly ReferenceName[] }>>;
  readonly requiredFiles: readonly string[];
}
export interface GovernanceInput {
  readonly runtimeContract: number;
  readonly skillBody: string;
  readonly referenceContracts: Readonly<Record<string, string>>;
}
export function validateCompositionManifest(manifest: unknown): Readonly<OrchestrationManifest>;
export function stripEntryMetadata(text: string): string;
export function composeRoleContract(role: string, governance: GovernanceInput, manifest: unknown, contents: Readonly<Record<string, string>>, options?: { embedded?: boolean }): string;
