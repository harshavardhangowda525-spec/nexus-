import fs from 'node:fs';
import path from 'node:path';
import { CommandExitError, Sandbox } from 'e2b';
import type { ExecOutcome } from './docker.js';

export interface ExecBackend {
  ensure(missionId: string, agentId: string, hostDir: string): Promise<string>;
  exec(name: string, command: string, timeoutMs: number, onChunk?: (s: string) => void): Promise<ExecOutcome>;
  destroyMission(missionId: string): Promise<void>;
}

const SKIP = new Set(['node_modules', '.git', '.next', '.cache']);
const REMOTE_ROOT = '/home/user/workspace';

interface Entry {
  sbx: Sandbox;
  hostDir: string;
  missionId: string;
}

/**
 * E2B cloud sandbox backend for agent execution (alternative to local Docker).
 * Enabled when SANDBOX_PROVIDER=e2b and E2B_API_KEY is set.
 * Syncs project files between the host workspace and /home/user/workspace inside E2B.
 */
export class E2BSandboxes implements ExecBackend {
  private sandboxes = new Map<string, Entry>();

  constructor(private opts: { apiKey: string; template?: string; maxOutputBytes: number }) {}

  async ensure(missionId: string, agentId: string, hostDir: string): Promise<string> {
    const key = `${missionId}:${agentId}`;
    const existing = this.sandboxes.get(key);
    if (existing) {
      await this.syncHostToRemote(existing);
      return key;
    }
    const createOpts = {
      apiKey: this.opts.apiKey,
      timeoutMs: 10 * 60_000,
      metadata: { nexus: '1', missionId, agentId },
    };
    const sbx = this.opts.template
      ? await Sandbox.create(this.opts.template, createOpts)
      : await Sandbox.create(createOpts);
    await sbx.commands.run(`mkdir -p ${REMOTE_ROOT}`);
    const entry: Entry = { sbx, hostDir, missionId };
    this.sandboxes.set(key, entry);
    await this.syncHostToRemote(entry);
    return key;
  }

  async exec(key: string, command: string, timeoutMs: number, onChunk?: (s: string) => void): Promise<ExecOutcome> {
    const entry = this.sandboxes.get(key);
    if (!entry) throw new Error(`E2B sandbox ${key} is not running`);
    await this.syncHostToRemote(entry);
    const started = Date.now();
    let out = '';
    let truncated = false;
    const append = (s: string) => {
      onChunk?.(s);
      if (out.length < this.opts.maxOutputBytes) out += s;
      else truncated = true;
    };

    try {
      const res = await entry.sbx.commands.run(command, {
        cwd: REMOTE_ROOT,
        timeoutMs,
        onStdout: append,
        onStderr: append,
      });
      await this.syncRemoteToHost(entry);
      if (out.length > this.opts.maxOutputBytes) {
        out = out.slice(0, this.opts.maxOutputBytes);
        truncated = true;
      }
      return {
        exitCode: res.exitCode,
        output: out || `${res.stdout}${res.stderr}`,
        truncated,
        timedOut: false,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      await this.syncRemoteToHost(entry).catch(() => {});
      if (err instanceof CommandExitError) {
        const combined = out || `${err.stdout}${err.stderr}`;
        return {
          exitCode: err.exitCode,
          output: combined.slice(0, this.opts.maxOutputBytes),
          truncated: truncated || combined.length > this.opts.maxOutputBytes,
          timedOut: false,
          durationMs: Date.now() - started,
        };
      }
      const msg = (err as Error).message || String(err);
      const timedOut = /timeout|timed out/i.test(msg);
      return {
        exitCode: timedOut ? 124 : 1,
        output: (out || msg).slice(0, this.opts.maxOutputBytes),
        truncated,
        timedOut,
        durationMs: Date.now() - started,
      };
    }
  }

  async destroyMission(missionId: string): Promise<void> {
    const targets: [string, Entry][] = [];
    for (const [k, v] of this.sandboxes) {
      if (v.missionId === missionId) targets.push([k, v]);
    }
    for (const [k, v] of targets) {
      this.sandboxes.delete(k);
      await v.sbx.kill().catch(() => {});
    }
  }

  async closeAll(): Promise<void> {
    const all = Array.from(this.sandboxes.values());
    this.sandboxes.clear();
    await Promise.all(all.map((v) => v.sbx.kill().catch(() => {})));
  }

  private async syncHostToRemote(entry: Entry) {
    if (!fs.existsSync(entry.hostDir)) return;
    const files: { path: string; data: ArrayBuffer }[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(abs);
        } else if (ent.isFile()) {
          const rel = path.relative(entry.hostDir, abs).split(path.sep).join('/');
          const buf = fs.readFileSync(abs);
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          files.push({ path: `${REMOTE_ROOT}/${rel}`, data: ab });
        }
      }
    };
    walk(entry.hostDir);
    if (files.length) {
      await entry.sbx.files.write(files);
    }
  }

  private async syncRemoteToHost(entry: Entry) {
    // List regular files inside REMOTE_ROOT (excluding .git / node_modules) and pull updates back.
    const find = await entry.sbx.commands
      .run(`find ${REMOTE_ROOT} -maxdepth 4 -type f -not -path '*/.git/*' -not -path '*/node_modules/*'`, { timeoutMs: 15_000 })
      .catch(() => null);
    if (!find || !find.stdout.trim()) return;
    const remotePaths = find.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(REMOTE_ROOT + '/'));
    for (const rp of remotePaths) {
      const rel = rp.slice(REMOTE_ROOT.length + 1);
      if (!rel || rel.includes('..')) continue;
      const dest = path.resolve(entry.hostDir, rel);
      if (!dest.startsWith(path.resolve(entry.hostDir) + path.sep)) continue;
      try {
        const bytes = await entry.sbx.files.read(rp, { format: 'bytes' });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(bytes));
      } catch {
        /* skip unreadable file */
      }
    }
  }
}
