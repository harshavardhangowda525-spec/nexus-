import fs from 'node:fs';
import path from 'node:path';

export class PathError extends Error {}

const SKIP = new Set(['node_modules', '.git', '.next', '.cache']);

/**
 * Host-side access to a project's shared files. Paths come from model output and the
 * sandbox can create symlinks inside the directory, so every access is confined to
 * the root both lexically and after resolving symlinks, and writes never follow a
 * symlink at the final component.
 */
export class ProjectFiles {
  readonly root: string;
  constructor(root: string, private owner?: { uid: number; gid: number }) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
    if (owner) this.chown(this.root);
  }

  /** Validates a relative path and returns the absolute host path. */
  resolve(rel: string): string {
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) throw new PathError('path must be 1-512 characters');
    if (rel.includes('\0')) throw new PathError('path contains a null byte');
    const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) throw new PathError('path must be relative to the project');
    const abs = path.resolve(this.root, norm);
    const relative = path.relative(this.root, abs);
    if (relative === '' ) return abs;
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new PathError('path escapes the project');
    // Resolve the deepest existing ancestor and make sure symlinks keep us inside.
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new PathError('path resolves outside the project');
    return abs;
  }

  rel(abs: string) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  write(rel: string, data: string | Buffer): { path: string; size: number } {
    const abs = this.resolve(rel);
    if (abs === this.root) throw new PathError('cannot write to the project root');
    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    if (dir !== this.root) this.resolve(this.rel(dir)); // re-check after mkdir
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) throw new PathError('refusing to write through a symlink');
    } catch (e) {
      if (e instanceof PathError) throw e;
    }
    const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o664);
    try { fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data); } finally { fs.closeSync(fd); }
    if (this.owner) {
      for (let d = dir; d.startsWith(this.root); d = path.dirname(d)) { this.chown(d); if (d === this.root) break; }
      this.chown(abs);
    }
    return { path: this.rel(abs), size: fs.statSync(abs).size };
  }

  read(rel: string, maxBytes = 200_000): { content: Buffer; truncated: boolean; size: number } {
    const abs = this.resolve(rel);
    const real = fs.realpathSync(abs);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new PathError('path resolves outside the project');
    const st = fs.statSync(real);
    if (!st.isFile()) throw new PathError('not a file');
    const fd = fs.openSync(real, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return { content: buf, truncated: st.size > maxBytes, size: st.size };
    } finally { fs.closeSync(fd); }
  }

  list(rel = '.', limit = 400): { path: string; size: number; dir: boolean }[] {
    const start = rel === '.' || rel === '' ? this.root : this.resolve(rel);
    const out: { path: string; size: number; dir: boolean }[] = [];
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (out.length >= limit) return;
        if (SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
        const abs = path.join(d, ent.name);
        if (ent.isDirectory()) { out.push({ path: this.rel(abs), size: 0, dir: true }); walk(abs); }
        else if (ent.isFile()) out.push({ path: this.rel(abs), size: fs.statSync(abs).size, dir: false });
      }
    };
    if (fs.existsSync(start)) walk(start);
    return out;
  }

  private chown(p: string) {
    try { if (this.owner) fs.chownSync(p, this.owner.uid, this.owner.gid); } catch { /* not root: sandbox uses host uid */ }
  }
}

export function parseUid(spec: string): { uid: number; gid: number } | undefined {
  const [u, g] = spec.split(':').map(Number);
  return Number.isInteger(u) && Number.isInteger(g) ? { uid: u, gid: g } : undefined;
}
