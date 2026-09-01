type ClientModule = Record<string | symbol, unknown>;
type ClientRequire = (id: string) => any;
type UnknownRecord = Record<string, any>;
type Role = "controller" | "researcher" | "planner" | "reviewer" | "frontend";
type Responsibility = Exclude<Role, "controller">;
type TraceState = "proposal" | "accepted" | "decision" | "direct" | "same-turn" | "child" | "handback" | "blocked" | "interrupted" | "configured" | "evidence";

interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

interface TraceItem {
  key: string;
  seq: number;
  time?: number;
  turn?: number;
  step?: number;
  type: string;
  role: Role;
  state: TraceState;
  title: string;
  detail: string;
  route?: ModelRoute;
  raw: unknown;
}

interface TraceGroup {
  key: string;
  turn?: number;
  title: string;
  items: readonly TraceItem[];
}

interface ProjectedTrace {
  items: readonly TraceItem[];
  turns: readonly TraceGroup[];
  currentTurn?: TraceGroup;
  currentRoles: Readonly<Record<Responsibility, TraceItem | undefined>>;
}

interface EvidenceSnapshot {
  events: readonly unknown[];
  revision?: string;
  unchanged: boolean;
}

interface RoutingConfig {
  roles?: Partial<Record<Responsibility, ModelRoute>>;
  sources?: Partial<Record<Responsibility, string>>;
  dispatch?: Partial<Record<Responsibility, string>>;
  dispatchSources?: Partial<Record<Responsibility, string>>;
  requiresNextTurn?: boolean;
}

type RoutingAction = UnknownRecord & { responsibility?: Responsibility };

declare global {
  interface Window {
    __ModuleLoader__: {
      load(registration: { id: string; factory(require_: ClientRequire): ClientModule }): void;
    };
  }

  var __DSH_BOOT__: { entries?: Array<{ id?: string }> } | undefined;
}

window.__ModuleLoader__.load({
  id: "__ODAI_CLIENT_PACKAGE__",
  factory: (require_) => {
    const module: { exports: ClientModule } = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require_("react");
    const ReactDOM = require_("react-dom");
    const { createElement: h, useEffect, useMemo, useRef, useState } = React;
    const PACKAGE_ID: string = "__ODAI_CLIENT_PACKAGE__";
    const ROLES: readonly Responsibility[] = Object.freeze(["researcher", "planner", "reviewer", "frontend"]);
    const ROLE_LABELS: Readonly<Record<Role, string>> = Object.freeze({
      controller: "总控",
      researcher: "调查",
      planner: "规划",
      reviewer: "审查",
      frontend: "设计",
    });
    const STATE_LABELS: Readonly<Record<TraceState, string>> = Object.freeze({
      proposal: "已提议",
      accepted: "已受理",
      decision: "路由决策",
      direct: "总控直办",
      "same-turn": "同轮职责",
      child: "子代理",
      handback: "已回交",
      blocked: "受阻",
      interrupted: "已中断",
      configured: "已配置",
      evidence: "证据",
    });
    const EVENT_BATCH_SIZE = 100;

    function record(value: unknown): UnknownRecord | undefined {
      return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
    }

    function text(value: unknown, fallback = ""): string {
      return typeof value === "string" && value.trim() ? value.trim() : fallback;
    }

    function positiveInteger(value: unknown): number | undefined {
      const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
      return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    }

    function roleOf(data?: UnknownRecord): Role {
      const value = data?.responsibility ?? data?.targetRole ?? data?.role ?? data?.from;
      return typeof value === "string" && ([...ROLES, "controller"] as string[]).includes(value) ? value as Role : "controller";
    }

    function stateOf(type: string, data?: UnknownRecord): TraceState {
      if (type === "odai/responsibility-gap") return "proposal";
      if (type === "odai/responsibility-gap-consumed") return "accepted";
      if (type === "odai/responsibility-gap-deferred" || type === "odai/route-protection") return "blocked";
      if (type === "odai/responsibility-returned") return "handback";
      if (type.includes("interruption") || type === "odai/controller-output-interrupted") return "interrupted";
      if (type === "odai/responsibility-scope-started" || type === "odai/responsibility-scope-claimed" || type === "odai/route-upgrade" || type === "odai/route-applied") return "same-turn";
      if (type === "odai/route-result") {
        if (data?.status === "fallback" || data?.status === "failed") return "blocked";
        return data?.action === "delegate" ? "child" : "direct";
      }
      if (type === "odai/route-fallback" || type === "odai/route-config-missing" || type === "odai/governance-denied") return "blocked";
      if (type === "odai/route-decided") return data?.action === "direct" ? "direct" : "decision";
      if (type.includes("configured")) return "configured";
      return "evidence";
    }

    function titleOf(type: string, data?: UnknownRecord): string {
      const role = ROLE_LABELS[roleOf(data)] ?? roleOf(data);
      switch (type) {
        case "odai/responsibility-gap": return `${role}职责缺口已提议`;
        case "odai/responsibility-gap-consumed": return `${role}提议已受理`;
        case "odai/responsibility-gap-deferred": return `${role}提议已暂缓`;
        case "odai/responsibility-returned": return `${role}已回交总控`;
        case "odai/responsibility-return-missing": return `${role}缺少回交`;
        case "odai/responsibility-scope-started": return `${role}职责已启动`;
        case "odai/responsibility-scope-claimed": return `${role}职责已接管`;
        case "odai/responsibility-scope-stopped": return `${role}职责已停止`;
        case "odai/route-decided": return `${role}路由已决策 · ${text(data?.action, "完成")}`;
        case "odai/route-upgrade": return `${role}已切换同轮职责`;
        case "odai/route-applied": return `${role}路由已应用`;
        case "odai/route-result": return `${role}执行结果 · ${text(data?.status, "完成")}`;
        case "odai/route-fallback": return `${role}路由已回退`;
        case "odai/route-config-missing": return `${role}路由不可用`;
        case "odai/routing-configured": return `${role}映射已配置`;
        case "odai/route-health": return `${role}路由健康检查`;
        case "odai/controller-output-interrupted": return "总控输出已中断";
        case "odai/responsibility-interrupted": return `${role}职责已中断`;
        default: return type.replace(/^odai\//u, "").replaceAll("-", " ");
      }
    }

    function detailOf(data?: UnknownRecord): string {
      const reason = typeof data?.reason === "string" ? data.reason : data?.reason?.kind;
      return text(data?.summary) || text(data?.gap) || text(data?.expectedChange) || text(data?.stopReason) || text(data?.reasonCode) || text(reason) || text(data?.status);
    }

    function routeOf(data?: UnknownRecord): ModelRoute | undefined {
      const route = record(data?.actualRoute ?? data?.requestedRoute ?? data?.effectiveRoute ?? data?.route);
      if (!route || !text(route.provider) || !text(route.model)) return undefined;
      return Object.freeze({
        provider: text(route.provider),
        model: text(route.model),
        reasoningEffort: text(route.reasoningEffort) || undefined,
        maxTokens: positiveInteger(route.maxTokens),
      });
    }

    function compact(value: unknown, depth = 0): unknown {
      if (depth >= 6) return "[truncated]";
      if (Array.isArray(value)) return value.slice(0, 80).map((entry): unknown => compact(entry, depth + 1));
      const input = record(value);
      if (!input) return typeof value === "string" && value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) {
        if (/token|secret|credential|api[-_]?key/iu.test(key)) output[key] = "[redacted]";
        else output[key] = compact(entry, depth + 1);
      }
      return output;
    }

    // Evidence logs are append-only, so boundary identity avoids an O(n) digest on every poll.
    function traceFingerprint(events: readonly unknown[] = []): string {
      const first = record(events.at(0));
      const last = record(events.at(-1));
      return [events.length, first?.seq ?? "", first?.type ?? "", last?.seq ?? "", last?.type ?? "", last?.time ?? ""].join(":");
    }

    function windowTurnItems<T extends { key: string }>(items: readonly T[], limit: number, selectedKey?: string): readonly T[] {
      const size = Math.max(1, limit);
      const tailStart = Math.max(0, items.length - size);
      const selectedIndex = selectedKey ? items.findIndex((item) => item.key === selectedKey) : -1;
      if (selectedIndex < 0 || selectedIndex >= tailStart) return items.slice(tailStart);
      const start = Math.max(0, Math.min(selectedIndex - Math.floor(size / 2), items.length - size));
      return items.slice(start, start + size);
    }

    function projectTrace(events: readonly unknown[] = []): ProjectedTrace {
      const items: TraceItem[] = [];
      const turns = new Map<string, { key: string; turn?: number; items: TraceItem[] }>();
      for (const [index, eventValue] of events.entries()) {
        const event = record(eventValue);
        const type = text(event?.type);
        if (!type.startsWith("odai/")) continue;
        const data = record(event?.data) ?? {};
        const turn = positiveInteger(data.turn);
        const item: TraceItem = Object.freeze({
          key: `${event?.seq ?? index}:${type}`,
          seq: Number.isSafeInteger(event?.seq) ? Number(event?.seq) : index,
          time: typeof event?.time === "number" ? event.time : undefined,
          turn,
          step: positiveInteger(data.step),
          type,
          role: roleOf(data),
          state: stateOf(type, data),
          title: titleOf(type, data),
          detail: detailOf(data),
          route: routeOf(data),
          raw: data,
        });
        items.push(item);
        const key = turn === undefined ? "session" : `turn-${turn}`;
        if (!turns.has(key)) turns.set(key, { key, turn, items: [] });
        turns.get(key)?.items.push(item);
      }
      const groups: TraceGroup[] = [...turns.values()].map((group) => Object.freeze({
        ...group,
        title: group.turn === undefined ? "会话级事件" : `第 ${group.turn} 轮`,
        items: Object.freeze(group.items),
      })).sort((left, right) => (left.turn ?? -1) - (right.turn ?? -1));
      const currentTurn = [...groups].reverse().find((group) => group.turn !== undefined) ?? groups.at(-1);
      const currentRoles = Object.fromEntries(ROLES.map((role): [Responsibility, TraceItem | undefined] => {
        const roleItems = currentTurn?.items.filter((item) => item.role === role) ?? [];
        return [role, roleItems.at(-1)];
      })) as Record<Responsibility, TraceItem | undefined>;
      return Object.freeze({ items: Object.freeze(items), turns: Object.freeze(groups), currentTurn, currentRoles: Object.freeze(currentRoles) });
    }

    function formatTime(value: unknown): string {
      if (typeof value !== "number") return "—";
      try {
        return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
      } catch {
        return "—";
      }
    }

    function formatRoute(route?: ModelRoute): string {
      if (!route) return "未配置";
      const extras = [route.reasoningEffort, route.maxTokens ? `${route.maxTokens} tokens` : ""].filter(Boolean);
      return `${route.provider}/${route.model}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
    }

    function sourceLabel(source: unknown, fallback = "部署默认"): string {
      if (source === "persisted-mapping" || source === "persisted-config") return "本地持久配置";
      if (source === "deployment-config") return "部署配置";
      return fallback;
    }

    function dispatchLabel(value: string): string {
      return ({ default: "部署默认", "same-turn": "同轮职责", child: "子代理" } as Record<string, string>)[value] ?? value;
    }

    async function callRouting(connection: any, payload: unknown, signal?: AbortSignal): Promise<RoutingConfig> {
      const response = await connection.rpc.call("/odai-control-center", "routing", payload, signal);
      if (!response?.ok) throw new Error(response?.error?.message || "Control Center RPC failed");
      if (!response.value?.ok) throw new Error(response.value?.error?.message || "Routing configuration failed");
      return response.value.config;
    }

    async function callEvidence(connection: any, sessionId: string, revision?: string, signal?: AbortSignal): Promise<EvidenceSnapshot> {
      const request = async (payload: UnknownRecord): Promise<UnknownRecord> => {
        const response = await connection.rpc.call("/odai-control-center", "evidence", payload, signal);
        if (!response?.ok) throw new Error(response?.error?.message || "Control Center evidence RPC failed");
        if (!response.value?.ok) throw new Error(response.value?.error?.message || "Session evidence could not be read");
        return response.value;
      };
      let value: UnknownRecord;
      try {
        value = await request({ sessionId, ...(revision ? { revision } : {}) });
      } catch (cause) {
        if (!revision || !/requires only a non-empty sessionId/iu.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
        value = await request({ sessionId });
      }
      return {
        events: Array.isArray(value.events) ? value.events : [],
        revision: text(value.revision) || undefined,
        unchanged: value.unchanged === true,
      };
    }

    function controlCenterError(cause: unknown): string {
      const message = cause instanceof Error ? cause.message : String(cause);
      return /HTTP 405|transport failure.*odai-control-center/iu.test(message)
        ? "当前 DSH 进程尚未加载 Control Center host。安装后需重启一次 Web profile。"
        : message;
    }

    function GraphIcon() {
      return h("span", { className: "odaiCC__graphIcon", "aria-hidden": true },
        h("i", { className: "odaiCC__graphNode odaiCC__graphNode--a" }),
        h("i", { className: "odaiCC__graphLine" }),
        h("i", { className: "odaiCC__graphNode odaiCC__graphNode--b" }),
        h("i", { className: "odaiCC__graphNode odaiCC__graphNode--c" }),
      );
    }

    function RoleBadge({ role }: { role: Role }) {
      return h("span", { className: `odaiCC__role odaiCC__role--${role}` },
        h("i", { "aria-hidden": true }),
        ROLE_LABELS[role] ?? role,
      );
    }

    function StateBadge({ state }: { state: TraceState }) {
      return h("span", { className: `odaiCC__state odaiCC__state--${state}` }, STATE_LABELS[state] ?? state);
    }

    function EventRow({ item, selected, onSelect }: { item: TraceItem; selected: boolean; onSelect(key: string): void }) {
      return h("button", {
        type: "button",
        className: `odaiCC__event${selected ? " is-selected" : ""}`,
        onClick: () => onSelect(item.key),
        "aria-pressed": selected,
      },
        h("span", { className: "odaiCC__eventTop" },
          h("code", null, `#${item.seq}`),
          h(StateBadge, { state: item.state }),
          h("time", null, formatTime(item.time)),
        ),
        h("strong", null, item.title),
        item.detail ? h("span", { className: "odaiCC__eventDetail" }, item.detail) : null,
        h("span", { className: "odaiCC__eventBottom" },
          h(RoleBadge, { role: item.role }),
          item.turn ? h("span", null, `第 ${item.turn} 轮${item.step ? ` / 第 ${item.step} 步` : ""}`) : h("span", null, "会话"),
        ),
      );
    }

    function FlowBoard({ trace, onSelect }: { trace: ProjectedTrace; onSelect(key: string): void }) {
      const turn = trace.currentTurn;
      return h("section", { className: "odaiCC__flow" },
        h("div", { className: "odaiCC__sectionHead" },
          h("div", null, h("span", { className: "odaiCC__kicker" }, "当前轮次"), h("h3", null, turn?.title ?? "暂无轮次证据")),
          h("span", { className: "odaiCC__eventCount" }, `${turn?.items.length ?? 0} 个事件`),
        ),
        h("div", { className: "odaiCC__flowGrid" },
          h("div", { className: "odaiCC__controllerNode" },
            h("span", { className: "odaiCC__nodeEyebrow" }, "总控"),
            h("strong", null, "Odai Controller"),
            h("small", null, turn ? "当前会话的交付责任方" : "等待职责证据"),
          ),
          h("div", { className: "odaiCC__roleStack" }, ROLES.map((role) => {
            const item = trace.currentRoles[role];
            const state = item?.state ?? "evidence";
            return h("button", {
              key: role,
              type: "button",
              className: `odaiCC__flowRole odaiCC__flowRole--${state}`,
              onClick: () => item && onSelect(item.key),
              disabled: !item,
            },
              h("span", { className: "odaiCC__edge", "data-state": state }, h("i"), h("em", null, item ? STATE_LABELS[state] ?? state : "未触发")),
              h("span", { className: "odaiCC__roleNode" },
                h(RoleBadge, { role }),
                h("strong", null, item?.title ?? "暂无执行证据"),
                h("small", null, item?.route ? formatRoute(item.route) : item?.detail || "—"),
              ),
            );
          })),
        ),
      );
    }

    function Timeline({ trace, selectedKey, onSelect }: { trace: ProjectedTrace; selectedKey?: string; onSelect(key: string): void }) {
      const [expandedKey, setExpandedKey] = useState(() => trace.currentTurn?.key);
      const [visibleCount, setVisibleCount] = useState(EVENT_BATCH_SIZE);
      useEffect(() => {
        if (!selectedKey) return;
        const item = trace.items.find((entry) => entry.key === selectedKey);
        const groupKey = item?.turn === undefined ? "session" : `turn-${item.turn}`;
        if (item && groupKey !== expandedKey) {
          setExpandedKey(groupKey);
          setVisibleCount(EVENT_BATCH_SIZE);
        }
      }, [selectedKey]);
      useEffect(() => {
        if (expandedKey && !trace.turns.some((turn) => turn.key === expandedKey)) {
          setExpandedKey(trace.currentTurn?.key);
          setVisibleCount(EVENT_BATCH_SIZE);
        }
      }, [trace.turns, trace.currentTurn?.key, expandedKey]);

      return h("section", { className: "odaiCC__timeline" },
        h("div", { className: "odaiCC__sectionHead" }, h("h3", null, "会话时间线"), h("span", { className: "odaiCC__eventCount" }, `${trace.items.length} 个事件`)),
        trace.turns.length ? h("div", { className: "odaiCC__turns" }, trace.turns.map((turn) => {
          const expanded = turn.key === expandedKey;
          const visibleItems = expanded ? windowTurnItems(turn.items, visibleCount, selectedKey) : [];
          const hiddenCount = Math.max(0, turn.items.length - visibleItems.length);
          return h("details", {
            key: turn.key,
            open: expanded,
            className: "odaiCC__turn",
            onToggle: (event: { currentTarget: { open: boolean } }) => {
              if (event.currentTarget.open) {
                setExpandedKey(turn.key);
                setVisibleCount(EVENT_BATCH_SIZE);
              } else {
                setExpandedKey((value: string | undefined) => value === turn.key ? undefined : value);
              }
            },
          },
            h("summary", null, h("strong", null, turn.title), h("span", null, `${turn.items.length} 个事件`)),
            expanded ? h("div", { className: "odaiCC__events" },
              hiddenCount ? h("button", {
                type: "button",
                className: "odaiCC__loadEarlier",
                onClick: () => setVisibleCount((count: number) => count + EVENT_BATCH_SIZE),
              }, `加载更早的 ${Math.min(EVENT_BATCH_SIZE, hiddenCount)} 条`) : null,
              visibleItems.map((item) => h(EventRow, {
                key: item.key,
                item,
                selected: selectedKey === item.key,
                onSelect,
              })),
            ) : null,
          );
        })) : h("div", { className: "odaiCC__empty" }, "当前会话窗口中还没有 Odai 职责证据。"),
      );
    }

    function Inspector({ item }: { item?: TraceItem }) {
      const raw = useMemo(() => item ? JSON.stringify(compact(item.raw), null, 2) : "", [item]);
      return h("aside", { className: "odaiCC__inspector" },
        h("div", { className: "odaiCC__sectionHead" }, h("h3", null, "事件检查器"), item ? h("code", null, `#${item.seq}`) : null),
        item ? h(React.Fragment, null,
          h("dl", { className: "odaiCC__facts" },
            h("div", null, h("dt", null, "类型"), h("dd", null, h("code", null, item.type))),
            h("div", null, h("dt", null, "状态"), h("dd", null, h(StateBadge, { state: item.state }))),
            h("div", null, h("dt", null, "责任方"), h("dd", null, h(RoleBadge, { role: item.role }))),
            h("div", null, h("dt", null, "模型路由"), h("dd", null, formatRoute(item.route))),
          ),
          h("pre", { className: "odaiCC__raw" }, raw),
        ) : h("div", { className: "odaiCC__empty" }, "选择一条事件查看结构化证据。"),
      );
    }

    function LiveView({ trace, evidenceError }: { trace: ProjectedTrace; evidenceError: string }) {
      const [selectedKey, setSelectedKey] = useState(() => trace.items.at(-1)?.key);
      useEffect(() => {
        if (!trace.items.some((item) => item.key === selectedKey)) setSelectedKey(trace.items.at(-1)?.key);
      }, [trace.items, selectedKey]);
      const selected = trace.items.find((item) => item.key === selectedKey) ?? trace.items.at(-1);
      return h("div", { className: "odaiCC__live" },
        evidenceError ? h("div", { className: "odaiCC__alert is-error", role: "alert" }, evidenceError) : null,
        h(FlowBoard, { trace, onSelect: setSelectedKey }),
        h("div", { className: "odaiCC__evidenceGrid" },
          h(Timeline, { trace, selectedKey: selected?.key, onSelect: setSelectedKey }),
          h(Inspector, { item: selected }),
        ),
      );
    }

    function RouteEditor({ role, config, busy, onApply }: { role: Responsibility; config: RoutingConfig; busy: boolean; onApply(payload: RoutingAction): Promise<RoutingConfig> }) {
      const route = config?.roles?.[role];
      const source = config?.sources?.[role];
      const dispatch = config?.dispatch?.[role];
      const dispatchSource = config?.dispatchSources?.[role];
      const [editing, setEditing] = useState(false);
      const [provider, setProvider] = useState(route?.provider ?? "");
      const [model, setModel] = useState(route?.model ?? "");
      const [effort, setEffort] = useState(route?.reasoningEffort ?? "");
      const [maxTokens, setMaxTokens] = useState(route?.maxTokens ? String(route.maxTokens) : "");

      useEffect(() => {
        if (editing) return;
        setProvider(route?.provider ?? "");
        setModel(route?.model ?? "");
        setEffort(route?.reasoningEffort ?? "");
        setMaxTokens(route?.maxTokens ? String(route.maxTokens) : "");
      }, [route, editing]);

      const save = () => onApply({
        action: "set",
        responsibility: role,
        provider,
        model,
        ...(effort.trim() ? { reasoningEffort: effort.trim() } : {}),
        ...(maxTokens.trim() ? { maxTokens: Number(maxTokens) } : {}),
      }).then(() => setEditing(false));
      const remove = () => {
        if (!window.confirm(`确认移除“${ROLE_LABELS[role]}”的本地模型映射？`)) return;
        onApply({ action: "remove", responsibility: role });
      };
      const setDispatch = (value: string) => {
        if (value === "default") onApply({ action: "reset-dispatch", responsibility: role });
        else onApply({ action: "set-dispatch", responsibility: role, dispatch: value });
      };

      return h("article", { className: "odaiCC__routeRow" },
        h("div", { className: "odaiCC__routeSummary" },
          h(RoleBadge, { role }),
          h("div", { className: "odaiCC__routeValue" },
            h("strong", null, formatRoute(route)),
            h("span", null, sourceLabel(source)),
          ),
          h("button", { type: "button", className: "odaiCC__quietButton", onClick: () => setEditing((value: boolean) => !value), disabled: busy }, editing ? "取消" : "编辑"),
        ),
        h("div", { className: "odaiCC__dispatch" },
          h("span", null, "调度方式"),
          h("div", { className: "odaiCC__segments", role: "group", "aria-label": `${ROLE_LABELS[role]}调度方式` }, ["default", "same-turn", "child"].map((value) => h("button", {
            key: value,
            type: "button",
            className: (dispatch ?? "default") === value ? "is-active" : "",
            onClick: () => setDispatch(value),
            disabled: busy,
          }, dispatchLabel(value)))),
          h("small", null, sourceLabel(dispatchSource, "兼容默认")),
        ),
        editing ? h("div", { className: "odaiCC__routeForm" },
          h("label", null, h("span", null, "Provider"), h("input", { value: provider, onChange: (event: { target: { value: string } }) => setProvider(event.target.value), placeholder: "Provider ID", disabled: busy })),
          h("label", null, h("span", null, "模型"), h("input", { value: model, onChange: (event: { target: { value: string } }) => setModel(event.target.value), placeholder: "模型 ID", disabled: busy })),
          h("label", null, h("span", null, "推理档位"), h("input", { value: effort, onChange: (event: { target: { value: string } }) => setEffort(event.target.value), placeholder: "可选", disabled: busy })),
          h("label", null, h("span", null, "最大 tokens"), h("input", { value: maxTokens, onChange: (event: { target: { value: string } }) => setMaxTokens(event.target.value), inputMode: "numeric", placeholder: "可选", disabled: busy })),
          h("div", { className: "odaiCC__formActions" },
            route ? h("button", { type: "button", className: "odaiCC__dangerButton", onClick: remove, disabled: busy }, "移除映射") : null,
            h("button", { type: "button", className: "odaiCC__primaryButton", onClick: save, disabled: busy || !provider.trim() || !model.trim() || (maxTokens.trim() && !positiveInteger(maxTokens)) }, busy ? "正在验证…" : "验证并保存"),
          ),
        ) : null,
      );
    }

    function RoutingView({ connection, config, setConfig, loading, error, reload }: { connection: any; config?: RoutingConfig; setConfig(value: RoutingConfig): void; loading: boolean; error: string; reload(): Promise<void> }) {
      const [busyRole, setBusyRole] = useState(undefined);
      const [notice, setNotice] = useState("");
      const apply = async (payload: RoutingAction): Promise<RoutingConfig> => {
        setBusyRole(payload.responsibility);
        setNotice("");
        try {
          const next = await callRouting(connection, payload);
          setConfig(next);
          setNotice(next.requiresNextTurn ? "已保存，将从下一次用户轮次开始生效。" : "配置已加载。");
          return next;
        } catch (cause) {
          setNotice(controlCenterError(cause));
          throw cause;
        } finally {
          setBusyRole(undefined);
        }
      };

      return h("div", { className: "odaiCC__routing" },
        h("div", { className: "odaiCC__routingHead" },
          h("div", null, h("span", { className: "odaiCC__kicker" }, "职责路由"), h("h3", null, "模型与调度")),
          h("button", { type: "button", className: "odaiCC__quietButton", onClick: reload, disabled: loading }, loading ? "正在加载…" : "刷新"),
        ),
        error ? h("div", { className: "odaiCC__alert is-error", role: "alert" }, error) : null,
        notice ? h("div", { className: `odaiCC__alert${/已保存|已加载/u.test(notice) ? " is-success" : " is-error"}`, role: "status" }, notice) : null,
        h("div", { className: "odaiCC__controllerLock" },
          h(RoleBadge, { role: "controller" }),
          h("div", null, h("strong", null, "宿主管理的基础路由"), h("span", null, "总控模型由 DSH 会话配置管理，不属于 Odai 职责映射。")),
          h("span", { className: "odaiCC__lock" }, "只读"),
        ),
        config ? h("div", { className: "odaiCC__routeList" }, ROLES.map((role) => h(RouteEditor, {
          key: role,
          role,
          config,
          busy: busyRole === role,
          onApply: apply,
        }))) : loading ? h("div", { className: "odaiCC__empty" }, "正在加载路由配置…") : null,
      );
    }

    function ControlCenter({ useSession, connection, onClose }: { useSession: any; connection: any; onClose(): void }) {
      const sessionId = useSession((snapshot: any) => snapshot.sessionId) as string | undefined;
      const traceView = useSession((snapshot: any) => snapshot.views.get("odaiControlCenter") ?? { events: [] }) as { events?: unknown[] };
      const [storedEvidence, setStoredEvidence] = useState([]);
      const [evidenceError, setEvidenceError] = useState("");
      const traceEvents = storedEvidence.length ? storedEvidence : traceView.events ?? [];
      const trace = useMemo(() => projectTrace(traceEvents), [traceEvents]);
      const [tab, setTab] = useState("live");
      const [config, setConfig] = useState(undefined);
      const [loading, setLoading] = useState(false);
      const [routingAttempted, setRoutingAttempted] = useState(false);
      const [error, setError] = useState("");
      const closeRef = useRef(null);
      const evidenceFingerprintRef = useRef(traceFingerprint(traceEvents));
      const evidenceRevisionRef = useRef(undefined as string | undefined);

      const reload = async () => {
        setRoutingAttempted(true);
        setLoading(true);
        setError("");
        try {
          setConfig(await callRouting(connection, { action: "show" }));
        } catch (cause) {
          setError(controlCenterError(cause));
        } finally {
          setLoading(false);
        }
      };
      useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
          if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        closeRef.current?.focus();
        return () => document.removeEventListener("keydown", onKey);
      }, [onClose]);
      useEffect(() => {
        setStoredEvidence([]);
        evidenceFingerprintRef.current = traceFingerprint(traceView.events ?? []);
        evidenceRevisionRef.current = undefined;
      }, [sessionId]);
      useEffect(() => {
        if (!sessionId || tab !== "live") return undefined;
        const controller = new AbortController();
        let active = true;
        let refreshing = false;
        const refreshEvidence = async () => {
          if (refreshing || document.hidden) return;
          refreshing = true;
          try {
            const snapshot = await callEvidence(connection, sessionId, evidenceRevisionRef.current, controller.signal);
            if (active) {
              evidenceRevisionRef.current = snapshot.revision;
              if (!snapshot.unchanged) {
                const fingerprint = traceFingerprint(snapshot.events);
                if (fingerprint !== evidenceFingerprintRef.current) {
                  evidenceFingerprintRef.current = fingerprint;
                  setStoredEvidence(snapshot.events);
                }
              }
              setEvidenceError("");
            }
          } catch (cause) {
            if (active && !controller.signal.aborted) setEvidenceError(controlCenterError(cause));
          } finally {
            refreshing = false;
          }
        };
        const initialTimer = window.setTimeout(refreshEvidence, 0);
        const timer = window.setInterval(refreshEvidence, 1_500);
        return () => {
          active = false;
          controller.abort();
          window.clearTimeout(initialTimer);
          window.clearInterval(timer);
        };
      }, [connection, sessionId, tab]);
      useEffect(() => {
        if (tab === "routing" && !routingAttempted) void reload();
      }, [tab, routingAttempted]);

      return ReactDOM.createPortal(h("div", { className: "odaiCC", "data-odai-control-center": PACKAGE_ID },
        h("button", { type: "button", className: "odaiCC__backdrop", onClick: onClose, "aria-label": "关闭 Odai 控制中心" }),
        h("section", { className: "odaiCC__drawer", role: "dialog", "aria-modal": true, "aria-label": "Odai 控制中心" },
          h("header", { className: "odaiCC__header" },
            h("div", { className: "odaiCC__brand" }, h(GraphIcon), h("div", null, h("h2", null, "Odai 控制中心"), h("span", null, "会话证据 · 路由配置"))),
            h("nav", { className: "odaiCC__tabs", "aria-label": "控制中心视图" },
              h("button", { type: "button", className: tab === "live" ? "is-active" : "", onClick: () => setTab("live") }, "执行"),
              h("button", { type: "button", className: tab === "routing" ? "is-active" : "", onClick: () => setTab("routing") }, "路由"),
            ),
            h("button", { ref: closeRef, type: "button", className: "odaiCC__close", onClick: onClose, "aria-label": "关闭" }, "×"),
          ),
          h("main", { className: "odaiCC__body" }, tab === "live"
            ? h(LiveView, { trace, evidenceError })
            : h(RoutingView, { connection, config, setConfig, loading, error, reload })),
        ),
      ), document.body);
    }

    function Launcher(props: { useSession: any; connection: any }) {
      const [open, setOpen] = useState(false);
      return h(React.Fragment, null,
        h("button", {
          type: "button",
          className: "odaiCC__launcher",
          onClick: () => setOpen(true),
          title: "Odai 控制中心",
          "aria-label": "打开 Odai 控制中心",
          "aria-expanded": open,
        }, h(GraphIcon), h("span", null, "控制")),
        open ? h(ControlCenter, { ...props, onClose: () => setOpen(false) }) : null,
      );
    }

    function injectStyles() {
      const styleId = "odai-control-center/client.css";
      if (document.querySelector(`style[data-plugin-css="${styleId}"]`)) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = PACKAGE_ID;
      tag.dataset.pluginCss = styleId;
      tag.textContent = `
.odaiCC__launcher,.odaiCC{--odai-cc-bg:#f5f7fa;--odai-cc-panel:#fff;--odai-cc-surface:#f8fafc;--odai-cc-surface-2:#edf1f5;--odai-cc-text:#151922;--odai-cc-text-2:#4c5665;--odai-cc-text-3:#778190;--odai-cc-border:#d8dee7;--odai-cc-border-strong:#bdc6d2;--odai-cc-hover:#edf3ff;--odai-cc-accent:#2f6feb}
.odaiCC__launcher{box-sizing:border-box;height:28px;border:1px solid var(--odai-cc-border);border-radius:6px;background:transparent;color:var(--odai-cc-text-2);display:inline-flex;align-items:center;gap:6px;padding:0 8px;cursor:pointer;font:600 11px/1 inherit;letter-spacing:0}.odaiCC__launcher:hover{background:var(--odai-cc-hover);color:var(--odai-cc-text)}
.odaiCC__graphIcon{position:relative;width:17px;height:15px;display:inline-block;flex:none}.odaiCC__graphNode{position:absolute;width:5px;height:5px;border:1.5px solid currentColor;border-radius:50%;box-sizing:border-box}.odaiCC__graphNode--a{left:0;top:5px}.odaiCC__graphNode--b{right:0;top:0}.odaiCC__graphNode--c{right:0;bottom:0}.odaiCC__graphLine{position:absolute;left:5px;top:7px;width:7px;height:1px;background:currentColor}.odaiCC__graphLine:before,.odaiCC__graphLine:after{content:"";position:absolute;right:0;width:5px;height:1px;background:currentColor;transform-origin:right center}.odaiCC__graphLine:before{transform:rotate(-38deg)}.odaiCC__graphLine:after{transform:rotate(38deg)}
.odaiCC{position:fixed;inset:0;z-index:120;color:var(--odai-cc-text);font-family:inherit;letter-spacing:0}.odaiCC *{box-sizing:border-box}.odaiCC__backdrop{position:absolute;inset:0;border:0;background:rgba(0,0,0,.28)}.odaiCC__drawer{position:absolute;inset:14px;max-width:1180px;margin-left:auto;border:1px solid var(--odai-cc-border-strong);border-radius:8px;background:var(--odai-cc-panel);box-shadow:0 24px 80px rgba(0,0,0,.42);display:flex;flex-direction:column;overflow:hidden}.odaiCC__header{min-height:62px;border-bottom:1px solid var(--odai-cc-border);display:grid;grid-template-columns:minmax(230px,1fr) auto minmax(44px,1fr);align-items:center;gap:16px;padding:10px 14px}.odaiCC__brand{display:flex;align-items:center;gap:10px;min-width:0}.odaiCC__brand>.odaiCC__graphIcon{width:22px;height:19px;color:var(--odai-cc-accent)}.odaiCC__brand h2{font-size:15px;line-height:20px;margin:0}.odaiCC__brand span{display:block;color:var(--odai-cc-text-3);font-size:10px;line-height:15px}.odaiCC__tabs{display:flex;border:1px solid var(--odai-cc-border);border-radius:6px;padding:2px;background:var(--odai-cc-surface)}.odaiCC__tabs button{height:28px;min-width:72px;border:0;border-radius:4px;background:transparent;color:var(--odai-cc-text-3);cursor:pointer;font:600 11px/1 inherit}.odaiCC__tabs button.is-active{background:var(--odai-cc-panel);color:var(--odai-cc-text);box-shadow:0 1px 4px rgba(0,0,0,.2)}.odaiCC__close{justify-self:end;width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:var(--odai-cc-text-2);font-size:22px;line-height:1;cursor:pointer}.odaiCC__close:hover{background:var(--odai-cc-hover)}.odaiCC__body{min-height:0;flex:1;overflow:auto}.odaiCC__live{padding:14px}.odaiCC__kicker{display:block;color:var(--odai-cc-text-3);font:700 9px/14px inherit;letter-spacing:.08em}.odaiCC__sectionHead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}.odaiCC__sectionHead h3{font-size:12px;line-height:18px;margin:0}.odaiCC__eventCount{color:var(--odai-cc-text-3);font-size:10px}.odaiCC__flow{border:1px solid var(--odai-cc-border);border-radius:8px;background:var(--odai-cc-surface);padding:12px}.odaiCC__flowGrid{display:grid;grid-template-columns:minmax(160px,220px) minmax(360px,1fr);gap:22px;align-items:center;min-height:265px}.odaiCC__controllerNode{border:1px solid rgba(119,167,255,.45);border-radius:8px;background:rgba(119,167,255,.08);padding:18px}.odaiCC__controllerNode strong,.odaiCC__roleNode strong{display:block;font-size:12px;line-height:18px}.odaiCC__controllerNode small,.odaiCC__roleNode small{display:block;color:var(--odai-cc-text-3);font-size:10px;line-height:15px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.odaiCC__nodeEyebrow{color:#2f6feb;font-size:9px;font-weight:700}.odaiCC__roleStack{display:flex;flex-direction:column;gap:8px}.odaiCC__flowRole{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;border:0;background:transparent;color:inherit;padding:0;text-align:left}.odaiCC__flowRole:not(:disabled){cursor:pointer}.odaiCC__flowRole:disabled{opacity:1}.odaiCC__edge{position:relative;height:1px;background:var(--odai-cc-border-strong);margin-right:12px}.odaiCC__edge i{position:absolute;right:-1px;top:-3px;width:7px;height:7px;border-top:1px solid currentColor;border-right:1px solid currentColor;transform:rotate(45deg)}.odaiCC__edge em{position:absolute;left:5px;top:-17px;color:var(--odai-cc-text-3);font:500 9px/12px inherit;font-style:normal}.odaiCC__edge[data-state=proposal],.odaiCC__edge[data-state=decision]{background:repeating-linear-gradient(90deg,#65c6b8 0 5px,transparent 5px 9px);color:#65c6b8}.odaiCC__edge[data-state=same-turn]{background:#b99cff;color:#b99cff}.odaiCC__edge[data-state=child]{background:var(--odai-cc-accent);color:var(--odai-cc-accent)}.odaiCC__edge[data-state=handback]{background:#f1bb61;color:#f1bb61}.odaiCC__edge[data-state=blocked],.odaiCC__edge[data-state=interrupted]{background:#ef7e78;color:#ef7e78}.odaiCC__roleNode{border:1px solid var(--odai-cc-border);border-radius:7px;background:var(--odai-cc-panel);padding:8px 10px;min-width:0}.odaiCC__flowRole:not(:disabled):hover .odaiCC__roleNode{border-color:var(--odai-cc-accent)}.odaiCC__role{display:inline-flex;align-items:center;gap:5px;color:var(--odai-cc-text-2);font-size:9px;line-height:14px}.odaiCC__role i{width:6px;height:6px;border-radius:50%;background:#8f969e}.odaiCC__role--controller i{background:var(--odai-cc-accent)}.odaiCC__role--researcher i{background:#65c6b8}.odaiCC__role--planner i{background:#b99cff}.odaiCC__role--reviewer i{background:#f1bb61}.odaiCC__role--frontend i{background:#ef8fbd}.odaiCC__evidenceGrid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:12px;margin-top:12px}.odaiCC__timeline,.odaiCC__inspector{min-width:0;border:1px solid var(--odai-cc-border);border-radius:8px;background:var(--odai-cc-surface);padding:10px}.odaiCC__turn{border-top:1px solid var(--odai-cc-border);padding:8px 0}.odaiCC__turn:first-child{border-top:0;padding-top:0}.odaiCC__turn summary{display:flex;justify-content:space-between;gap:10px;cursor:pointer;list-style:none;font-size:10px}.odaiCC__turn summary::-webkit-details-marker{display:none}.odaiCC__turn summary span{color:var(--odai-cc-text-3)}.odaiCC__events{display:flex;flex-direction:column;gap:6px;margin-top:8px}.odaiCC__event{width:100%;border:1px solid var(--odai-cc-border);border-radius:7px;background:var(--odai-cc-panel);color:inherit;padding:8px;text-align:left;cursor:pointer}.odaiCC__event:hover,.odaiCC__event.is-selected{border-color:var(--odai-cc-accent);background:var(--odai-cc-hover)}.odaiCC__eventTop{display:flex;align-items:center;gap:6px;color:var(--odai-cc-text-3);font-size:9px}.odaiCC__eventTop time{margin-left:auto}.odaiCC__eventTop code{font-size:9px}.odaiCC__event>strong{display:block;margin-top:5px;font-size:11px;line-height:16px}.odaiCC__eventDetail{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--odai-cc-text-2);font-size:10px;line-height:15px;margin-top:2px}.odaiCC__eventBottom{display:flex;gap:8px;align-items:center;color:var(--odai-cc-text-3);font-size:9px;margin-top:6px}.odaiCC__state{display:inline-flex;border-radius:999px;background:var(--odai-cc-surface-2);color:var(--odai-cc-text-2);padding:1px 6px;font-size:9px;line-height:13px}.odaiCC__state--proposal{background:rgba(101,198,184,.15);color:#18756b}.odaiCC__state--same-turn{background:rgba(185,156,255,.15);color:#6f42c1}.odaiCC__state--child{background:rgba(119,167,255,.15);color:#245ec7}.odaiCC__state--handback{background:rgba(241,187,97,.15);color:#946000}.odaiCC__state--blocked,.odaiCC__state--interrupted{background:rgba(239,126,120,.15);color:#b42318}.odaiCC__facts{margin:0;display:flex;flex-direction:column;gap:7px}.odaiCC__facts>div{display:grid;grid-template-columns:56px minmax(0,1fr);gap:8px;font-size:10px}.odaiCC__facts dt{color:var(--odai-cc-text-3)}.odaiCC__facts dd{margin:0;overflow-wrap:anywhere}.odaiCC__facts code{font-size:9px}.odaiCC__raw{max-height:360px;overflow:auto;border:1px solid var(--odai-cc-border);border-radius:7px;background:var(--odai-cc-panel);color:var(--odai-cc-text-2);font:9px/14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px;margin:10px 0 0}.odaiCC__empty{border:1px dashed var(--odai-cc-border-strong);border-radius:7px;color:var(--odai-cc-text-3);font-size:10px;line-height:16px;padding:18px;text-align:center}
.odaiCC__routing{max-width:920px;margin:0 auto;padding:18px}.odaiCC__routingHead{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.odaiCC__routingHead h3{font-size:14px;margin:0}.odaiCC__quietButton,.odaiCC__primaryButton,.odaiCC__dangerButton{height:28px;border-radius:6px;padding:0 10px;font:600 10px/1 inherit;cursor:pointer}.odaiCC__quietButton{border:1px solid var(--odai-cc-border);background:transparent;color:var(--odai-cc-text-2)}.odaiCC__primaryButton{border:1px solid var(--odai-cc-accent);background:var(--odai-cc-accent);color:#fff}.odaiCC__dangerButton{border:1px solid rgba(239,126,120,.45);background:transparent;color:#b42318}.odaiCC button:disabled:not(.odaiCC__flowRole){opacity:.45;cursor:default}.odaiCC__flowRole:disabled{opacity:1;cursor:default}.odaiCC__alert{border:1px solid var(--odai-cc-border);border-radius:7px;padding:8px 10px;font-size:10px;line-height:15px;margin-bottom:10px}.odaiCC__alert.is-error{border-color:rgba(239,126,120,.4);background:rgba(239,126,120,.08);color:#b42318}.odaiCC__alert.is-success{border-color:rgba(101,198,184,.4);background:rgba(101,198,184,.08);color:#18756b}.odaiCC__controllerLock,.odaiCC__routeRow{border-top:1px solid var(--odai-cc-border);padding:12px 0}.odaiCC__controllerLock{display:grid;grid-template-columns:120px minmax(0,1fr) auto;gap:12px;align-items:center}.odaiCC__controllerLock strong{display:block;font-size:11px}.odaiCC__controllerLock span:not(.odaiCC__role):not(.odaiCC__lock){display:block;color:var(--odai-cc-text-3);font-size:10px}.odaiCC__lock{border:1px solid var(--odai-cc-border);border-radius:999px;color:var(--odai-cc-text-3);font-size:9px;padding:3px 7px}.odaiCC__routeSummary{display:grid;grid-template-columns:120px minmax(0,1fr) auto;gap:12px;align-items:center}.odaiCC__routeValue strong{display:block;font-size:11px;overflow-wrap:anywhere}.odaiCC__routeValue span{display:block;color:var(--odai-cc-text-3);font-size:9px;margin-top:2px}.odaiCC__dispatch{display:grid;grid-template-columns:120px auto 1fr;gap:12px;align-items:center;margin-top:9px}.odaiCC__dispatch>span{color:var(--odai-cc-text-3);font-size:9px}.odaiCC__dispatch small{color:var(--odai-cc-text-3);font-size:9px}.odaiCC__segments{display:flex;border:1px solid var(--odai-cc-border);border-radius:6px;overflow:hidden}.odaiCC__segments button{height:25px;border:0;border-right:1px solid var(--odai-cc-border);background:transparent;color:var(--odai-cc-text-3);padding:0 9px;font:500 9px/1 inherit;cursor:pointer}.odaiCC__segments button:last-child{border-right:0}.odaiCC__segments button.is-active{background:var(--odai-cc-hover);color:var(--odai-cc-text)}.odaiCC__routeForm{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:10px 0 0 132px;padding:10px;border:1px solid var(--odai-cc-border);border-radius:7px;background:var(--odai-cc-surface)}.odaiCC__routeForm label span{display:block;color:var(--odai-cc-text-3);font-size:9px;margin-bottom:4px}.odaiCC__routeForm input{width:100%;height:30px;border:1px solid var(--odai-cc-border);border-radius:5px;background:var(--odai-cc-panel);color:var(--odai-cc-text);padding:0 7px;font:10px/1 inherit;outline:none}.odaiCC__routeForm input:focus{border-color:var(--odai-cc-accent)}.odaiCC__formActions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.odaiCC__body{overflow:hidden}.odaiCC__live{height:100%;min-height:0;display:flex;flex-direction:column;gap:14px;overflow:hidden;padding:14px}.odaiCC__live>.odaiCC__alert{flex:none;margin-bottom:0}.odaiCC__flow{flex:none;max-height:38vh;overflow:auto;scrollbar-gutter:stable}.odaiCC__evidenceGrid{flex:1;min-height:0;overflow:hidden;margin-top:0}.odaiCC__timeline{display:flex;flex-direction:column;min-height:0;overflow:hidden}.odaiCC__timeline>.odaiCC__sectionHead{flex:none}.odaiCC__turns{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.odaiCC__inspector{min-height:0;max-height:none;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.odaiCC__inspector>.odaiCC__sectionHead{position:sticky;top:0;z-index:1;background:var(--odai-cc-panel);padding-bottom:8px}.odaiCC__sectionHead h3{font-size:13px;line-height:20px}.odaiCC__kicker{font:700 11px/16px inherit;letter-spacing:0}.odaiCC__role,.odaiCC__state,.odaiCC__nodeEyebrow{font-size:10px}.odaiCC__controllerNode strong,.odaiCC__roleNode strong{font-size:13px;line-height:18px}.odaiCC__controllerNode small,.odaiCC__roleNode small,.odaiCC__edge em{font-size:11px;line-height:16px}.odaiCC__eventCount{font-size:11px;line-height:16px}.odaiCC__turn summary{font-size:12px;line-height:18px}.odaiCC__eventTop code,.odaiCC__eventTop time{font-size:11px;line-height:16px}.odaiCC__event>strong{font-size:13px;line-height:18px}.odaiCC__eventDetail,.odaiCC__eventBottom{font-size:11px;line-height:16px}.odaiCC__eventTop .odaiCC__state,.odaiCC__eventBottom .odaiCC__role,.odaiCC__facts .odaiCC__state,.odaiCC__facts .odaiCC__role{font-size:10px}.odaiCC__facts dt{font-size:11px;line-height:18px}.odaiCC__facts dd{font-size:12px;line-height:18px}.odaiCC__facts code{font-size:11px;line-height:18px}.odaiCC__raw{font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.odaiCC__loadEarlier{width:100%;height:30px;border:0;border-bottom:1px solid var(--odai-cc-border);background:var(--odai-cc-surface);color:var(--odai-cc-text-2);font:600 10px/1 inherit;cursor:pointer}.odaiCC__loadEarlier:hover{background:var(--odai-cc-hover);color:var(--odai-cc-text)}.odaiCC__routing{height:100%;overflow-y:auto}
@media(max-width:760px){.odaiCC__launcher span:last-child{display:none}.odaiCC__drawer{inset:6px}.odaiCC__header{grid-template-columns:minmax(0,1fr) auto auto;gap:7px;padding:8px}.odaiCC__brand span{display:none}.odaiCC__tabs button{min-width:56px}.odaiCC__live{padding:8px}.odaiCC__flowGrid{grid-template-columns:1fr;gap:10px;min-height:0}.odaiCC__controllerNode{padding:10px}.odaiCC__flowRole{grid-template-columns:65px minmax(0,1fr)}.odaiCC__evidenceGrid{grid-template-columns:1fr}.odaiCC__inspector{max-height:none}.odaiCC__routing{padding:10px}.odaiCC__controllerLock,.odaiCC__routeSummary{grid-template-columns:92px minmax(0,1fr) auto}.odaiCC__dispatch{grid-template-columns:92px 1fr}.odaiCC__dispatch small{grid-column:2}.odaiCC__routeForm{grid-template-columns:1fr 1fr;margin-left:0}.odaiCC__raw{max-height:240px}}
@media(max-width:760px){.odaiCC__body{overflow:hidden}.odaiCC__live{gap:8px}.odaiCC__flow{max-height:30vh}.odaiCC__evidenceGrid{grid-template-rows:minmax(180px,1fr) minmax(120px,35vh);overflow:hidden}.odaiCC__timeline,.odaiCC__inspector{min-height:0;max-height:none}}
@media(prefers-color-scheme:dark){.odaiCC__launcher,.odaiCC{--odai-cc-bg:#14171b;--odai-cc-panel:#191d22;--odai-cc-surface:#1f242a;--odai-cc-surface-2:#282e35;--odai-cc-text:#f2f4f7;--odai-cc-text-2:#c5cbd3;--odai-cc-text-3:#929ba7;--odai-cc-border:#333a43;--odai-cc-border-strong:#46505c;--odai-cc-hover:#26354b;--odai-cc-accent:#77a7ff}.odaiCC__nodeEyebrow{color:#91b7ff}.odaiCC__state--proposal,.odaiCC__alert.is-success{color:#90d9cf}.odaiCC__state--same-turn{color:#cbb8ff}.odaiCC__state--child{color:#a6c3ff}.odaiCC__state--handback{color:#f4ca84}.odaiCC__state--blocked,.odaiCC__state--interrupted,.odaiCC__dangerButton,.odaiCC__alert.is-error{color:#f3a39e}}
@media(prefers-reduced-motion:no-preference){.odaiCC__drawer{animation:odaiCCIn .15s ease-out}}@keyframes odaiCCIn{from{opacity:.72;transform:translateX(8px)}to{opacity:1;transform:none}}
`;
      document.head.appendChild(tag);
    }

    function shouldOwnSurface() {
      const entries = globalThis.__DSH_BOOT__?.entries;
      const ids = Array.isArray(entries) ? entries.map((entry) => entry?.id) : [];
      const preferred = ids.includes("odai-dsh-plugin") ? "odai-dsh-plugin" : "odai-dsh-agent";
      return PACKAGE_ID === preferred;
    }

    function apply(ctx: any): void {
      if (!shouldOwnSurface()) return;
      injectStyles();
      ctx.conversationViews.register({
        target: "odaiControlCenter",
        create() {
          let events: any[] = [];
          return {
            empty: Object.freeze({ events: Object.freeze([]) }),
            replace({ nodes }: { nodes: Array<{ data: unknown }> }) {
              events = nodes.map((node) => node.data).filter((value): value is UnknownRecord => record(value) !== undefined).sort((left, right) => Number(left.seq) - Number(right.seq));
              return Object.freeze({ events: Object.freeze(events) });
            },
            apply({ upserts }: { upserts: Array<{ data: unknown }> }) {
              const byKey = new Map(events.map((event) => [`${event.seq}:${event.type}`, event]));
              for (const node of upserts) {
                const data = record(node.data);
                if (data) byKey.set(`${data.seq}:${data.type}`, data);
              }
              events = [...byKey.values()].sort((left, right) => Number(left.seq) - Number(right.seq));
              return Object.freeze({ events: Object.freeze(events) });
            },
          };
        },
      });
      ctx.conversationEvents.register({
        kind: "odai-control-center:event",
        target: "odaiControlCenter",
        match(event: UnknownRecord) {
          return text(event?.type).startsWith("odai/") ? { id: `${event.seq}:${event.type}`, role: "start" } : null;
        },
        start(_context: unknown, match: { event: UnknownRecord }) {
          return { event: match.event };
        },
        update(context: { state: unknown }) {
          return context.state;
        },
        buildViewNode(context: { state?: { event?: UnknownRecord } }) {
          const event = context.state?.event;
          if (!event) return null;
          return {
            key: `${event.seq}:${event.type}`,
            kind: "odai-control-center:event",
            id: `${event.seq}:${event.type}`,
            target: "odaiControlCenter",
            data: { seq: event.seq, time: event.time, type: event.type, data: record(event.data) ?? {} },
          };
        },
      });
      const Entry = (props: { useSession: any }) => h(Launcher, { ...props, connection: ctx.connection });
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "odai-control-center",
        order: 60,
        label: "Odai Control Center",
      }, Entry));
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions", "conversationEvents", "conversationViews", "connection"];
    exports.__testing = { projectTrace, stateOf, roleOf, shouldOwnSurface, traceFingerprint, windowTurnItems };
    return module.exports;
  },
});
