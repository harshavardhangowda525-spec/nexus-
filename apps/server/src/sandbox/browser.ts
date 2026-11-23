import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { containerName, docker } from './docker.js';
import type { EgressGateway, EgressGrant } from './egress.js';

export interface BrowserLimits { image: string; network: string; workerDir: string; timeoutMs: number; nssDir: string | null }
export type FrameHandler = (frame: { data: string; url: string }) => void;

/** A Playwright-driven Chromium running in its own container, reachable only via the egress gateway. */
export class BrowserSession {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void>;
  private closed = false;
  onFrame: FrameHandler | null = null;
  lastError = '';

  constructor(private proc: ChildProcess, private timeoutMs: number, readonly name: string) {
    let markReady!: () => void;
    let failReady!: (e: Error) => void;
    this.ready = new Promise((res, rej) => { markReady = res; failReady = rej; });
    const startTimer = setTimeout(() => failReady(new Error(`browser sandbox did not start: ${this.lastError || 'timeout'}`)), 60_000);
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'ready') { clearTimeout(startTimer); markReady(); return; }
      if (m.type === 'frame') { this.onFrame?.({ data: m.data, url: m.url }); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
    });
    proc.stderr!.on('data', (d) => { this.lastError = (this.lastError + d.toString()).slice(-2000); });
    proc.on('close', () => {
      this.closed = true;
      clearTimeout(startTimer);
      failReady(new Error(`browser sandbox exited: ${this.lastError.trim().split('\n').pop() || 'unknown'}`));
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('browser sandbox exited')); }
      this.pending.clear();
    });
  }

  get alive() { return !this.closed; }

  async call<T = any>(cmd: 'goto' | 'search' | 'screenshot', args: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    if (this.closed) throw new Error('browser sandbox is not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`browser ${cmd} timed out`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  close() { if (!this.closed) this.proc.stdin!.end(); }
}

export class BrowserSandboxes {
  private sessions = new Map<string, { session: BrowserSession; password: string }>();
  constructor(private limits: BrowserLimits, private egress: EgressGateway) {}

  async open(grant: EgressGrant): Promise<BrowserSession> {
    const key = `${grant.missionId}:${grant.agentId}`;
    const existing = this.sessions.get(key);
    if (existing?.session.alive) return existing.session;
    const name = containerName(grant.missionId, grant.agentId, '-browser');
    await docker(['rm', '-f', name]);
    const cred = this.egress.issue(grant);
    const args = [
      'run', '-i', '--rm', '--name', name,
      '--label', 'nexus=1', '--label', `nexus.mission=${grant.missionId}`, '--label', `nexus.agent=${grant.agentId}`,
      '--network', this.limits.network,
      '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '1.5', '--pids-limit', '512',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m', '--shm-size', '256m',
      '--user', 'pwuser',
      '-e', 'HOME=/tmp/home',
      '-e', `PROXY_SERVER=http://${this.egress.host}:${this.egress.port}`,
      '-e', `PROXY_USER=${cred.username}`, '-e', `PROXY_PASS=${cred.password}`,
      '-e', `NAV_TIMEOUT_MS=${Math.max(5000, this.limits.timeoutMs - 5000)}`,
      '-v', `${this.limits.workerDir}:/opt/worker:ro`,
      ...(this.limits.nssDir ? ['-v', `${this.limits.nssDir}:/nssdb:ro`] : []),
      '-w', '/opt/worker',
      this.limits.image, 'node', 'worker.mjs',
    ];
    const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const session = new BrowserSession(proc, this.limits.timeoutMs, name);
    proc.on('close', () => this.egress.revoke(cred.password));
    this.sessions.set(key, { session, password: cred.password });
    return session;
  }

  closeMission(missionId: string) {
    for (const [k, v] of this.sessions) if (k.startsWith(missionId + ':')) { v.session.close(); this.sessions.delete(k); }
  }

  closeAll() { for (const v of this.sessions.values()) v.session.close(); this.sessions.clear(); }
}

/** Builds an NSS database trusting an extra CA, for Chromium inside the browser sandbox. */
export async function buildNssDb(caFile: string, dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    const p = spawn('certutil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`certutil failed: ${err}`))));
  });
  await run(['-N', '-d', `sql:${dir}`, '--empty-password']);
  // certutil imports one certificate per call, so split PEM bundles.
  const pems = fs.readFileSync(caFile, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!pems.length) throw new Error(`no certificates found in ${caFile}`);
  const tmp = path.join(dir, '.import.pem');
  for (const [i, pem] of pems.entries()) {
    fs.writeFileSync(tmp, pem + '\n');
    await run(['-A', '-n', `nexus-extra-ca-${i}`, '-t', 'C,,', '-a', '-i', tmp, '-d', `sql:${dir}`]);
  }
  fs.rmSync(tmp, { force: true });
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644);
  return dir;
}
