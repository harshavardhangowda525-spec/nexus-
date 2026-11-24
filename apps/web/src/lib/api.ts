import type {
  AgentConfigView,
  AgentId,
  ApprovalView,
  CredentialView,
  MissionView,
  NexusEvent,
  ProviderKind,
  Role,
  SetupStatus,
} from '@nexus/shared';

export interface AuthState {
  needsBootstrap: boolean;
  user: null | { email: string; name: string; role: Role; workspaceId: string };
}

export interface HealthResponse {
  ok: boolean;
  db: boolean;
  redis: boolean;
  sandbox: SetupStatus['sandbox'];
  worker: boolean;
}

export interface OfficeSnapshot {
  states: Record<string, { state: string; label: string | null; detail: string | null; missionId: string | null; taskId: string | null; at: string }>;
  frames: Record<string, { data: string; url: string; at: string }>;
  missionId: string | null;
}

export interface MissionSummary {
  id: string;
  brief: string;
  status: string;
  budgetUsd: number;
  spentUsd: number;
  createdAt: string;
  projectId: string;
}

export interface MissionDetail extends MissionView {
  approvals: ApprovalView[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  created_at: string;
  missions: number;
  last_status: string | null;
  files: number;
}

export interface ProjectFileItem {
  path: string;
  size: number;
  dir: boolean;
  version: number | null;
  agentId: string | null;
  updatedAt: string | null;
}

export interface ArtifactHistoryItem {
  path: string;
  version: number;
  size: number;
  sha256: string;
  agent_id: string | null;
  mission_id: string | null;
  created_at: string;
}

export interface OutboxItem {
  id: string;
  approval_id: string;
  channel: string;
  payload: Record<string, unknown>;
  status: string;
  detail: string | null;
  created_at: string;
}

export interface MemberItem {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuditItem {
  id: number;
  workspace_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface InsightsData {
  days: number;
  tasks: { agent_id: AgentId; status: string; secs: number | null }[];
  usage: {
    agent_id: AgentId;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    priced: boolean;
    calls: number;
  }[];
  daily: { day: string; tokens: number; cost: number }[];
  missions: { status: string; n: number }[];
  errors: { agent_id: AgentId | null; message: string | null; created_at: string }[];
  busy: { agent_id: AgentId; secs: number }[];
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  authState: () => req<AuthState>('/api/auth/state'),
  bootstrap: (b: { email: string; name: string; password: string; workspaceName: string }) =>
    req<{ ok: true }>('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(b) }),
  login: (b: { email: string; password: string }) =>
    req<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify(b) }),
  logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }),

  health: () => req<HealthResponse>('/api/health'),
  setup: () => req<SetupStatus>('/api/setup'),
  office: () => req<OfficeSnapshot>('/api/office'),

  agents: () => req<AgentConfigView[]>('/api/agents'),
  patchAgent: (
    id: AgentId,
    b: { credentialId?: string | null; model?: string | null; effort?: string | null; maxSteps?: number; enabled?: boolean },
  ) => req<{ ok: true }>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  modelDefaults: () => req<Record<ProviderKind, string>>('/api/models/defaults'),

  credentials: () => req<CredentialView[]>('/api/credentials'),
  createCredential: (b: { provider: ProviderKind; label: string; baseUrl?: string | null; apiKey?: string | null }) =>
    req<CredentialView>('/api/credentials', { method: 'POST', body: JSON.stringify(b) }),
  deleteCredential: (id: string) => req<{ ok: true }>(`/api/credentials/${id}`, { method: 'DELETE' }),
  testCredential: (id: string, model: string) =>
    req<{ ok: boolean; model?: string; reply?: string; error?: string; inputTokens?: number; outputTokens?: number }>(
      `/api/credentials/${id}/test`,
      { method: 'POST', body: JSON.stringify({ model }) },
    ),

  missions: () => req<MissionSummary[]>('/api/missions'),
  createMission: (b: { brief: string; budgetUsd?: number; projectId?: string | null }) =>
    req<{ id: string; projectId: string }>('/api/missions', { method: 'POST', body: JSON.stringify(b) }),
  mission: (id: string) => req<MissionDetail>(`/api/missions/${id}`),
  missionEvents: (id: string, after = 0) => req<NexusEvent[]>(`/api/missions/${id}/events?after=${after}`),
  controlMission: (id: string, action: 'pause' | 'resume' | 'cancel', budgetUsd?: number) =>
    req<{ ok: true }>(`/api/missions/${id}/${action}`, { method: 'POST', body: JSON.stringify(budgetUsd ? { budgetUsd } : {}) }),
  retryTask: (id: string, budgetUsd?: number) =>
    req<{ ok: true }>(`/api/tasks/${id}/retry`, { method: 'POST', body: JSON.stringify(budgetUsd ? { budgetUsd } : {}) }),

  approvals: (status?: string) => req<ApprovalView[]>(`/api/approvals${status ? `?status=${status}` : ''}`),
  decideApproval: (id: string, decision: 'approve' | 'reject', note?: string) =>
    req<{ ok: true }>(`/api/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) }),
  outbox: () => req<OutboxItem[]>('/api/outbox'),

  projects: () => req<ProjectSummary[]>('/api/projects'),
  projectFiles: (id: string) => req<ProjectFileItem[]>(`/api/projects/${id}/files`),
  projectHistory: (id: string, filePath?: string) =>
    req<ArtifactHistoryItem[]>(`/api/projects/${id}/history${filePath ? `?path=${encodeURIComponent(filePath)}` : ''}`),
  projectFileText: async (id: string, filePath: string, version?: number) => {
    const q = new URLSearchParams({ path: filePath });
    if (version !== undefined) q.set('version', String(version));
    const res = await fetch(`/api/projects/${id}/file?${q.toString()}`, { credentials: 'include' });
    if (!res.ok) throw new ApiError(`Could not load ${filePath}`, res.status);
    return res.text();
  },

  insights: (days = 30) => req<InsightsData>(`/api/insights?days=${days}`),
  members: () => req<MemberItem[]>('/api/members'),
  addMember: (b: { email: string; name: string; password: string; role: 'admin' | 'operator' | 'viewer' }) =>
    req<{ id: string }>('/api/members', { method: 'POST', body: JSON.stringify(b) }),
  audit: () => req<AuditItem[]>('/api/audit'),
};

export function getWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_ORIGIN;
  if (configured) {
    return `${configured.replace(/\/+$/, '')}/api/ws`;
  }
  if (typeof window === 'undefined') return 'ws://127.0.0.1:4000/api/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.hostname}:4000/api/ws`;
}
