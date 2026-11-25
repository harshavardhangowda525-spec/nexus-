import type { AgentId, EventType, NexusEvent } from '@nexus/shared';
import type { Db } from '../db/pool.js';
import type { StateStore } from './memory.js';

export const EVENTS_CHANNEL = 'nexus:events';

export interface EmitInput {
  workspaceId: string;
  missionId?: string | null;
  agentId?: AgentId | null;
  taskId?: string | null;
  type: EventType;
  payload?: Record<string, unknown>;
}

/**
 * Every state change goes through here: persisted to `events` (the source of truth
 * for replay and progress) and published on Redis (or in-memory in single-process dev)
 * so API processes can push it to browsers. Ephemeral events (browser frames) are
 * published but not stored.
 */
export class EventBus {
  constructor(private db: Db, private pub: Pick<StateStore, 'publish'>) {}

  async emit(e: EmitInput, opts: { persist?: boolean } = {}): Promise<NexusEvent> {
    const persist = opts.persist ?? true;
    const payload = e.payload ?? {};
    let id = 0;
    let createdAt = new Date().toISOString();
    if (persist) {
      const r = await this.db.query(
        'insert into events (workspace_id, mission_id, agent_id, task_id, type, payload) values ($1,$2,$3,$4,$5,$6) returning id, created_at',
        [e.workspaceId, e.missionId ?? null, e.agentId ?? null, e.taskId ?? null, e.type, payload],
      );
      id = r.rows[0].id;
      createdAt = r.rows[0].created_at.toISOString();
    }
    const evt: NexusEvent = {
      id, workspaceId: e.workspaceId, missionId: e.missionId ?? null, agentId: e.agentId ?? null,
      taskId: e.taskId ?? null, type: e.type, payload, createdAt,
    };
    await this.pub.publish(EVENTS_CHANNEL, JSON.stringify(evt));
    return evt;
  }
}

export function rowToEvent(r: any): NexusEvent {
  return {
    id: r.id, workspaceId: r.workspace_id, missionId: r.mission_id, agentId: r.agent_id, taskId: r.task_id,
    type: r.type, payload: r.payload, createdAt: r.created_at.toISOString(),
  };
}

export async function audit(db: Db, a: { workspaceId: string | null; actorType: 'user' | 'agent' | 'system'; actorId?: string | null; action: string; target?: string | null; detail?: Record<string, unknown> }) {
  await db.query(
    'insert into audit_log (workspace_id, actor_type, actor_id, action, target, detail) values ($1,$2,$3,$4,$5,$6)',
    [a.workspaceId, a.actorType, a.actorId ?? null, a.action, a.target ?? null, a.detail ?? {}],
  );
}
