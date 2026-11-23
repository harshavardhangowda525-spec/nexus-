import path from 'node:path';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { registerRoutes } from './api/routes.js';
import { registerWs } from './api/ws.js';
import type { Config } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { audit, EventBus } from './events/bus.js';
import { ModelGateway, type GatewayOptions } from './models/gateway.js';
import { createQueue, startWorker } from './orchestrator/queue.js';
import { schedule } from './orchestrator/missions.js';
import type { Runtime, SandboxStatus } from './runtime.js';
import { BrowserSandboxes, buildNssDb } from './sandbox/browser.js';
import { dockerAvailable, ensureNetwork, ExecSandboxes, imageExists } from './sandbox/docker.js';
import { EgressGateway } from './sandbox/egress.js';
import { SecretBox } from './util/crypto.js';

export interface BootOptions { gateway?: GatewayOptions; logger?: boolean; withWorker?: boolean; withHttp?: boolean }

/** Creates the runtime: DB, Redis, queue, model gateway and sandbox managers (with health checks). */
export async function createRuntime(cfg: Config, opts: BootOptions = {}) {
  const db = createPool(cfg.databaseUrl);
  await migrate(db);
  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 3 });
  const bus = new EventBus(db, redis);
  const queue = createQueue(cfg.redisUrl, cfg.queuePrefix);
  let secrets: SecretBox | null = null;
  try { secrets = cfg.masterKey ? new SecretBox(cfg.masterKey) : null; } catch (e) { console.warn(`[nexus] ${(e as Error).message}`); }

  const sandbox: SandboxStatus = { docker: false, execImage: false, browserImage: false, egress: false, detail: null };
  const exec = new ExecSandboxes({ image: cfg.sandbox.execImage, memory: cfg.sandbox.memory, cpus: cfg.sandbox.cpus, pids: cfg.sandbox.pids, uid: cfg.sandbox.uid, maxOutputBytes: cfg.sandbox.maxOutputBytes });
  let browsers: BrowserSandboxes | null = null;
  let egress: EgressGateway | null = null;
  const problems: string[] = [];
  sandbox.docker = await dockerAvailable();
  if (!sandbox.docker) problems.push('Docker is not reachable, so agents have no computers. Start Docker and restart the server.');
  else {
    sandbox.execImage = await imageExists(cfg.sandbox.execImage);
    if (!sandbox.execImage) problems.push(`Sandbox image ${cfg.sandbox.execImage} is missing (run npm run sandbox:setup).`);
    sandbox.browserImage = await imageExists(cfg.sandbox.browserImage);
    if (!sandbox.browserImage) problems.push(`Browser image ${cfg.sandbox.browserImage} is missing (run npm run sandbox:setup).`);
    try {
      const gwIp = await ensureNetwork(cfg.sandbox.browserNetwork);
      const seenHosts = new Set<string>();
      egress = new EgressGateway({ allow: cfg.egress.allow, deny: cfg.egress.deny }, cfg.egress.upstreamProxy, (e) => {
        // Log every denial; log each allowed host once per sandbox to keep the audit trail readable.
        const key = `${e.grant?.missionId}:${e.grant?.agentId}:${e.host}`;
        if (e.allowed && seenHosts.has(key)) return;
        if (e.allowed) seenHosts.add(key);
        void audit(db, { workspaceId: e.grant?.workspaceId ?? null, actorType: 'agent', actorId: e.grant?.agentId ?? 'unknown', action: e.allowed ? 'egress.allow' : 'egress.deny', target: `${e.host}:${e.port}`, detail: { reason: e.reason, missionId: e.grant?.missionId } }).catch(() => {});
      });
      await egress.start(gwIp, cfg.egress.port);
      sandbox.egress = true;
      const nssDir = cfg.sandbox.extraCaFile ? await buildNssDb(cfg.sandbox.extraCaFile, path.join(cfg.dataDir, 'sandbox', 'nssdb')) : null;
      if (sandbox.browserImage) browsers = new BrowserSandboxes({ image: cfg.sandbox.browserImage, network: cfg.sandbox.browserNetwork, workerDir: cfg.sandbox.browserWorkerDir, timeoutMs: cfg.sandbox.browserTimeoutMs, nssDir }, egress);
    } catch (e) {
      problems.push(`Browser network unavailable: ${(e as Error).message}`);
    }
  }
  sandbox.detail = problems.join(' ') || null;
  if (problems.length) console.warn(`[nexus] sandbox: ${sandbox.detail}`);

  const rt: Runtime = { cfg, db, redis, bus, gateway: new ModelGateway(opts.gateway), secrets, exec, browsers, queue, sandbox };
  return {
    rt,
    async close() {
      browsers?.closeAll();
      await egress?.stop();
      await queue.close();
      redis.disconnect();
      await db.end();
    },
  };
}

/** Re-queues work that was in flight when the process stopped. Jobs are idempotent per task. */
export async function recover(rt: Runtime) {
  const planning = (await rt.db.query("select id from missions where status = 'planning'")).rows;
  for (const m of planning) await rt.queue.enqueuePlan(m.id);
  const running = (await rt.db.query("select id from missions where status = 'running'")).rows;
  for (const m of running) {
    const stuck = (await rt.db.query("select id from tasks where mission_id = $1 and status = 'running'", [m.id])).rows;
    for (const t of stuck) await rt.queue.enqueueTask(t.id);
    await schedule(rt, m.id);
  }
}

export async function buildServer(cfg: Config, opts: BootOptions = {}) {
  const { rt, close } = await createRuntime(cfg, opts);
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 1_000_000, trustProxy: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await registerRoutes(app, rt);
  await registerWs(app, rt);
  let worker: Awaited<ReturnType<typeof startWorker>> | null = null;
  if (opts.withWorker ?? cfg.runWorker) {
    worker = startWorker(rt, cfg.redisUrl, cfg.queuePrefix, cfg.workerConcurrency);
    await recover(rt);
  }
  app.addHook('onClose', async () => { await worker?.close(); await close(); });
  return { app, rt };
}
