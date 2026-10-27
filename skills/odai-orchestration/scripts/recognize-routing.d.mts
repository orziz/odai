export type Responsibility = 'controller' | 'researcher' | 'planner' | 'reviewer' | 'frontend' | 'creative' | 'writer' | 'user';
export interface ModelRoute { backend?: string; cli?: string; provider?: string; model: string }
export interface NamedRequest { responsibility: Responsibility; timing: 'start' | 'completion'; excerpt: string; name: string; canceled?: boolean; issue?: 'unconfigured' | 'mapping-mismatch' }
export function recognizeNamedRequests(text: string, routes: Partial<Record<Responsibility, ModelRoute>>): NamedRequest[];
export function recognizeLeadSwitch(text: string, routes: Partial<Record<'planner' | 'reviewer', ModelRoute>>): { enabled: boolean; roles: string[]; issue?: string } | undefined;
export function parseLeadVerdict(text: string): "pass" | "changes-requested" | "invalid";
