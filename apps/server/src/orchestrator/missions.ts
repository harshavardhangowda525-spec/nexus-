import { AGENT_PROFILES, SPECIALIST_IDS, type AgentId, type MissionView, type TaskView } from '@nexus/shared';
import { loadAgentTarget } from '../agents/config.js';
import { PLANNER_PROMPT } from '../agents/prompts.js';
import { FatalTaskError, recordUsage } from '../agents/runner.js';
import { tx } from '../db/pool.js';
import { audit } from '../events/bus.js';
import type { ChatMessage, ToolUseBlock } from '../models/types.js';
import { ModelError } from '../models/types.js';
import { setAgentState, type Runtime } from '../runtime.js';
import { SUBMIT_PLAN, validatePlan } from './plan.js';

export class MissionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function toTaskView(r: any): TaskView {
  return {
    id: r.id, missionId: r.mission_id, key: r.key, title: r.title, description: r.description, agentId: r.agent_id,
    deps: r.deps, status: r.status, attempt: r.attempt, result: r.result, error: r.error,
    startedAt: r.started_at?.toISOString() ?? null, finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export async function getMission(rt: Runtime, workspaceId: string, id: string): Promise<MissionView | null> {
  const m = (await rt.db.query('select * from missions where id = $1 and workspace_id = $2', [id, workspaceId])).rows[0];
  if (!m) return null;
  const tasks = (await rt.db.query('select * from tasks where mission_id = $1 order by created_at, key', [id])).rows.map(toTaskView);
  return {
    id: m.id, projectId: m.project_id, brief: m.brief, status: m.status, budgetUsd: m.budget_usd, spentUsd: m.spent_usd,
    report: m.report, error: m.error, createdAt: m.created_at.toISOString(), updatedAt: m.updated_at.toISOString(), tasks,
  };
}

async function setMissionStatus(rt: Runtime, ws: string, id: string, status: string, extra: { error?: string | null; report?: string | null } = {}) {
  await rt.db.query(
    'update missions set status = $2, error = coalesce($3, error), report = coalesce($4, report), updated_at = now() where id = $1',
    [id, status, extra.error ?? null, extra.report ?? null],
  );
  await rt.bus.emit({ workspaceId: ws, missionId: id, type: 'mission.status', payload: { status, error: extra.error ?? null } });
}

export async function createMission(rt: Runtime, a: { workspaceId: string; userId: string; brief: string; budgetUsd?: number; projectId?: string | null; projectName?: string | null }) {
  const brief = a.brief.trim();
  if (brief.length < 10) throw new MissionError('Describe the mission in at least a sentence.');
  if (brief.length > 8000) throw new MissionError('The brief is too long (8000 characters max).');
  const atlas = await loadAgentTarget(rt.db, rt.secrets, a.workspaceId, 'atlas');
  if (!atlas.ok) throw new MissionError(`ATLAS cannot plan yet: ${atlas.reason}`, 409);
  const budget = a.budgetUsd ?? rt.cfg.defaultMissionBudgetUsd;
  if (!(budget > 0 && budget <= 1000)) throw new MissionError('Budget must be between $0 and $1000.');
  return tx(rt.db, async (c) => {
    let projectId = a.projectId ?? null;
    if (projectId) {
      const p = await c.query('select id from projects where id = $1 and workspace_id = $2', [projectId, a.workspaceId]);
      if (!p.rowCount) throw new MissionError('Project not found', 404);
    } else {
      const name = (a.projectName || brief.split(/[.\n]/)[0]).slice(0, 80);
      projectId = (await c.query('insert into projects (workspace_id, name, description) values ($1,$2,$3) returning id', [a.workspaceId, name, brief.slice(0, 500)])).rows[0].id;
    }
    const m = await c.query(
      "insert into missions (workspace_id, project_id, brief, status, budget_usd, created_by) values ($1,$2,$3,'planning',$4,$5) returning id",
      [a.workspaceId, projectId, brief, budget, a.userId],
    );
    return { id: m.rows[0].id as string, projectId: projectId! };
  }).then(async (r) => {
    await rt.bus.emit({ workspaceId: a.workspaceId, missionId: r.id, type: 'mission.created', payload: { brief, projectId: r.projectId, budgetUsd: budget } });
    await audit(rt.db, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'mission.create', target: r.id });
    await rt.queue.enqueuePlan(r.id);
    return r;
  });
}

/** Job: ATLAS turns the brief into a validated task graph. */
export async function planMission(rt: Runtime, missionId: string, signal?: AbortSignal) {
  const m = (await rt.db.query('select * from missions where id = $1', [missionId])).rows[0];
  if (!m || m.status !== 'planning') return;
  const ws = m.workspace_id;
  const base = { workspaceId: ws, missionId, agentId: 'atlas' as AgentId };
  const atlas = await loadAgentTarget(rt.db, rt.secrets, ws, 'atlas');
  if (!atlas.ok) return failMission(rt, ws, missionId, atlas.reason);

  const available: AgentId[] = [];
  const unavailable: string[] = [];
  for (const id of SPECIALIST_IDS) {
    const t = await loadAgentTarget(rt.db, rt.secrets, ws, id);
    if (t.ok) available.push(id); else unavailable.push(`${id.toUpperCase()} (${t.reason})`);
  }
  if (!available.length) return failMission(rt, ws, missionId, 'No specialist agents are configured. Assign models in Workforce.');
  const sandboxNotes = [
    !rt.sandbox.docker || !rt.sandbox.execImage ? 'FORGE has no working sandbox computer right now; do not plan tasks that need run_command.' : '',
    !rt.browsers || !rt.sandbox.browserImage ? 'SCOUT has no working browser right now; plan research from existing knowledge only.' : '',
  ].filter(Boolean).join('\n');

  await setAgentState(rt, { ...base, state: 'thinking', label: 'Planning' });
  const messages: ChatMessage[] = m.plan_checkpoint?.messages ?? [{
    role: 'user',
    content: [{ type: 'text', text: `CEO brief:\n${m.brief}\n\nAvailable specialists: ${available.map((a) => `${a.toUpperCase()} (${AGENT_PROFILES[a].role})`).join(', ')}.${unavailable.length ? `\nNot available: ${unavailable.join('; ')}.` : ''}${sandboxNotes ? `\n${sandboxNotes}` : ''}\n\nSubmit the plan with submit_plan.` }],
  }];

  for (let attempt = 0; attempt < 3; attempt++) {
    let resp;
    try {
      resp = await rt.gateway.chat(atlas.target, { system: PLANNER_PROMPT, messages, tools: [SUBMIT_PLAN] }, signal);
    } catch (e) {
      if (e instanceof ModelError && !e.retryable) return failMission(rt, ws, missionId, `ATLAS model error: ${e.message}`);
      throw e;
    }
    await recordUsage(rt, { ...base, provider: atlas.target.provider, model: atlas.target.model, inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens, costUsd: resp.costUsd, priced: resp.priced, durationMs: resp.durationMs });
    messages.push({ role: 'assistant', content: resp.content, raw: { provider: atlas.target.provider, content: resp.raw } });
    const call = resp.content.find((b): b is ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_plan');
    if (!call) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Please submit the plan by calling the submit_plan tool.' }] });
      continue;
    }
    const v = validatePlan(call.input, available);
    if (!v.ok) {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: `The plan is invalid: ${v.error}. Fix it and call submit_plan again.`, is_error: true }] });
      await rt.db.query('update missions set plan_checkpoint = $2 where id = $1', [missionId, JSON.stringify({ messages })]);
      continue;
    }
    const plan = v.plan;
    await tx(rt.db, async (c) => {
      for (const t of plan.tasks) {
        await c.query("insert into tasks (mission_id, key, title, description, agent_id, deps, status) values ($1,$2,$3,$4,$5,$6,'blocked')", [missionId, t.key, t.title, t.description, t.agent, t.deps]);
      }
      await c.query(
        "insert into tasks (mission_id, key, title, description, agent_id, deps, status) values ($1,'R','Final report',$2,'atlas',$3,'blocked')",
        [missionId, 'Review every deliverable your team produced for this mission and write report.md for the CEO.', plan.tasks.map((t) => t.key)],
      );
      await c.query("update missions set status = 'running', plan_checkpoint = null, updated_at = now() where id = $1", [missionId]);
    });
    const tasks = (await rt.db.query('select * from tasks where mission_id = $1 order by created_at, key', [missionId])).rows.map(toTaskView);
    await rt.bus.emit({ ...base, type: 'mission.planned', payload: { summary: plan.summary, tasks } });
    for (const t of plan.tasks) {
      await rt.bus.emit({ ...base, type: 'message.sent', payload: { from: 'atlas', to: t.agent, body: `${t.key}: ${t.title}` } });
    }
    await rt.bus.emit({ workspaceId: ws, missionId, type: 'mission.status', payload: { status: 'running' } });
    await setAgentState(rt, { ...base, state: 'idle', label: 'Monitoring' });
    await schedule(rt, missionId);
    return;
  }
  return failMission(rt, ws, missionId, 'ATLAS could not produce a valid plan after 3 attempts.');
}

/**
 * Moves blocked tasks whose dependencies are complete onto the queue (one active task
 * per agent at a time) and completes the mission when every task is done.
 */
export async function schedule(rt: Runtime, missionId: string) {
  const toEnqueue: string[] = [];
  let completedReport: string | null = null;
  let ws = '';
  await tx(rt.db, async (c) => {
    const m = (await c.query('select * from missions where id = $1 for update', [missionId])).rows[0];
    if (!m || m.status !== 'running') return;
    ws = m.workspace_id;
    const tasks = (await c.query('select * from tasks where mission_id = $1', [missionId])).rows;
    if (tasks.length && tasks.every((t) => t.status === 'completed')) {
      completedReport = tasks.find((t) => t.key === 'R')?.result ?? 'Mission complete.';
      return;
    }
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const busy = new Set(tasks.filter((t) => ['queued', 'running', 'waiting_approval'].includes(t.status)).map((t) => t.agent_id));
    for (const t of tasks) {
      if (t.status === 'queued') toEnqueue.push(t.id); // idempotent: the queue dedupes by task id
      if (t.status !== 'blocked') continue;
      if (!t.deps.every((d: string) => byKey.get(d)?.status === 'completed')) continue;
      if (busy.has(t.agent_id)) continue;
      busy.add(t.agent_id);
      await c.query("update tasks set status = 'queued' where id = $1", [t.id]);
      toEnqueue.push(t.id);
      await rt.bus.emit({ workspaceId: ws, missionId, agentId: t.agent_id, taskId: t.id, type: 'task.status', payload: { key: t.key, status: 'queued' } });
    }
  });
  for (const id of toEnqueue) await rt.queue.enqueueTask(id);
  if (completedReport !== null) await completeMission(rt, ws, missionId);
}

async function completeMission(rt: Runtime, ws: string, missionId: string) {
  const r = await rt.db.query("update missions set status = 'completed', updated_at = now() where id = $1 and status = 'running' returning project_id", [missionId]);
  if (!r.rowCount) return;
  const report = (await rt.db.query("select result from tasks where mission_id = $1 and key = 'R'", [missionId])).rows[0]?.result ?? null;
  let reportFile: string | null = null;
  try {
    const { projectFiles } = await import('../runtime.js');
    reportFile = projectFiles(rt, r.rows[0].project_id).read('report.md', 100_000).content.toString('utf8');
  } catch { /* ATLAS may not have written report.md */ }
  await rt.db.query('update missions set report = $2 where id = $1', [missionId, reportFile ?? report]);
  await rt.bus.emit({ workspaceId: ws, missionId, agentId: 'atlas', type: 'mission.report', payload: { summary: report, hasFile: !!reportFile } });
  await rt.bus.emit({ workspaceId: ws, missionId, type: 'mission.status', payload: { status: 'completed' } });
  await releaseSandboxes(rt, missionId);
}

export async function failMission(rt: Runtime, ws: string, missionId: string, error: string) {
  await setMissionStatus(rt, ws, missionId, 'failed', { error });
  await setAgentState(rt, { workspaceId: ws, missionId, agentId: 'atlas', state: 'error', label: 'Mission failed', detail: error });
  await releaseSandboxes(rt, missionId, false);
}

/** Called by the worker when a task fails for good. The mission stops; the CEO can retry the task. */
export async function failTask(rt: Runtime, taskId: string, error: string) {
  const t = (await rt.db.query('update tasks set status = $2, error = $3, finished_at = now() where id = $1 returning *', [taskId, 'failed', error])).rows[0];
  if (!t) return;
  const m = (await rt.db.query('select workspace_id from missions where id = $1', [t.mission_id])).rows[0];
  const base = { workspaceId: m.workspace_id, missionId: t.mission_id, taskId, agentId: t.agent_id as AgentId };
  await rt.bus.emit({ ...base, type: 'task.status', payload: { key: t.key, status: 'failed', error } });
  await rt.bus.emit({ ...base, type: 'error', payload: { message: error, key: t.key } });
  await setAgentState(rt, { ...base, state: 'error', label: 'Needs help', detail: error });
  await rt.db.query("update missions set status = 'failed', error = $2, updated_at = now() where id = $1 and status = 'running'", [t.mission_id, `${t.key} (${String(t.agent_id).toUpperCase()}) failed: ${error}`]);
  await rt.bus.emit({ workspaceId: m.workspace_id, missionId: t.mission_id, type: 'mission.status', payload: { status: 'failed', error } });
}

export async function controlMission(rt: Runtime, a: { workspaceId: string; userId: string; missionId: string; action: 'pause' | 'resume' | 'cancel'; budgetUsd?: number }) {
  const m = (await rt.db.query('select * from missions where id = $1 and workspace_id = $2', [a.missionId, a.workspaceId])).rows[0];
  if (!m) throw new MissionError('Mission not found', 404);
  if (a.action === 'pause') {
    if (m.status !== 'running') throw new MissionError(`Cannot pause a ${m.status} mission`, 409);
    await setMissionStatus(rt, a.workspaceId, m.id, 'paused');
  } else if (a.action === 'resume') {
    if (!['paused', 'failed'].includes(m.status)) throw new MissionError(`Cannot resume a ${m.status} mission`, 409);
    if (m.status === 'failed' && (await rt.db.query("select 1 from tasks where mission_id = $1 and status = 'failed'", [m.id])).rowCount) {
      throw new MissionError('Retry the failed task to resume this mission', 409);
    }
    if (a.budgetUsd) await rt.db.query('update missions set budget_usd = $2 where id = $1', [m.id, a.budgetUsd]);
    await setMissionStatus(rt, a.workspaceId, m.id, m.plan_checkpoint || !(await rt.db.query('select 1 from tasks where mission_id = $1', [m.id])).rowCount ? 'planning' : 'running');
    if ((await rt.db.query("select status from missions where id = $1", [m.id])).rows[0].status === 'planning') await rt.queue.enqueuePlan(m.id);
    else await schedule(rt, m.id);
  } else {
    if (['completed', 'cancelled'].includes(m.status)) throw new MissionError(`Mission is already ${m.status}`, 409);
    await rt.db.query("update tasks set status = 'cancelled' where mission_id = $1 and status not in ('completed','failed')", [m.id]);
    await rt.db.query("update approvals set status = 'rejected', note = 'Mission cancelled', decided_at = now() where mission_id = $1 and status = 'pending'", [m.id]);
    await setMissionStatus(rt, a.workspaceId, m.id, 'cancelled');
    await releaseSandboxes(rt, m.id, false);
    for (const id of SPECIALIST_IDS.concat(['atlas'] as any)) {
      await setAgentState(rt, { workspaceId: a.workspaceId, missionId: m.id, agentId: id as AgentId, state: 'idle', label: 'Standing by' });
    }
  }
  await audit(rt.db, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: `mission.${a.action}`, target: m.id });
}

export async function retryTask(rt: Runtime, a: { workspaceId: string; userId: string; taskId: string; budgetUsd?: number }) {
  const t = (await rt.db.query('select t.*, m.workspace_id, m.status as mstatus from tasks t join missions m on m.id = t.mission_id where t.id = $1', [a.taskId])).rows[0];
  if (!t || t.workspace_id !== a.workspaceId) throw new MissionError('Task not found', 404);
  if (t.status !== 'failed') throw new MissionError('Only failed tasks can be retried', 409);
  if (a.budgetUsd) await rt.db.query('update missions set budget_usd = $2 where id = $1', [t.mission_id, a.budgetUsd]);
  // Keep the checkpoint: the agent resumes with its conversation so far, plus a note.
  const cp = t.checkpoint;
  if (cp?.messages?.length && !cp.pending) {
    const last = cp.messages[cp.messages.length - 1];
    const note = { type: 'text', text: `The previous attempt stopped with this error: ${t.error}. The CEO asked you to retry. Continue from where you left off.` };
    if (last.role === 'user') last.content.push(note); else cp.messages.push({ role: 'user', content: [note] });
  }
  await rt.db.query("update tasks set status = 'blocked', error = null, finished_at = null, checkpoint = $2 where id = $1", [t.id, cp ? JSON.stringify(cp) : null]);
  await rt.db.query("update missions set status = 'running', error = null, updated_at = now() where id = $1", [t.mission_id]);
  await rt.bus.emit({ workspaceId: a.workspaceId, missionId: t.mission_id, type: 'mission.status', payload: { status: 'running' } });
  await audit(rt.db, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'task.retry', target: t.id });
  await schedule(rt, t.mission_id);
}

async function releaseSandboxes(rt: Runtime, missionId: string, keepFiles = true) {
  void keepFiles; // project files always stay; only the computers are removed
  rt.browsers?.closeMission(missionId);
  await rt.exec.destroyMission(missionId).catch(() => {});
}

export { FatalTaskError };
