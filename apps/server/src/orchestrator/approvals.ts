import type { ApprovalView } from '@nexus/shared';
import { tx } from '../db/pool.js';
import { audit } from '../events/bus.js';
import type { Runtime } from '../runtime.js';
import { MissionError } from './missions.js';

export function toApprovalView(r: any): ApprovalView {
  return {
    id: r.id, missionId: r.mission_id, taskId: r.task_id, agentId: r.agent_id, action: r.action, summary: r.summary,
    payload: r.payload, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

const CHANNEL: Record<string, string> = { send_email: 'email', update_crm: 'crm', issue_invoice: 'invoice' };

/**
 * Records the CEO's decision. Approved actions are executed through the outbox.
 * No delivery transports (SMTP, CRM, invoicing) ship with this build, so approved
 * actions are stored as 'undeliverable' with the full content, and the agent is told so.
 */
export async function decideApproval(rt: Runtime, a: { workspaceId: string; userId: string; approvalId: string; decision: 'approve' | 'reject'; note?: string }) {
  const result = await tx(rt.db, async (c) => {
    const ap = (await c.query('select * from approvals where id = $1 and workspace_id = $2 for update', [a.approvalId, a.workspaceId])).rows[0];
    if (!ap) throw new MissionError('Approval not found', 404);
    if (ap.status !== 'pending') throw new MissionError(`Already ${ap.status}`, 409);
    let res: Record<string, unknown> | null = null;
    if (a.decision === 'approve') {
      const ob = await c.query(
        "insert into outbox (workspace_id, approval_id, channel, payload, status, detail) values ($1,$2,$3,$4,'undeliverable',$5) returning id",
        [a.workspaceId, ap.id, CHANNEL[ap.action] ?? ap.action, ap.payload, 'No delivery transport is configured on this server; the approved content is stored in the outbox for manual sending.'],
      );
      res = { outboxId: ob.rows[0].id, delivered: false, message: `It was recorded in the outbox (${ob.rows[0].id}). No delivery transport is configured, so it was NOT sent automatically; the CEO will send it manually. Note this in your documents.` };
    }
    await c.query('update approvals set status = $2, decided_by = $3, decided_at = now(), note = $4, result = $5 where id = $1',
      [ap.id, a.decision === 'approve' ? 'approved' : 'rejected', a.userId, a.note ?? null, res]);
    await c.query("update tasks set status = 'queued' where id = $1 and status = 'waiting_approval'", [ap.task_id]);
    return { ap, res };
  });
  const { ap } = result;
  await rt.bus.emit({ workspaceId: a.workspaceId, missionId: ap.mission_id, agentId: ap.agent_id, taskId: ap.task_id, type: 'approval.decided', payload: { approvalId: ap.id, decision: a.decision, note: a.note ?? null } });
  await audit(rt.db, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: `approval.${a.decision}`, target: ap.id, detail: { action: ap.action } });
  const m = (await rt.db.query('select status from missions where id = $1', [ap.mission_id])).rows[0];
  if (m?.status === 'running') await rt.queue.enqueueTask(ap.task_id);
}
