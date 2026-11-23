import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { FatalTaskError, runTask } from '../agents/runner.js';
import type { JobQueue, Runtime } from '../runtime.js';
import { failMission, failTask, planMission, schedule } from './missions.js';

const QUEUE = 'missions';
const ATTEMPTS = 3;

export function createQueue(redisUrl: string, prefix: string): JobQueue & { queue: Queue; close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE, { connection, prefix });
  const opts = { attempts: ATTEMPTS, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: true, removeOnFail: 200 };
  return {
    queue,
    async enqueuePlan(missionId) { await queue.add('plan', { missionId }, { ...opts, jobId: `plan-${missionId}` }); },
    async enqueueTask(taskId) { await queue.add('task', { taskId }, { ...opts, jobId: `task-${taskId}` }); },
    async close() { await queue.close(); connection.disconnect(); },
  };
}

/**
 * Executes plan and task jobs. Progress lives in Postgres checkpoints, so a retried or
 * recovered job resumes from its last completed step rather than starting over.
 */
export function startWorker(rt: Runtime, redisUrl: string, prefix: string, concurrency: number) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const abort = new AbortController();
  const worker = new Worker(QUEUE, async (job: Job) => {
    if (job.name === 'plan') return handlePlan(rt, job, abort.signal);
    if (job.name === 'task') return handleTask(rt, job, abort.signal);
  }, { connection, prefix, concurrency, lockDuration: 120_000 });
  worker.on('error', (e) => console.error('[worker]', e.message));
  return {
    worker,
    async close() { abort.abort(); await worker.close(); connection.disconnect(); },
  };
}

async function handlePlan(rt: Runtime, job: Job, signal: AbortSignal) {
  const { missionId } = job.data as { missionId: string };
  try {
    await planMission(rt, missionId, signal);
  } catch (e) {
    if (job.attemptsMade + 1 >= ATTEMPTS) {
      const m = (await rt.db.query('select workspace_id from missions where id = $1', [missionId])).rows[0];
      if (m) await failMission(rt, m.workspace_id, missionId, `Planning failed: ${(e as Error).message}`);
      return;
    }
    throw e;
  }
}

async function handleTask(rt: Runtime, job: Job, signal: AbortSignal) {
  const { taskId } = job.data as { taskId: string };
  try {
    const outcome = await runTask(rt, taskId, signal);
    if (outcome === 'completed') {
      const t = (await rt.db.query('select mission_id from tasks where id = $1', [taskId])).rows[0];
      await schedule(rt, t.mission_id);
    }
    return outcome;
  } catch (e) {
    const msg = (e as Error).message;
    if (signal.aborted) throw e; // shutting down: let the job be retried elsewhere
    if (e instanceof FatalTaskError || job.attemptsMade + 1 >= ATTEMPTS) {
      await failTask(rt, taskId, msg);
      return 'failed';
    }
    // Transient: mark queued so the UI reflects the retry; BullMQ backs off and retries.
    await rt.db.query("update tasks set status = 'queued', error = $2 where id = $1 and status = 'running'", [taskId, `Retrying after: ${msg}`]);
    throw e;
  }
}
