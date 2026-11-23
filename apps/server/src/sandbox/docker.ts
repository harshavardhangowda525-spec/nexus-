import { spawn } from 'node:child_process';

export interface RunResult { code: number; stdout: string; stderr: string }

/** Runs the docker CLI with an argument vector (never a shell string). */
export function docker(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = opts.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs) : null;
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => { if (t) clearTimeout(t); resolve({ code: 127, stdout, stderr: String(e) }); });
    p.on('close', (code) => { if (t) clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
    if (opts.input) p.stdin.end(opts.input); else p.stdin.end();
  });
}

export async function dockerAvailable() {
  return (await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 })).code === 0;
}

export async function imageExists(image: string) {
  return (await docker(['image', 'inspect', image], { timeoutMs: 15_000 })).code === 0;
}

/** Creates the browser sandbox network if needed and returns its gateway IP. */
export async function ensureNetwork(name: string): Promise<string> {
  let r = await docker(['network', 'inspect', name, '--format', '{{(index .IPAM.Config 0).Gateway}}']);
  if (r.code !== 0) {
    const c = await docker(['network', 'create', '--driver', 'bridge', '--label', 'nexus=1', name]);
    if (c.code !== 0 && !c.stderr.includes('already exists')) throw new Error(`docker network create failed: ${c.stderr}`);
    r = await docker(['network', 'inspect', name, '--format', '{{(index .IPAM.Config 0).Gateway}}']);
  }
  const ip = r.stdout.trim();
  if (!ip) throw new Error(`could not determine gateway IP of network ${name}`);
  return ip;
}

export interface ExecLimits { memory: string; cpus: string; pids: number; uid: string; image: string; maxOutputBytes: number }
export interface ExecOutcome { exitCode: number; output: string; truncated: boolean; timedOut: boolean; durationMs: number }

export function containerName(missionId: string, agentId: string, suffix = '') {
  return `nexus-${missionId.slice(0, 8)}-${agentId}${suffix}`;
}

/**
 * One long-lived container per (mission, agent): the agent's "computer".
 * No network, read-only root, all capabilities dropped, non-root user, resource limits.
 * Only /workspace (the project files) and /tmp are writable.
 */
export class ExecSandboxes {
  constructor(private limits: ExecLimits) {}

  async ensure(missionId: string, agentId: string, hostDir: string): Promise<string> {
    const name = containerName(missionId, agentId);
    const st = await docker(['inspect', '-f', '{{.State.Running}}', name]);
    if (st.code === 0) {
      if (st.stdout.trim() !== 'true') {
        const s = await docker(['start', name]);
        if (s.code !== 0) throw new Error(`could not restart sandbox: ${s.stderr.trim()}`);
      }
      return name;
    }
    const args = [
      'run', '-d', '--name', name,
      '--label', 'nexus=1', '--label', `nexus.mission=${missionId}`, '--label', `nexus.agent=${agentId}`,
      '--network', 'none',
      '--memory', this.limits.memory, '--memory-swap', this.limits.memory,
      '--cpus', this.limits.cpus, '--pids-limit', String(this.limits.pids),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
      '--user', this.limits.uid,
      '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/.npm', '-e', 'CI=1',
      '-v', `${hostDir}:/workspace`, '-w', '/workspace',
      this.limits.image, 'sleep', 'infinity',
    ];
    const r = await docker(args, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`could not start sandbox: ${r.stderr.trim()}`);
    return name;
  }

  /** Runs a shell command inside the sandbox, streaming output as it arrives. */
  exec(name: string, command: string, timeoutMs: number, onChunk?: (s: string) => void): Promise<ExecOutcome> {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const started = Date.now();
    return new Promise((resolve) => {
      const p = spawn('docker', ['exec', '-w', '/workspace', name, 'timeout', '-s', 'KILL', String(secs), 'sh', '-c', command]);
      let out = '';
      let truncated = false;
      const onData = (d: Buffer) => {
        const s = d.toString('utf8');
        onChunk?.(s);
        if (out.length < this.limits.maxOutputBytes) out += s;
        else truncated = true;
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      const guard = setTimeout(() => p.kill('SIGKILL'), (secs + 10) * 1000);
      p.on('close', (code) => {
        clearTimeout(guard);
        const exitCode = code ?? 137;
        if (out.length > this.limits.maxOutputBytes) { out = out.slice(0, this.limits.maxOutputBytes); truncated = true; }
        resolve({ exitCode, output: out, truncated, timedOut: exitCode === 137 || exitCode === 124, durationMs: Date.now() - started });
      });
    });
  }

  async destroyMission(missionId: string) {
    const ls = await docker(['ps', '-aq', '--filter', `label=nexus.mission=${missionId}`]);
    const ids = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length) await docker(['rm', '-f', ...ids]);
  }
}
