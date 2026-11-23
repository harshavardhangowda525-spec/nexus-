import path from 'node:path';
import type { AgentId, AgentVisualState } from '@nexus/shared';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { EventBus } from './events/bus.js';
import type { ModelGateway } from './models/gateway.js';
import type { BrowserSandboxes } from './sandbox/browser.js';
import type { ExecSandboxes } from './sandbox/docker.js';
import { ProjectFiles, parseUid } from './sandbox/workspace.js';
import type { SecretBox } from './util/crypto.js';

export interface SandboxStatus { docker: boolean; execImage: boolean; browserImage: boolean; egress: boolean; detail: string | null }

export interface JobQueue {
  enqueuePlan(missionId: string): Promise<void>;
  enqueueTask(taskId: string): Promise<void>;
}

/** Everything a request handler or job needs. Built once per process. */
export interface Runtime {
  cfg: Config;
  db: Db;
  redis: Redis;
  bus: EventBus;
  gateway: ModelGateway;
  secrets: SecretBox | null;
  exec: ExecSandboxes;
  browsers: BrowserSandboxes | null;
  queue: JobQueue;
  sandbox: SandboxStatus;
}

export function projectFiles(rt: Runtime, projectId: string) {
  return new ProjectFiles(path.join(rt.cfg.dataDir, 'projects', projectId, 'files'), parseUid(rt.cfg.sandbox.uid));
}

const stateKey = (ws: string) => `nexus:agentstate:${ws}`;

/** Records the robot's visual state (for late-joining browsers) and broadcasts it. */
export async function setAgentState(rt: Runtime, a: { workspaceId: string; missionId: string | null; taskId?: string | null; agentId: AgentId; state: AgentVisualState; label?: string | null; detail?: string | null }) {
  const payload = { state: a.state, label: a.label ?? null, detail: a.detail ?? null, missionId: a.missionId, taskId: a.taskId ?? null, at: new Date().toISOString() };
  await rt.redis.hset(stateKey(a.workspaceId), a.agentId, JSON.stringify(payload));
  await rt.bus.emit({ workspaceId: a.workspaceId, missionId: a.missionId, agentId: a.agentId, taskId: a.taskId ?? null, type: 'agent.state', payload });
}

export async function getAgentStates(rt: Runtime, ws: string): Promise<Record<string, any>> {
  const h = await rt.redis.hgetall(stateKey(ws));
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, JSON.parse(v)]));
}

export const frameKey = (ws: string, agent: string) => `nexus:frame:${ws}:${agent}`;
