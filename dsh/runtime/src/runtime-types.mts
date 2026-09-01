export type UnknownRecord = Record<string, unknown>;

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ModelRoute extends UnknownRecord {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export type ResponsibilityDispatch = "same-turn" | "child";

export interface DshContentBlock extends UnknownRecord {
  type: string;
  text?: string;
}

export interface DshMessageSource extends UnknownRecord {
  kind: string;
  plugin?: string;
  form?: string;
  summary?: string;
}

export interface DshMessage extends UnknownRecord {
  id?: string;
  role?: string;
  content?: readonly DshContentBlock[];
  source?: DshMessageSource;
}

export interface RuntimeEventData extends UnknownRecord {
  turn?: number;
  step?: number;
  id?: string;
  callId?: string;
  rootCallId?: string;
  name?: string;
  tool?: string;
  arguments?: unknown;
  sourceEventSeqs?: readonly number[];
  isError?: boolean;
  error?: unknown;
  role?: string;
  content?: readonly DshContentBlock[];
  message?: DshMessage;
  inserted?: readonly DshMessage[];
  source?: UnknownRecord | string;
  capability?: string;
  responsibility?: string;
  stateDigest?: string;
  digest?: string;
  evidenceDigest?: string;
  diagnostics?: UnknownRecord;
  continuationPolicy?: string;
  scopeId?: string;
  responsibilityScopeId?: string;
  actualRoute?: ModelRoute;
  chunk?: {
    type?: string;
    usage?: { outputTokens?: number };
  };
  usage?: { outputTokens?: number };
  reason?: { kind?: string } | string;
  reasonCode?: string;
  action?: string;
  targetRole?: string;
  label?: string;
  signals?: readonly string[];
  mismatchReasons?: readonly string[];
  activeTools?: readonly string[];
  mode?: string;
  status?: string;
  stopReason?: string;
  fallbackUsed?: boolean;
  independent?: boolean;
  budgetSource?: string;
  startStep?: number;
  stopStep?: number;
  requestedRoute?: ModelRoute;
  effectiveRoute?: ModelRoute;
  effectiveMaxTokens?: number;
  responsibilityMaxTokens?: number;
  configuredControllerMaxTokens?: number;
  outputTokens?: number;
  baseRoute?: ModelRoute;
  temporaryRoute?: ModelRoute;
  routeMode?: string;
  routeSource?: string;
  resumeOfScopeId?: string;
  resumedScopeId?: string;
  header?: { config?: ModelRoute };
  receiptStatus?: string;
}

export interface DshEvent extends UnknownRecord {
  type: string;
  seq?: number;
  data: RuntimeEventData;
}

export interface DshSessionHeader extends UnknownRecord {
  id?: string;
  cwd?: string;
  origin?: string;
  delegationDepth?: number;
}

export interface DshSession {
  header: DshSessionHeader;
  events: DshEvent[];
  append(type: string, data: RuntimeEventData, options?: UnknownRecord): unknown;
  requestHeader?(): { config?: ModelRoute };
}

export interface ToolRestriction {
  deny?: readonly string[];
  allow?: readonly string[];
}

export interface DshAgent {
  session: DshSession;
  inject?(message: DshMessage): void;
  phase?: { turn?: number; step?: number };
  options?: UnknownRecord;
  ctx?: {
    tools?: {
      restrict(restriction: ToolRestriction): (() => void) | void;
    };
  };
}

export interface ToolSchema extends UnknownRecord {
  name: string;
  description?: string;
  parameters?: UnknownRecord;
}

export interface PromptSection extends UnknownRecord {
  name: string;
  order?: number;
  text: string;
}

export interface PromptAssembly extends UnknownRecord {
  sections: PromptSection[];
  tools: ToolSchema[];
}

export interface ToolExecution extends UnknownRecord {
  callId?: string;
  rootCallId?: string;
  name: string;
  agent?: DshAgent;
  signal?: AbortSignal;
}

export interface ToolResult extends UnknownRecord {
  isError?: boolean;
  error?: { message?: string; code?: string };
  output?: readonly DshContentBlock[];
}

export interface RuntimeTool<TArguments, TResult> extends ToolSchema {
  output?: {
    schema: UnknownRecord;
    render(arguments_: TArguments, value: TResult): readonly DshContentBlock[];
  };
  execute(arguments_: TArguments, execution: ToolExecution): TResult | Promise<TResult>;
}

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface DshToolsService {
  register(tool: unknown): void;
  guard?(guard: (execution: ToolExecution) => unknown): void;
  restrict?(agent: DshAgent, restriction: ToolRestriction): (() => void) | void;
  schemas?(agent?: DshAgent): ToolSchema[];
  get?(name: string): unknown;
  execute?(execution: ToolExecution & { arguments?: UnknownRecord }): Promise<ToolResult>;
}

export interface SkillRegistry {
  get(...args: unknown[]): unknown;
}

export interface DshLlmService {
  resolveCallConfig(config: UnknownRecord, signal?: AbortSignal): unknown;
  stream(options: UnknownRecord): AsyncIterable<UnknownRecord>;
}

export interface DshSessionsService {
  get(sessionId: string): DshSession | undefined;
}

export interface DshRuntimeContext {
  on(event: string, handler: CallableFunction, options?: UnknownRecord): void;
  effect?(effect: () => (() => void | Promise<void>) | void, label?: string): void;
  logger?(name: string): RuntimeLogger;
  tools: DshToolsService;
  systemPrompt: {
    section(section: PromptSection): void;
  };
  llm: DshLlmService;
  sessions?: DshSessionsService;
  subagents?: unknown;
  skills?: SkillRegistry;
  get?(name: string): unknown;
}

export interface RuntimeConfig {
  skillPath?: string;
  routing: {
    mode: "off" | "observe" | "auto" | "execute";
    provider: string;
    maxInputChars: number;
    configPath: string;
    roles: Readonly<Record<string, ModelRoute | undefined>>;
    dispatch: Readonly<Record<string, ResponsibilityDispatch | undefined>>;
  };
  governance: {
    additionalDeniedTools: readonly string[];
    skillSource: "bundled" | "auto" | "user";
    skillConfigPath: string;
    evolutionRoot: string;
  };
  output: { configPath: string };
  compaction: {
    configPath: string;
    cacheRetention: "provider-default" | "short" | "long" | "none";
  };
  memory: {
    mode: "auto" | "off";
    storePath: string;
    maxRetrieved: number;
  };
}
