// Types and constants shared by the NEXUS server and web app.
// Every visual state in the office is derived from these event types.

export const AGENT_IDS = ['atlas', 'forge', 'scout', 'pulse', 'ledger'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const SPECIALIST_IDS = ['forge', 'scout', 'pulse', 'ledger'] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export interface AgentProfile {
  id: AgentId;
  name: string;
  role: string;
  color: string;
  glyph: string;
  seated: boolean;
  responsibilities: string[];
}

export const AGENT_PROFILES: Record<AgentId, AgentProfile> = {
  atlas: {
    id: 'atlas', name: 'ATLAS', role: 'Chief Coordinator', color: '#9b8cff', glyph: 'A', seated: false,
    responsibilities: ['Understand objectives', 'Break work into tasks', 'Delegate and track dependencies', 'Write the final report'],
  },
  forge: {
    id: 'forge', name: 'FORGE', role: 'Software Engineer', color: '#2fd8ff', glyph: 'F', seated: true,
    responsibilities: ['Build websites and apps', 'Run commands in its sandbox', 'Debug and run tests', 'Prepare previews'],
  },
  scout: {
    id: 'scout', name: 'SCOUT', role: 'Research Specialist', color: '#45f0c4', glyph: 'S', seated: true,
    responsibilities: ['Browse the web in an isolated browser', 'Research businesses and competitors', 'Cite sources', 'Write research reports'],
  },
  pulse: {
    id: 'pulse', name: 'PULSE', role: 'Marketing Specialist', color: '#ff6ad5', glyph: 'P', seated: true,
    responsibilities: ['Marketing strategy', 'Social scripts and campaign copy', 'Outreach drafts', 'Content calendars'],
  },
  ledger: {
    id: 'ledger', name: 'LEDGER', role: 'Operations Specialist', color: '#ffbe5c', glyph: 'L', seated: true,
    responsibilities: ['Milestones and project plans', 'Quotes and invoices (approval required)', 'Client communications (approval required)', 'Operational reports'],
  },
};

export type AgentVisualState = 'idle' | 'thinking' | 'working' | 'browsing' | 'waiting' | 'done' | 'error' | 'offline';
export type TaskStatus = 'blocked' | 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type MissionStatus = 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type Role = 'owner' | 'admin' | 'operator' | 'viewer';
export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'ollama';

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI-compatible',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
};

export type EventType =
  | 'mission.created' | 'mission.status' | 'mission.planned' | 'mission.report'
  | 'task.status'
  | 'agent.state' | 'agent.say'
  | 'tool.call' | 'tool.result'
  | 'exec.output'
  | 'browser.navigated' | 'browser.frame'
  | 'file.written'
  | 'message.sent'
  | 'approval.requested' | 'approval.decided'
  | 'usage'
  | 'error';

export interface NexusEvent<P = any> {
  id: number;           // 0 for ephemeral events (browser frames)
  workspaceId: string;
  missionId: string | null;
  agentId: AgentId | null;
  taskId: string | null;
  type: EventType;
  payload: P;
  createdAt: string;
}

export interface TaskView {
  id: string;
  missionId: string;
  key: string;
  title: string;
  description: string;
  agentId: AgentId;
  deps: string[];
  status: TaskStatus;
  attempt: number;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MissionView {
  id: string;
  projectId: string;
  brief: string;
  status: MissionStatus;
  budgetUsd: number;
  spentUsd: number;
  report: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: TaskView[];
}

export interface ApprovalView {
  id: string;
  missionId: string;
  taskId: string;
  agentId: AgentId;
  action: string;
  summary: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AgentConfigView {
  id: AgentId;
  name: string;
  role: string;
  enabled: boolean;
  credentialId: string | null;
  provider: ProviderKind | null;
  model: string | null;
  effort: string | null;
  maxSteps: number;
  configured: boolean;
  stats: { completed: number; failed: number; active: number; tokens: number; costUsd: number };
}

export interface CredentialView {
  id: string;
  provider: ProviderKind;
  label: string;
  baseUrl: string | null;
  hasSecret: boolean;
  secretHint: string | null;
  createdAt: string;
}

export interface SetupStatus {
  hasCredentials: boolean;
  agents: { id: AgentId; configured: boolean; reason: string | null }[];
  sandbox: { docker: boolean; execImage: boolean; browserImage: boolean; egress: boolean; detail: string | null };
}

/** Maps a tool name to the visual state the robot shows while the tool runs. */
export function stateForTool(tool: string): AgentVisualState {
  if (tool === 'browse' || tool === 'search_web' || tool === 'screenshot') return 'browsing';
  if (tool === 'request_approval') return 'waiting';
  return 'working';
}
