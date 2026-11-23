import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

export interface EgressPolicy { allow: string[]; deny: string[]; ports?: number[] }
export interface EgressGrant { workspaceId: string; missionId: string; agentId: string }
export type EgressLog = (e: { grant: EgressGrant | null; host: string; port: number; allowed: boolean; reason: string }) => void;

const BLOCKED_NAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata$/i];

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

const matches = (host: string, pattern: string) => host === pattern || host.endsWith('.' + pattern);

/** Pure policy decision on the requested host name (before DNS). */
export function checkHost(host: string, port: number, policy: EgressPolicy): { ok: boolean; reason: string } {
  const h = host.toLowerCase().replace(/\.$/, '');
  const ports = policy.ports ?? [80, 443];
  if (!ports.includes(port)) return { ok: false, reason: `port ${port} not allowed` };
  if (net.isIP(h)) return isPrivateIp(h) ? { ok: false, reason: 'private address' } : { ok: true, reason: 'public ip' };
  if (BLOCKED_NAMES.some((r) => r.test(h))) return { ok: false, reason: 'internal host name' };
  if (policy.deny.some((d) => matches(h, d.toLowerCase()))) return { ok: false, reason: 'denied by policy' };
  if (policy.allow.length && !policy.allow.some((a) => matches(h, a.toLowerCase()))) return { ok: false, reason: 'not on allowlist' };
  return { ok: true, reason: 'allowed' };
}

/**
 * HTTP(S) forward proxy for sandboxes. Each sandbox gets a random token
 * (Proxy-Authorization) that ties its traffic to a mission and agent for the audit log.
 */
export class EgressGateway {
  private grants = new Map<string, EgressGrant>();
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();
  private upstream: URL | null;
  port = 0;
  host = '';

  constructor(private policy: EgressPolicy, upstreamProxy: string, private log: EgressLog = () => {}) {
    this.upstream = upstreamProxy ? new URL(upstreamProxy) : null;
  }

  issue(grant: EgressGrant) {
    const token = crypto.randomBytes(18).toString('base64url');
    this.grants.set(token, grant);
    return { username: 'sandbox', password: token };
  }
  revoke(password: string) { this.grants.delete(password); }

  private auth(req: http.IncomingMessage): EgressGrant | null {
    const h = req.headers['proxy-authorization'];
    if (!h || !h.startsWith('Basic ')) return null;
    const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    return (pass && this.grants.get(pass)) || null;
  }

  /** Resolves locally when possible; refuses names that resolve to private addresses. */
  private async resolveTarget(host: string): Promise<{ ok: boolean; reason: string; address?: string }> {
    if (net.isIP(host)) return { ok: true, reason: 'ip', address: host };
    try {
      const addrs = await dns.lookup(host, { all: true });
      if (addrs.some((a) => isPrivateIp(a.address))) return { ok: false, reason: 'resolves to a private address' };
      return { ok: true, reason: 'resolved', address: addrs[0]?.address };
    } catch {
      // No local DNS (proxy-only networks): let the upstream proxy resolve it.
      return this.upstream ? { ok: true, reason: 'resolved upstream' } : { ok: false, reason: 'dns lookup failed' };
    }
  }

  private connectOut(host: string, port: number, address: string | undefined): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      if (!this.upstream) {
        const s = net.connect(port, address || host, () => resolve(s));
        s.once('error', reject);
        return;
      }
      const s = net.connect(Number(this.upstream.port || 80), this.upstream.hostname, () => {
        const auth = this.upstream!.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(this.upstream!.username)}:${decodeURIComponent(this.upstream!.password)}`).toString('base64')}\r\n` : '';
        s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
        let buf = '';
        const onData = (d: Buffer) => {
          buf += d.toString('latin1');
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          s.off('data', onData);
          const status = Number(buf.split(' ')[1]);
          if (status !== 200) { s.destroy(); reject(new Error(`upstream proxy refused: ${status}`)); return; }
          const rest = Buffer.from(buf.slice(end + 4), 'latin1');
          if (rest.length) s.unshift(rest);
          resolve(s);
        };
        s.on('data', onData);
      });
      s.once('error', reject);
    });
  }

  async start(host: string, port: number) {
    this.server = http.createServer(async (req, res) => {
      // Plain http:// requests arrive in absolute form; same policy and audit as CONNECT.
      const grant = this.auth(req);
      let target: URL;
      try { target = new URL(req.url || ''); } catch { res.writeHead(400).end('Bad request'); return; }
      const port = Number(target.port || 80);
      const deny = (code: number, reason: string) => {
        this.log({ grant, host: target.hostname, port, allowed: false, reason });
        res.writeHead(code, { 'content-type': 'text/plain', 'x-nexus-reason': reason, ...(code === 407 ? { 'proxy-authenticate': 'Basic realm="nexus"' } : {}) })
          .end(`Blocked by NEXUS egress policy: ${reason}`);
      };
      if (!grant) return deny(407, 'missing or unknown sandbox token');
      if (target.protocol !== 'http:') return deny(400, 'unsupported scheme');
      const pol = checkHost(target.hostname, port, this.policy);
      if (!pol.ok) return deny(403, pol.reason);
      const dnsCheck = await this.resolveTarget(target.hostname);
      if (!dnsCheck.ok) return deny(403, dnsCheck.reason);
      try {
        const out = await this.connectOut(target.hostname, port, dnsCheck.address);
        this.log({ grant, host: target.hostname, port, allowed: true, reason: pol.reason });
        const headers = Object.entries(req.headers)
          .filter(([k]) => !/^proxy-|^connection$|^keep-alive$/i.test(k))
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
        out.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`);
        req.pipe(out);
        out.pipe(res.socket!);
        out.on('error', () => res.socket?.destroy());
      } catch (e) {
        deny(502, `connect failed: ${(e as Error).message}`);
      }
    });
    this.server.on('connect', async (req, client, head) => {
      const grant = this.auth(req);
      const [h, p] = (req.url || '').split(':');
      const port = Number(p || 443);
      const deny = (code: number, reason: string) => {
        this.log({ grant, host: h, port, allowed: false, reason });
        client.end(`HTTP/1.1 ${code} ${code === 407 ? 'Proxy Authentication Required' : 'Forbidden'}\r\nProxy-Authenticate: Basic realm="nexus"\r\nX-Nexus-Reason: ${reason}\r\n\r\n`);
      };
      if (!grant) return deny(407, 'missing or unknown sandbox token');
      const pol = checkHost(h, port, this.policy);
      if (!pol.ok) return deny(403, pol.reason);
      const dnsCheck = await this.resolveTarget(h);
      if (!dnsCheck.ok) return deny(403, dnsCheck.reason);
      try {
        const out = await this.connectOut(h, port, dnsCheck.address);
        this.log({ grant, host: h, port, allowed: true, reason: pol.reason });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) out.write(head);
        out.pipe(client); client.pipe(out);
        out.on('error', () => client.destroy());
        client.on('error', () => out.destroy());
      } catch (e) {
        deny(502, `connect failed: ${(e as Error).message}`);
      }
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const a = this.server.address() as net.AddressInfo;
    this.port = a.port;
    this.host = host;
  }

  async stop() {
    if (!this.server) return;
    const srv = this.server;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => {
      srv.close(() => r());
      srv.closeAllConnections();
    });
  }
}
