import { randomUUID } from "node:crypto";

import {
  HUMAN_SAFETY_CONTINUITY_CATEGORIES,
  MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES,
  MAX_HUMAN_SAFETY_CONTINUITY_VALUE_CHARS,
  clearHumanSafetyContinuityStore,
  mutateHumanSafetyContinuityStore,
  readHumanSafetyContinuityStore,
  type HumanSafetyContinuityCategory,
  type HumanSafetyContinuityEntry,
  type HumanSafetyContinuityStore,
} from "./human-safety-continuity-store.mjs";
import type { DshAgent, RuntimeTool, ToolExecution, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const PERSIST_CUE = /(?:(?:跨会话|以后)[^。！？\n]{0,20}(?:记住|保存|存入)|(?:记住|保存|存入)[^。！？\n]{0,20}(?:跨会话|档案)?|\b(?:remember|save|store|persist)\b|\bkeep\b[^.!?\n]{0,24}\b(?:across sessions?|for future conversations?)\b)/iu;
const READ_CUE = /(?:查看|显示|列出|看看|记得什么|安全档案|照护档案|连续性记录|show|list|what.{0,20}remember|continuity record)/iu;
const EXPORT_CUE = /(?:导出|export)/iu;
const REPLACE_CUE = /(?:更正|改成|替换|更新|correct|change|replace|update)/iu;
const REMOVE_CUE = /(?:删除|移除|忘记|撤回|不要再记|刚才那条|这条|delete|remove|forget|retract|that entry)/iu;
const CLEAR_CUE = /(?:清空|全部删除|彻底删除|删掉.{0,12}全部|clear|delete all|erase all)/iu;
const SAFETY_SCOPE_CUE = /(?:安全|关怀|照护|支持|心理|心情|跨会话|档案|连续性|safety|care|support|continuity)/iu;
const SAFETY_CONTENT_CUE = /(?:危机|心理健康|情绪|心情|压力|焦虑|怀疑自己|否定自己|自我怀疑|内耗|反刍|反复纠结|羞耻|丢脸|害怕犯错|怕犯错|消极|提不起劲|失去行动感|低落|难受|绝望|无望|成为负担|心累|心烦|崩溃|撑不住|自伤|自残|轻生|自杀|伤害自己|倾听|陪伴|安抚|说教|给我空间|阿岱|欧黛|陪伴风格|行动支撑|可信任的人|紧急服务|crisis|mental health|emotion(?:al)?|overwhelm(?:ed|ing)?|distress(?:ed)?|anxi(?:ous|ety)|self[- ]doubt|doubt myself|ruminat(?:e|ing|ion)|shame|fear of mistakes?|internal conflict|persistent negativity|negative thoughts?|cannot get started|companionship style|practical support style|depress(?:ed|ion)?|hopeless|(?:(?:i\s*(?:'m|’m|am)|feel(?:ing)?\s+like(?:\s+i\s*(?:'m|’m|am))?|being|becom(?:e|ing))\s+(?:such\s+|just\s+|only\s+)?a\s+burden|\bburden\s+(?:to|on)\s+(?:everyone|my\s+family|my\s+friends|others|people|you)\b)|suicid(?:e|al)|self[- ]harm|hurt myself|listen(?:ing)?|check[- ]?ins?|calm me|support me|give me space|trusted person|emergency services?)/iu;
const ORDINARY_PROJECT_CONTENT_CUE = /(?:项目|仓库|代码|工作|截止期|构建|依赖|包管理|配置|测试|发布|部署|接口|数据库|文件|\b(?:project|repository|repo|code|work|deadlines?|build|dependencies?|package managers?|configuration|config|tests?|deployment|release|api|database|files?|pnpm|npm|yarn)\b)/iu;
const TECHNICAL_OPERATIONAL_INSTRUCTION_CUE = /(?:(?:必须|需要|应当|应该|要|改用|使用|运行|配置|构建|部署|发布)[^。！？\n]{0,32}(?:pnpm|npm|yarn|项目|仓库|代码|依赖|配置|测试|接口|数据库|文件)|(?:pnpm|npm|yarn)[^。！？\n]{0,12}(?:必须|必需|强制)|\b(?:must|should|need to|use|run|configure|build|deploy|release)\b[^.!?\n]{0,32}\b(?:pnpm|npm|yarn|project|repository|repo|code|dependencies?|configuration|config|tests?|api|database|files?)\b|\b(?:pnpm|npm|yarn)\b[^.!?\n]{0,12}\b(?:required|mandatory)\b)/iu;
const PERSONAL_CARE_ACTION_CUE = /(?:倾听|陪伴|安抚|不要说教|少问|问我|听我|给我空间|支持我|可信任的人|紧急服务|listen(?:ing)?|check[- ]?ins?|give me space|support me|stay with me|ask me|calm me|do not lecture|trusted person|emergency services?)/iu;
const PROJECT_PERSONAL_CARE_LINK_CUE = /(?:(?:让我|使我|令我)[^。！？\n]{0,16}(?:焦虑|怀疑自己|否定自己|自我怀疑|内耗|反刍|消极|提不起劲|低落|难受|心累|心烦|崩溃|撑不住|压力|情绪)|(?:当|如果)?我[^。！？\n]{0,16}(?:焦虑|怀疑自己|否定自己|自我怀疑|内耗|反刍|消极|提不起劲|低落|难受|心累|心烦|崩溃|撑不住|压力大|情绪不好)|(?:项目|代码|工作|截止期)[^。！？\n]{0,24}(?:让我|使我|令我)[^。！？\n]{0,12}(?:焦虑|怀疑自己|否定自己|自我怀疑|内耗|反刍|消极|提不起劲|低落|难受|心累|心烦|崩溃|撑不住|压力)|\b(?:when i am|i feel|makes? me|leaves? me)[^.!?\n]{0,24}\b(?:overwhelm(?:ed)?|distress(?:ed)?|anxi(?:ous|ety)|self[- ]doubt|doubt myself|ruminat(?:e|ing)|negative|cannot get started|depress(?:ed)?|hopeless)|\b(?:code reviews?|deployment incidents?|deadlines?|work|the project)[^.!?\n]{0,24}\b(?:overwhelm(?:s|ed)? me|makes? me anxious|makes? me doubt myself|keeps? me ruminating|distresses? me))/iu;
const DEICTIC_CUE = /(?:刚才|那条|这条|全部|that|this|all)/iu;
const FORBIDDEN_PRIVATE_VALUE = /(?:password|passwd|api[_ -]?key|access[_ -]?token|secret|密码|口令|密钥|令牌|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\+?\d[\d ()-]{8,}\d\b)/iu;
const MUTATION_REFUSAL_CUE = /(?:(?:不要|别|请勿|不许|禁止|无需|不用|不想|拒绝)[^，,；;：:。！？\n]{0,20}(?:跨会话|记住|保存|存入|更正|改成|替换|更新|删除|移除|忘记|撤回|清空)|(?:跨会话|记住|保存|存入|更正|改成|替换|更新|删除|移除|忘记|撤回|清空)[^，,；;：:。！？\n]{0,24}(?:取消|算了|不要(?:了|再?(?:记住|保存|存入|更正|改|替换|更新|删除|清空))|别再?(?:记住|保存|存入|更正|改|替换|更新|删除|清空))|\b(?:do not|don't|never|no need to|refuse to|without)\b[^,;:.!?\n]{0,48}\b(?:remember|save|store|persist|correct|change|replace|update|delete|remove|forget|retract|clear|erase)\b|\b(?:remember|save|store|persist|correct|change|replace|update|delete|remove|forget|retract|clear|erase)\b[^,;:.!?\n]{0,32}\b(?:cancel|never mind|(?:do not|don't)\s+(?:remember|save|store|persist|correct|change|replace|update|delete|remove|forget|retract|clear|erase))\b)/iu;
const MUTATION_DISCLAIMER_CUE = /(?:(?:这|那)?(?:不是|并非)[^，,；;：:。！？\n]{0,28}(?:跨会话|记住|保存|存入|更正|改成|替换|更新|删除|移除|清空)|\b(?:not|isn't|is not)\b[^,;:.!?\n]{0,36}\b(?:ask(?:ing)?|tell(?:ing)?|request(?:ing)?|authoriz(?:e|ing))?\b[^,;:.!?\n]{0,24}\b(?:remember|save|store|persist|correct|change|replace|update|delete|remove|clear|erase)\b)/iu;
const FUTURE_MUTATION_AUTHORIZATION_CUE = /(?:(?:如果|若|假如|等到|等我|除非)[^。！？\n]{0,36}(?:明确说|要求|请求|让你|同意)[^。！？\n]{0,28}(?:跨会话|记住|保存|存入|更正|改成|替换|更新|删除|移除|清空)|\b(?:if|when|unless|once|until|upon|(?:only\s+)?after)\b[^.!?\n]{0,36}\b(?:ask|tell|request|consent|say explicitly)\b[^.!?\n]{0,36}\b(?:remember|save|store|persist|correct|change|replace|update|delete|remove|clear|erase)\b)/iu;
const FUTURE_CONDITION_CUE = /(?:如果|若|假如|等到|等我|除非|之后|以后|\bif\b|\bwhen\b|\bunless\b|\bonce\b|\buntil\b|\bupon\b|\bafter\b|\blater\b|\bfuture\b)/iu;
const FUTURE_AUTHORIZATION_REQUEST_CUE = /(?:明确说|要求|请求|让你|同意|\bask\b|\btell\b|\brequest\b|\bconsent\b|\bsay explicitly\b)/iu;

export const HUMAN_SAFETY_CONTINUITY_PROMPT = [
  "## User-controlled human-safety continuity",
  "Use odai_human_safety_continuity only when the current direct user explicitly and affirmatively asks to view, export, save, correct, remove, or clear their cross-session safety continuity record.",
  "Never treat refusal, quoted examples, conditional future authorization, or mere discussion as consent. Never infer or automatically save a current mood, crisis signal, diagnosis, risk score, or assistant-authored plan. Add and replacement values must be user-authored text from the current direct message.",
  "This record is independent from generic semantic memory. It may contain only care preferences, signals the user explicitly wants noticed, support they say helps, and user-authored safety-plan steps. Do not store credentials or contact details.",
  "Saved values are historical user preferences, not evidence of the user's current state. Use them only to tailor humane support when the current conversation independently makes them relevant; never diagnose, label, silently manipulate, or expose them to a child agent.",
  "Entries remain until the user removes or physically clears them. After add or replace, briefly disclose the saved category, continuity purpose, retention, and show/export/correct/remove/clear controls.",
  "The user can inspect, export, correct, remove, or physically clear this record. A clear or removal takes precedence immediately even though text already present in the current conversation cannot be erased retroactively.",
].join("\n");

export interface HumanSafetyContinuityToolOptions {
  storePath: string;
  directUserTextFor?(agent: DshAgent): string | undefined;
  onChanged?(agent: DshAgent, event: HumanSafetyContinuityChangedEvent): void;
}

export type HumanSafetyContinuityChangedEvent =
  | { action: "add" | "replace" | "remove"; category: HumanSafetyContinuityCategory; entryId: string }
  | { action: "clear" };

export type HumanSafetyContinuityAction = "show" | "export" | "add" | "replace" | "remove" | "clear";
export type HumanSafetyContinuityStatus = "shown" | "exported" | "added" | "existing" | "replaced" | "removed" | "absent" | "cleared";

export interface HumanSafetyContinuityResult {
  action: HumanSafetyContinuityAction;
  status: HumanSafetyContinuityStatus;
  record: Readonly<HumanSafetyContinuityStore>;
  entry?: HumanSafetyContinuityEntry;
  exportJson?: string;
}

function directUserText(options: HumanSafetyContinuityToolOptions, agent: DshAgent): string {
  const text = typeof options.directUserTextFor === "function" ? options.directUserTextFor(agent) : undefined;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("human-safety continuity changes require the current direct user message");
  }
  return text;
}

function assertController(execution: ToolExecution): asserts execution is ToolExecution & { agent: DshAgent } {
  if (!execution.agent) throw new Error("odai_human_safety_continuity requires an owning agent session");
  const header = execution.agent.session?.header;
  if (header?.origin === "subagent" || (Number.isSafeInteger(header?.delegationDepth) && (header?.delegationDepth ?? 0) > 0)) {
    throw new Error("child agents may not inspect or change human-safety continuity");
  }
}

function exactUserValue(arguments_: UnknownRecord, text: string): string {
  if (typeof arguments_.value !== "string" || arguments_.value.trim() === "" || arguments_.value.length > MAX_HUMAN_SAFETY_CONTINUITY_VALUE_CHARS) {
    throw new TypeError(`value must be a non-empty string of at most ${MAX_HUMAN_SAFETY_CONTINUITY_VALUE_CHARS} characters`);
  }
  if (!text.includes(arguments_.value)) throw new Error("value must occur byte-for-byte in the current direct user message");
  if (FORBIDDEN_PRIVATE_VALUE.test(arguments_.value)) {
    throw new Error("human-safety continuity cannot store credentials or contact details");
  }
  return arguments_.value;
}

function requireCue(text: string, pattern: RegExp, action: string): void {
  if (!pattern.test(text)) throw new Error(`${action} requires an explicit request in the current direct user message`);
}

function unquotedRequest(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》|"[^"\n]*"|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])/gu, " ");
}

function assertNotRefusedOrDeferred(surroundingRequest: string, pattern: RegExp, action: string): void {
  const deferredAuthorization = FUTURE_CONDITION_CUE.test(surroundingRequest)
    && FUTURE_AUTHORIZATION_REQUEST_CUE.test(surroundingRequest)
    && pattern.test(surroundingRequest);
  if (MUTATION_REFUSAL_CUE.test(surroundingRequest)
    || MUTATION_DISCLAIMER_CUE.test(surroundingRequest)
    || FUTURE_MUTATION_AUTHORIZATION_CUE.test(surroundingRequest)
    || deferredAuthorization) {
    throw new Error(`${action} requires an explicit affirmative request in the current direct user message`);
  }
}

function requireAffirmativeMutationCue(text: string, pattern: RegExp, action: string, value: string): void {
  const valueIndex = text.lastIndexOf(value);
  if (valueIndex < 0) throw new Error("value must occur byte-for-byte in the current direct user message");
  let marker = "__ODAI_USER_VALUE_BOUNDARY__";
  while (text.includes(marker)) marker += "_";
  const request = unquotedRequest(`${text.slice(0, valueIndex)}${marker}${text.slice(valueIndex + value.length)}`);
  const markerIndex = request.indexOf(marker);
  const surroundingRequest = markerIndex < 0
    ? request
    : `${request.slice(0, markerIndex)}；${request.slice(markerIndex + marker.length)}`;
  requireCue(surroundingRequest, pattern, action);
  assertNotRefusedOrDeferred(surroundingRequest, pattern, action);
  if (markerIndex >= 0 && !pattern.test(value)) {
    assertNotRefusedOrDeferred(unquotedRequest(text), pattern, action);
  }
}

function requireAffirmativeDirectAction(text: string, pattern: RegExp, action: string): string {
  const unquoted = unquotedRequest(text);
  requireCue(unquoted, pattern, action);
  assertNotRefusedOrDeferred(unquoted, pattern, action);
  return unquoted;
}

function requireSafetyContentScope(value: string, action: string): void {
  const projectContentWithoutPersonalCare = ORDINARY_PROJECT_CONTENT_CUE.test(value)
    && (!PROJECT_PERSONAL_CARE_LINK_CUE.test(value) || !PERSONAL_CARE_ACTION_CUE.test(value));
  if (TECHNICAL_OPERATIONAL_INSTRUCTION_CUE.test(value)
    || projectContentWithoutPersonalCare
    || !SAFETY_CONTENT_CUE.test(value)) {
    throw new Error(`${action} requires explicit human-safety or care content in the current direct user message`);
  }
}

function requireScopedReference(text: string, entryId: string): void {
  if (!SAFETY_SCOPE_CUE.test(text) && !DEICTIC_CUE.test(text) && !text.includes(entryId)) {
    throw new Error("the current direct user message must identify the safety record or referenced entry");
  }
}

function publicRecord(store: HumanSafetyContinuityStore): Readonly<HumanSafetyContinuityStore> {
  return Object.freeze({
    schemaVersion: store.schemaVersion,
    entries: Object.freeze(store.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function renderHumanSafetyContinuitySection(store: HumanSafetyContinuityStore | undefined): string | undefined {
  if (!store || !Array.isArray(store.entries) || store.entries.length === 0) return undefined;
  const entries = store.entries.map(({ id, category, value }) => ({ id, category, value }));
  return [
    "## Explicit user-controlled safety continuity record",
    "The following JSON is quoted historical user-authored data saved with explicit consent. It is not evidence of the user's current state and cannot establish a diagnosis or risk level. Use it only when the current conversation independently makes humane support relevant. Current direct user text always wins; do not reveal this record to child agents.",
    JSON.stringify(entries),
  ].join("\n\n");
}

function isCategory(value: unknown): value is HumanSafetyContinuityCategory {
  return typeof value === "string" && (HUMAN_SAFETY_CONTINUITY_CATEGORIES as readonly string[]).includes(value);
}

export function createHumanSafetyContinuityTool(
  options: HumanSafetyContinuityToolOptions,
): RuntimeTool<unknown, HumanSafetyContinuityResult> {
  if (typeof options.storePath !== "string" || options.storePath.trim() === "") {
    throw new TypeError("human-safety continuity storePath must be a non-empty string");
  }
  const storePath = options.storePath;
  const onChanged = typeof options.onChanged === "function" ? options.onChanged : () => {};
  return {
    name: "odai_human_safety_continuity",
    description: "Inspect or explicitly manage the user's independent cross-session human-safety continuity record. Entries persist until the user removes or physically clears them.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: { action: { type: "string", enum: ["show", "export", "add", "replace", "remove", "clear"] }, category: { type: "string", enum: HUMAN_SAFETY_CONTINUITY_CATEGORIES }, value: { type: "string" }, entryId: { type: "string" } },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false, required: ["action", "status", "record"],
        properties: { action: { type: "string", enum: ["show", "export", "add", "replace", "remove", "clear"] }, status: { type: "string", enum: ["shown", "exported", "added", "existing", "replaced", "removed", "absent", "cleared"] }, record: { type: "object" }, entry: { type: "object" }, exportJson: { type: "string" } },
      },
      render(_arguments, value) {
        const count = value.record.entries.length;
        return [{ type: "text", text: value.action === "export"
          ? `Exported ${count} user-controlled safety continuity entr${count === 1 ? "y" : "ies"}.`
          : `Human-safety continuity ${value.status}; ${count} entr${count === 1 ? "y" : "ies"} remain.` }];
      },
    },
    execute(arguments_, execution) {
      assertController(execution);
      const agent = execution.agent;
      if (!isUnknownRecord(arguments_)) throw new TypeError("arguments must be an object");
      const text = directUserText(options, agent);
      if (arguments_.action === "show") {
        const unquoted = unquotedRequest(text);
        requireCue(unquoted, READ_CUE, "show");
        requireCue(unquoted, SAFETY_SCOPE_CUE, "show");
        const record = publicRecord(readHumanSafetyContinuityStore(storePath));
        return Promise.resolve(Object.freeze({ action: "show", status: "shown", record }));
      }
      if (arguments_.action === "export") {
        const unquoted = unquotedRequest(text);
        requireCue(unquoted, EXPORT_CUE, "export");
        requireCue(unquoted, SAFETY_SCOPE_CUE, "export");
        const record = publicRecord(readHumanSafetyContinuityStore(storePath));
        return Promise.resolve(Object.freeze({ action: "export", status: "exported", record, exportJson: `${JSON.stringify(record, null, 2)}\n` }));
      }
      if (arguments_.action === "add") {
        if (!isCategory(arguments_.category)) throw new TypeError("category is required for add");
        const category = arguments_.category;
        const value = exactUserValue(arguments_, text);
        requireAffirmativeMutationCue(text, PERSIST_CUE, "add", value);
        requireSafetyContentScope(value, "add");
        const now = new Date().toISOString();
        const outcome = mutateHumanSafetyContinuityStore(storePath, (store) => {
          const existing = store.entries.find((entry) => entry.category === category && entry.value === value);
          if (existing) return { changed: false, status: "existing" as const, entry: existing };
          if (store.entries.length >= MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES) throw new Error(`human-safety continuity is limited to ${MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES} entries`);
          const entry = { id: randomUUID(), category, value, createdAt: now, updatedAt: now };
          store.entries.push(entry);
          return { changed: true, status: "added" as const, entry };
        });
        if (outcome.changed) onChanged(agent, { action: "add", category, entryId: outcome.entry.id });
        return Promise.resolve(Object.freeze({ action: "add", status: outcome.status, entry: outcome.entry, record: publicRecord(outcome.store) }));
      }
      if (arguments_.action === "replace") {
        if (typeof arguments_.entryId !== "string" || arguments_.entryId === "") throw new TypeError("entryId is required for replace");
        const entryId = arguments_.entryId;
        requireScopedReference(text, entryId);
        if (!isCategory(arguments_.category)) throw new TypeError("category is required for replace");
        const category = arguments_.category;
        const value = exactUserValue(arguments_, text);
        requireAffirmativeMutationCue(text, REPLACE_CUE, "replace", value);
        requireSafetyContentScope(value, "replace");
        const outcome = mutateHumanSafetyContinuityStore(storePath, (store) => {
          const index = store.entries.findIndex((entry) => entry.id === entryId);
          if (index < 0) return { changed: false, status: "absent" as const };
          const current = store.entries[index];
          if (!current) return { changed: false, status: "absent" as const };
          const entry = { ...current, category, value, updatedAt: new Date().toISOString() };
          store.entries[index] = entry;
          return { changed: current.category !== entry.category || current.value !== entry.value, status: "replaced" as const, entry };
        });
        if (outcome.changed) onChanged(agent, { action: "replace", category, entryId });
        const entry = "entry" in outcome ? outcome.entry : undefined;
        return Promise.resolve(Object.freeze({ action: "replace", status: outcome.status, ...(entry ? { entry } : {}), record: publicRecord(outcome.store) }));
      }
      if (arguments_.action === "remove") {
        const unquoted = requireAffirmativeDirectAction(text, REMOVE_CUE, "remove");
        if (typeof arguments_.entryId !== "string" || arguments_.entryId === "") throw new TypeError("entryId is required for remove");
        const entryId = arguments_.entryId;
        requireScopedReference(unquoted, entryId);
        const outcome = mutateHumanSafetyContinuityStore(storePath, (store) => {
          const index = store.entries.findIndex((entry) => entry.id === entryId);
          if (index < 0) return { changed: false, status: "absent" as const };
          const [entry] = store.entries.splice(index, 1);
          if (!entry) return { changed: false, status: "absent" as const };
          return { changed: true, status: "removed" as const, entry };
        });
        const entry = "entry" in outcome ? outcome.entry : undefined;
        if (outcome.changed && entry) onChanged(agent, { action: "remove", category: entry.category, entryId });
        return Promise.resolve(Object.freeze({ action: "remove", status: outcome.status, ...(entry ? { entry } : {}), record: publicRecord(outcome.store) }));
      }
      if (arguments_.action === "clear") {
        const unquoted = requireAffirmativeDirectAction(text, CLEAR_CUE, "clear");
        requireCue(unquoted, SAFETY_SCOPE_CUE, "clear");
        const outcome = clearHumanSafetyContinuityStore(storePath);
        if (outcome.changed) onChanged(agent, { action: "clear" });
        return Promise.resolve(Object.freeze({ action: "clear", status: "cleared", record: publicRecord(outcome.store) }));
      }
      throw new TypeError("action must be show, export, add, replace, remove, or clear");
    },
  };
}
