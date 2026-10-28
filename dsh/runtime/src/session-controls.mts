import { randomUUID } from 'node:crypto';
import { validateLocalCliRoute, type LocalCliRoute } from '#odai-local-cli';
import { recognizeLeadSwitch } from './lead-mode.mjs';
import { effectiveRoutingSnapshot, type RoleRoutes, type RoleDispatches } from './routing-config.mjs';
import { createSessionEvidence } from './session-evidence.mjs';
import { isUnknownRecord, type DshAgent, type ModelRoute } from './runtime-types.mjs';
import type { RouteSessionEvidence } from './route-session.mjs';
function support(route: ModelRoute | LocalCliRoute): string | undefined {
  if (route.backend !== 'local-cli') return 'API 渠道暂不支持会话续接：尚未核实续接职责边界与回执';
  try { validateLocalCliRoute({ ...route, session: 'continue' }); } catch (error) { return String(error); }
}
function override(agent: DshAgent, evidence?: RouteSessionEvidence) {
  const value = evidence?.events(agent).findLast(e => e.type === 'odai/session-continuation')?.data.value;
  return value === 'fresh' || value === 'continue' ? value : 'inherit';
}
export function effectiveSessionRoute(route: LocalCliRoute, agent: DshAgent, evidence?: RouteSessionEvidence): LocalCliRoute {
  const value = override(agent, evidence);
  return value === 'inherit' || support(route) ? route : { ...route, session: value };
}
export function applySessionControl(payload: unknown, options: { configPath: string; evidenceRoot: string; configuredRoles?: Readonly<RoleRoutes>; configuredDispatch?: Readonly<RoleDispatches>; routingMode?: string }) {
  if (!isUnknownRecord(payload) || typeof payload.sessionId !== 'string' || !payload.sessionId.trim() || payload.sessionId.length > 512) throw new TypeError('需要有效会话标识');
  const fields = payload.action === 'show' ? ['sessionId','action'] : payload.action === 'set-lead' ? ['sessionId','action','enabled'] : payload.action === 'set-continuation' ? ['sessionId','action','value'] : [];
  if (!fields.length || Object.keys(payload).some(key => !fields.includes(key))) throw new TypeError('无效会话控制请求');
  const evidence = createSessionEvidence({ root: options.evidenceRoot });
  const agent = { session: { header: { id: payload.sessionId } } } as unknown as DshAgent;
  const routes = effectiveRoutingSnapshot(options.configPath, options.configuredRoles, options.configuredDispatch).roles;
  const leadRoutes = { ...(routes.planner ? { planner: routes.planner } : {}), ...(routes.reviewer ? { reviewer: routes.reviewer } : {}) };
  const hostReason = !options.routingMode ? '宿主未报告职责路由状态' : options.routingMode === 'off' ? '职责路由已关闭' : undefined;
  const leadReason = hostReason ?? recognizeLeadSwitch('开启主导模式', leadRoutes)?.issue;
  const roles = Object.entries(routes).flatMap(([responsibility, route]) => route ? [{ responsibility, route, reason: support(route) }] : []);
  const continuationReason = hostReason ?? (roles.some(r => !r.reason) ? undefined : '没有支持续接的职责映射');
  if (payload.action === 'set-lead') {
    if (typeof payload.enabled !== 'boolean') throw new TypeError('enabled 必须为布尔值');
    if (payload.enabled && leadReason) throw new TypeError(leadReason);
    if (!payload.enabled) {
      const events = evidence.events(agent);
      const consumed = new Set(events.filter(e => e.type === 'odai/responsibility-gap-consumed').map(e => e.data.stateDigest));
      for (const event of events) if (event.type === 'odai/responsibility-gap' && event.data.source === 'lead-mode' && !consumed.has(event.data.stateDigest)) evidence.append(agent, 'odai/responsibility-gap-consumed', { stateDigest: event.data.stateDigest, responsibility: event.data.responsibility, reason: 'LEAD_MODE_DISABLED' });
    }
    evidence.append(agent, 'odai/lead-mode', { ...recognizeLeadSwitch(payload.enabled ? '开启主导模式' : '关闭主导模式', leadRoutes), source: 'session-controls', invocationId: randomUUID() });
  } else if (payload.action === 'set-continuation') {
    if (!['inherit','fresh','continue'].includes(String(payload.value))) throw new TypeError('无效续接状态');
    if (payload.value === 'continue' && continuationReason) throw new TypeError(continuationReason);
    evidence.append(agent, 'odai/session-continuation', { value: payload.value, source: 'session-controls', invocationId: randomUUID() });
  }
  const lead = evidence.events(agent).findLast(e => e.type === 'odai/lead-mode')?.data;
  const value = override(agent, evidence);
  return { sessionId: payload.sessionId, lead: { enabled: lead?.enabled === true, roles: lead?.roles ?? [], available: !leadReason, reason: leadReason }, continuation: { override: value, available: !continuationReason, reason: continuationReason, roles: roles.map(({responsibility,route,reason}) => ({ responsibility, supported: !reason, reason, effective: !reason && value !== 'inherit' ? value : route.session ?? 'fresh' })) } };
}
export type SessionControlsSnapshot = ReturnType<typeof applySessionControl>;
