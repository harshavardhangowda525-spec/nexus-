import { EventEmitter } from 'node:events';
import net from 'node:net';
import { FatalTaskError, runTask } from '../agents/runner.js';
import { failMission, failTask, planMission, schedule } from '../orchestrator/missions.js';
import type { JobQueue, Runtime } from '../runtime.js';

/** Minimal Redis subset used by EventBus, WebSocket fanout, and live agent state/frame cache. */
export interface StateStore {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, onMessage: (raw: string) => void): () => void;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'EX', ttlSec?: number): Promise<unknown>;
  ping(): Promise<string>;
  disconnect(): void;
}

/** Single-process in-memory store used when REDIS_URL=memory or local Redis is not running. */
export class MemoryStore implements StateStore {
  private ee = new EventEmitter();
  private hashes = new Map<string, Map<string, string>>();
  private kv = new Map<string, { val: string; exp: number | null }>();

  constructor() {
    this.ee.setMaxListeners(200);
  }

  async publish(channel: string, message: string): Promise<number> {
    this.ee.emit(channel, message);
    return this.ee.listenerCount(channel);
  }

  subscribe(channel: string, onMessage: (raw: string) => void): () => void {
    this.ee.on(channel, onMessage);
    return () => {
      this.ee.off(channel, onMessage);
    };
  }

  async hset(key: string, field: string, value: string) {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
    return 1;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    return h ? Object.fromEntries(h.entries()) : {};
  }

  async get(key: string): Promise<string | null> {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.exp !== null && Date.now() > e.exp) {
      this.kv.delete(key);
      return null;
    }
    return e.val;
  }

  async set(key: string, value: string, mode?: 'EX', ttlSec?: number) {
    const exp = mode === 'EX' && ttlSec ? Date.now() + ttlSec * 1000 : null;
    this.kv.set(key, { val: value, exp });
    return 'OK';
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  disconnect() {
    this.ee.removeAllListeners();
  }
}

/** Single-process in-memory job queue (drop-in replacement for BullMQ when Redis is absent). */
export function createMemoryQueue(): JobQueue & {
  start(rt: Runtime): { close(): Promise<void> };
  close(): Promise<void>;
} {
  let runtime: Runtime | null = null;
  const inflight = new Set<string>();
  const abort = new AbortController();

  const run = (key: string, fn: () => Promise<void>) => {
    if (inflight.has(key)) return;
    inflight.add(key);
    queueMicrotask(async () => {
      try {
        await fn();
      } finally {
        inflight.delete(key);
      }
    });
  };

  return {
    start(rt: Runtime) {
      runtime = rt;
      return {
        async close() {
          abort.abort();
          runtime = null;
        },
      };
    },
    async enqueuePlan(missionId: string) {
      run(`plan-${missionId}`, async () => {
        if (!runtime) return;
        try {
          await planMission(runtime, missionId, abort.signal);
        } catch (e) {
          const m = (await runtime.db.query('select workspace_id from missions where id = $1', [missionId])).rows[0];
          if (m) await failMission(runtime, m.workspace_id, missionId, `Planning failed: ${(e as Error).message}`);
        }
      });
    },
    async enqueueTask(taskId: string) {
      run(`task-${taskId}`, async () => {
        if (!runtime) return;
        try {
          const outcome = await runTask(runtime, taskId, abort.signal);
          if (outcome === 'completed') {
            const t = (await runtime.db.query('select mission_id from tasks where id = $1', [taskId])).rows[0];
            if (t) await schedule(runtime, t.mission_id);
          }
        } catch (e) {
          if (abort.signal.aborted) return;
          const msg = (e as Error).message;
          if (e instanceof FatalTaskError) {
            await failTask(runtime, taskId, msg);
          } else {
            await failTask(runtime, taskId, msg);
          }
        }
      });
    },
    async close() {
      abort.abort();
      runtime = null;
    },
  };
}

/** Quick TCP probe to check if a local Redis port is accepting connections. */
export function probeTcp(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
