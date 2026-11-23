import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS, type NexusEvent } from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildServer } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { docker, ExecSandboxes } from '../../src/sandbox/docker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function startMockLlm(port: number, delayMs = 350): Promise<{ proc: ChildProcess; baseUrl: string }> {
  const proc = spawn(process.execPath, [path.join(repoRoot, 'scripts/mock-llm.mjs')], {
    env: { ...process.env, MOCK_LLM_PORT: String(port), MOCK_LLM_DELAY_MS: String(delayMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  proc.stderr?.on('data', (d) => (err += d.toString()));
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  await waitFor(async () => {
    if (proc.exitCode !== null) throw new Error(`mock-llm exited early (${proc.exitCode}): ${err}`);
    try {
      const r = await fetch(`${baseUrl}/models`);
      return r.ok;
    } catch {
      return false;
    }
  }, 10_000, 100, 'mock-llm ready');
  return { proc, baseUrl };
}

describe('NEXUS end-to-end mission & sandbox integration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-e2e-'));
  const masterKey = crypto.randomBytes(32).toString('base64');
  const mockPort = 4100 + Math.floor(Math.random() * 500);
  const queuePrefix = `nexus-test-${crypto.randomBytes(4).toString('hex')}`;
  const uid = process.getuid && process.getuid() > 0 ? `${process.getuid()}:${process.getgid!()}` : '1000:1000';

  let mockProc: ChildProcess | null = null;
  let mockBaseUrl = '';
  let server: Awaited<ReturnType<typeof buildServer>> | null = null;
  let apiBase = '';
  let wsBase = '';

  beforeAll(async () => {
    const mock = await startMockLlm(mockPort, 400);
    mockProc = mock.proc;
    mockBaseUrl = mock.baseUrl;

    const cfg = loadConfig({
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATABASE_URL: process.env.DATABASE_URL || 'postgres://nexus:nexus@127.0.0.1:5432/nexus',
      REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
      NEXUS_MASTER_KEY: masterKey,
      NEXUS_DATA_DIR: tmpDir,
      NEXUS_RUN_WORKER: 'true',
      NEXUS_WORKER_CONCURRENCY: '4',
      NEXUS_QUEUE_PREFIX: queuePrefix,
      SANDBOX_UID: uid,
      SANDBOX_BROWSER_WORKER_DIR: path.join(repoRoot, 'sandbox/browser-worker'),
      EGRESS_PORT: '0',
    });

    server = await buildServer(cfg, { logger: false });
    // Ensure a clean database state for bootstrap in the test DB.
    await server.rt.db.query(
      'truncate table audit_log, outbox, usage, artifacts, approvals, events, agent_messages, tasks, missions, projects, agents, provider_credentials, sessions, memberships, workspaces, users cascade',
    );
    const addr = await server.app.listen({ port: 0, host: '127.0.0.1' });
    apiBase = addr;
    wsBase = addr.replace(/^http/, 'ws');
  }, 60_000);

  afterAll(async () => {
    if (server) await server.app.close();
    if (mockProc && mockProc.exitCode === null) {
      mockProc.kill('SIGTERM');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  it('proves the FORGE sandbox container has no network and cannot write outside /workspace and /tmp', async () => {
    const exec = new ExecSandboxes({
      image: server!.rt.cfg.sandbox.execImage,
      memory: '512m',
      cpus: '1',
      pids: 128,
      uid,
      maxOutputBytes: 64_000,
    });
    const missionId = `iso-${crypto.randomBytes(6).toString('hex')}`;
    const hostWs = path.join(tmpDir, 'iso-ws');
    fs.mkdirSync(hostWs, { recursive: true });
    try {
      const name = await exec.ensure(missionId, 'forge', hostWs);

      // 1. No network: attempting an outbound TCP connection fails, and no non-loopback interface exists.
      const netCheck = await exec.exec(
        name,
        `node -e "import('node:net').then(({default:net})=>{const s=net.connect(80,'1.1.1.1');s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',(e)=>{console.log('ERR:'+e.code);process.exit(42)})})"`,
        15_000,
      );
      expect(netCheck.exitCode).toBe(42);
      expect(netCheck.output).not.toContain('CONNECTED');

      const ifCheck = await exec.exec(
        name,
        `node -e "import('node:os').then(({default:os})=>{const n=Object.keys(os.networkInterfaces()).filter(k=>k!=='lo');console.log(JSON.stringify(n))})"`,
        10_000,
      );
      expect(ifCheck.exitCode).toBe(0);
      expect(ifCheck.output.trim()).toBe('[]');

      // 2. Read-only rootfs: cannot write outside /workspace and /tmp.
      for (const target of ['/pwn.txt', '/etc/pwn.txt', '/var/pwn.txt', '/usr/pwn.txt']) {
        const w = await exec.exec(name, `touch ${target}`, 10_000);
        expect(w.exitCode).not.toBe(0);
      }

      // 3. Can write inside /workspace and /tmp.
      const okWs = await exec.exec(name, 'echo ok > /workspace/hello.txt && echo ok > /tmp/hello.txt', 10_000);
      expect(okWs.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(hostWs, 'hello.txt'), 'utf8').trim()).toBe('ok');
    } finally {
      await exec.destroyMission(missionId);
    }
  }, 60_000);

  it('runs the full physiotherapy mission end to end with real Postgres, Redis, Docker and browser sandbox', async () => {
    expect(server!.rt.sandbox.docker).toBe(true);
    expect(server!.rt.sandbox.execImage).toBe(true);
    expect(server!.rt.sandbox.browserImage).toBe(true);
    expect(server!.rt.sandbox.egress).toBe(true);

    let cookieHeader = '';
    const api = async (method: string, urlPath: string, body?: unknown) => {
      const headers: Record<string, string> = {};
      if (cookieHeader) headers.cookie = cookieHeader;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${apiBase}${urlPath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookieHeader = setCookie.split(';')[0];
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* binary or plain */ }
      return { status: res.status, ok: res.ok, json, text, res };
    };

    // 1. Bootstrap CEO account
    const boot = await api('POST', '/api/auth/bootstrap', {
      email: 'ceo@nexus.local',
      name: 'CEO',
      password: 'correct-horse-battery',
      workspaceName: 'NEXUS Studio',
    });
    expect(boot.status).toBe(200);
    expect(cookieHeader).toContain('nexus_session=');

    // 2. Add OpenAI-compatible credential pointing at mock-llm
    const cred = await api('POST', '/api/credentials', {
      provider: 'openai',
      label: 'Mock LLM',
      baseUrl: mockBaseUrl,
      apiKey: 'mock-key-123456',
    });
    expect(cred.status).toBe(200);
    const credentialId = cred.json.id as string;

    // 3. Assign credential & model to all five agents
    for (const id of AGENT_IDS) {
      const patch = await api('PATCH', `/api/agents/${id}`, {
        credentialId,
        model: 'nexus-mock',
        enabled: true,
      });
      expect(patch.status).toBe(200);
    }

    // 4. Connect WebSocket
    const wsEvents: NexusEvent[] = [];
    const ws = new WebSocket(`${wsBase}/api/ws`, { headers: { cookie: cookieHeader } });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS hello timeout')), 10_000);
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'hello') {
          clearTimeout(t);
          resolve();
          return;
        }
        wsEvents.push(msg as NexusEvent);
      });
    });

    try {
      // 5. Create the physiotherapy mission
      const created = await api('POST', '/api/missions', {
        brief: 'Build a premium website for my physiotherapy client and prepare a marketing strategy.',
        budgetUsd: 10,
      });
      expect(created.status).toBe(200);
      const { id: missionId, projectId } = created.json as { id: string; projectId: string };

      // 6. Wait for LEDGER's approval.requested event and approve it
      const approvalEvt = await waitFor(
        async () => wsEvents.find((e) => e.missionId === missionId && e.type === 'approval.requested'),
        90_000,
        250,
        'approval.requested event',
      );
      expect(approvalEvt.agentId).toBe('ledger');
      const approvalId = approvalEvt.payload.approvalId as string;
      const decide = await api('POST', `/api/approvals/${approvalId}/decide`, { decision: 'approve' });
      expect(decide.status).toBe(200);

      // 7. Wait for mission completion
      const finalMission = await waitFor(
        async () => {
          const m = await api('GET', `/api/missions/${missionId}`);
          if (m.json?.status === 'failed') throw new Error(`Mission failed: ${m.json.error}`);
          return m.json?.status === 'completed' ? m.json : null;
        },
        180_000,
        500,
        'mission completion',
      );

      // 8. Assert all tasks completed (including ATLAS report task R)
      expect(finalMission.tasks.length).toBeGreaterThanOrEqual(5);
      expect(finalMission.tasks.every((t: any) => t.status === 'completed')).toBe(true);
      expect(finalMission.tasks.some((t: any) => t.key === 'R')).toBe(true);

      // 9. Assert deliverables exist: site/index.html, research/findings.md, PNG screenshot, report.md
      const filesRes = await api('GET', `/api/projects/${projectId}/files`);
      expect(filesRes.status).toBe(200);
      const filePaths = (filesRes.json as any[]).filter((f) => !f.dir).map((f) => f.path);
      expect(filePaths).toContain('site/index.html');
      expect(filePaths).toContain('research/findings.md');
      expect(filePaths).toContain('report.md');
      const pngPath = filePaths.find((p) => p.endsWith('.png'));
      expect(pngPath).toBeTruthy();

      const pngRes = await fetch(`${apiBase}/api/projects/${projectId}/file?path=${encodeURIComponent(pngPath!)}`, {
        headers: { cookie: cookieHeader },
      });
      expect(pngRes.status).toBe(200);
      const pngBuf = Buffer.from(await pngRes.arrayBuffer());
      // PNG magic header: 89 50 4E 47
      expect(pngBuf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);

      // 10. Assert persisted events & WebSocket events
      const eventsRes = await api('GET', `/api/missions/${missionId}/events`);
      expect(eventsRes.status).toBe(200);
      const persisted = eventsRes.json as NexusEvent[];

      // FORGE's exec.output shows a failing test run then 4 passing
      const forgeExec = persisted
        .filter((e) => e.agentId === 'forge' && e.type === 'exec.output')
        .map((e) => String(e.payload.text ?? ''))
        .join('');
      const failIdx = forgeExec.indexOf('fail 1');
      const passIdx = forgeExec.lastIndexOf('pass 4');
      expect(failIdx).toBeGreaterThan(-1);
      expect(passIdx).toBeGreaterThan(failIdx);

      // browser.frame events arrived over WebSocket
      const frameEvts = wsEvents.filter((e) => e.missionId === missionId && e.type === 'browser.frame');
      expect(frameEvts.length).toBeGreaterThan(0);
      expect(typeof frameEvts[0].payload.data).toBe('string');
      expect(frameEvts[0].payload.data.length).toBeGreaterThan(100);

      // browser.navigated hit en.wikipedia.org
      const navEvts = persisted.filter((e) => e.type === 'browser.navigated');
      expect(navEvts.some((e) => String(e.payload.url || '').includes('en.wikipedia.org'))).toBe(true);

      // scout -> forge message.sent
      const msgEvts = persisted.filter((e) => e.type === 'message.sent');
      expect(msgEvts.some((e) => e.payload.from === 'scout' && e.payload.to === 'forge')).toBe(true);

      // Approval approved and outbox row undeliverable
      const approvalsRes = await api('GET', '/api/approvals');
      const ap = (approvalsRes.json as any[]).find((a) => a.id === approvalId);
      expect(ap?.status).toBe('approved');

      const outboxRes = await api('GET', '/api/outbox');
      const ob = (outboxRes.json as any[]).find((o) => o.approval_id === approvalId);
      expect(ob?.status).toBe('undeliverable');

      // Usage rows recorded
      const usageCount = (await server!.rt.db.query('select count(*)::int as n from usage where mission_id = $1', [missionId])).rows[0].n;
      expect(usageCount).toBeGreaterThan(0);

      // Egress audit entries exist
      const egressAudit = (
        await server!.rt.db.query("select count(*)::int as n from audit_log where action in ('egress.allow','egress.deny')")
      ).rows[0].n;
      expect(egressAudit).toBeGreaterThan(0);

      // Mission containers removed afterwards
      const leftover = await waitFor(
        async () => {
          const ls = await docker(['ps', '-aq', '--filter', `label=nexus.mission=${missionId}`]);
          return ls.stdout.trim() === '' ? 'clean' : false;
        },
        15_000,
        250,
        'mission containers removed',
      );
      expect(leftover).toBe('clean');
    } finally {
      ws.close();
    }
  }, 240_000);
});
