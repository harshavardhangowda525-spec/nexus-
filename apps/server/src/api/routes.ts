import path from 'node:path';
import { AGENT_IDS, AGENT_PROFILES, type AgentConfigView, type AgentId, type CredentialView, type ProviderKind, type SetupStatus } from '@nexus/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadAgentTarget } from '../agents/config.js';
import { addMember, AuthError, bootstrap, COOKIE, createSession, destroySession, login, requireRole, resolveSession } from '../auth/auth.js';
import { audit, rowToEvent } from '../events/bus.js';
import { DEFAULT_MODELS } from '../models/gateway.js';
import { decideApproval, toApprovalView } from '../orchestrator/approvals.js';
import { controlMission, createMission, getMission, MissionError, retryTask } from '../orchestrator/missions.js';
import { frameKey, getAgentStates, projectFiles, type Runtime } from '../runtime.js';
import { PathError } from '../sandbox/workspace.js';
import { hint } from '../util/crypto.js';

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama'] as const;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
};

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new MissionError(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400);
  return r.data;
}

export async function registerRoutes(app: FastifyInstance, rt: Runtime) {
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: rt.cfg.cookieSecure };

  app.addHook('onRequest', async (req) => {
    req.auth = (await resolveSession(rt.db, req.cookies[COOKIE])) ?? undefined;
  });

  // CSRF: mutating requests must be JSON and come from an allowed origin (cookies are SameSite=Lax too).
  app.addHook('preHandler', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !rt.cfg.webOrigins.includes(origin)) return reply.code(403).send({ error: 'Origin not allowed' });
    const ct = req.headers['content-type'] ?? '';
    if (req.body !== undefined && !ct.startsWith('application/json')) return reply.code(415).send({ error: 'Send JSON' });
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof MissionError || err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof PathError) return reply.code(400).send({ error: err.message });
    if (err.validation) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on the server. Check the server log.' });
  });

  const authed = { preHandler: requireRole('viewer') };
  const operator = { preHandler: requireRole('operator') };
  const admin = { preHandler: requireRole('admin') };

  /* ---------------- health & setup ---------------- */
  app.get('/api/health', async () => {
    const db = await rt.db.query('select 1').then(() => true, () => false);
    const redis = await rt.redis.ping().then((r) => r === 'PONG', () => false);
    return {
      ok: db && redis,
      db,
      redis,
      sandbox: rt.sandbox,
      sandboxProvider: rt.cfg.sandbox.provider === 'e2b' && rt.cfg.sandbox.e2bApiKey ? 'e2b' : 'docker',
      authProvider: rt.supabaseAuth ? 'supabase' : 'local',
      worker: rt.cfg.runWorker,
    };
  });

  app.get('/api/setup', authed, async (req): Promise<SetupStatus & { needsBootstrap: false }> => {
    const ws = req.auth!.workspaceId;
    const creds = (await rt.db.query('select count(*)::int as n from provider_credentials where workspace_id = $1', [ws])).rows[0].n;
    const agents = [];
    for (const id of AGENT_IDS) {
      const t = await loadAgentTarget(rt.db, rt.secrets, ws, id);
      agents.push({ id, configured: t.ok, reason: t.ok ? null : t.reason });
    }
    return { needsBootstrap: false, hasCredentials: creds > 0, agents, sandbox: rt.sandbox };
  });

  /* ---------------- auth ---------------- */
  app.get('/api/auth/state', async (req) => {
    const n = (await rt.db.query('select count(*)::int as n from users')).rows[0].n;
    return {
      needsBootstrap: n === 0,
      authProvider: rt.supabaseAuth ? 'supabase' : 'local',
      user: req.auth ? { email: req.auth.email, name: req.auth.name, role: req.auth.role, workspaceId: req.auth.workspaceId } : null,
    };
  });

  app.post('/api/auth/bootstrap', async (req, reply) => {
    const b = parse(z.object({ email: z.string(), name: z.string().min(1).max(80), password: z.string(), workspaceName: z.string().min(1).max(80) }), req.body);
    if (rt.supabaseAuth) {
      await rt.supabaseAuth.signUp(b.email, b.password, b.name);
    }
    const r = await bootstrap(rt.db, b);
    const s = await createSession(rt.db, r.userId, r.workspaceId);
    await audit(rt.db, { workspaceId: r.workspaceId, actorType: 'user', actorId: r.userId, action: 'workspace.bootstrap', detail: { authProvider: rt.supabaseAuth ? 'supabase' : 'local' } });
    reply.setCookie(COOKIE, s.token, { ...cookieOpts, maxAge: s.maxAge });
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    let s: { token: string; maxAge: number };
    if (rt.supabaseAuth) {
      await rt.supabaseAuth.signIn(b.email, b.password);
      const u = (await rt.db.query('select id from users where email = $1', [b.email.toLowerCase()])).rows[0];
      if (!u) throw new AuthError('No NEXUS workspace membership found for this Supabase account', 403);
      const m = (await rt.db.query('select workspace_id from memberships where user_id = $1 order by role desc limit 1', [u.id])).rows[0];
      if (!m) throw new AuthError('You are not a member of any workspace', 403);
      s = await createSession(rt.db, u.id, m.workspace_id);
    } else {
      s = await login(rt.db, b.email, b.password);
    }
    reply.setCookie(COOKIE, s.token, { ...cookieOpts, maxAge: s.maxAge });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(rt.db, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/members', admin, async (req) =>
    (await rt.db.query('select u.id, u.email, u.name, m.role from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 order by u.created_at', [req.auth!.workspaceId])).rows);

  app.post('/api/members', admin, async (req) => {
    const b = parse(z.object({ email: z.string(), name: z.string().min(1).max(80), password: z.string(), role: z.enum(['admin', 'operator', 'viewer']) }), req.body);
    if (rt.supabaseAuth) {
      await rt.supabaseAuth.signUp(b.email, b.password, b.name);
    }
    const id = await addMember(rt.db, { ...b, workspaceId: req.auth!.workspaceId });
    await audit(rt.db, { workspaceId: req.auth!.workspaceId, actorType: 'user', actorId: req.auth!.userId, action: 'member.add', target: id, detail: { role: b.role } });
    return { id };
  });

  /* ---------------- credentials ---------------- */
  const credView = (r: any): CredentialView => ({ id: r.id, provider: r.provider, label: r.label, baseUrl: r.base_url, hasSecret: !!r.secret_ciphertext, secretHint: r.secret_hint, createdAt: r.created_at.toISOString() });

  app.get('/api/credentials', authed, async (req) =>
    (await rt.db.query('select * from provider_credentials where workspace_id = $1 order by created_at', [req.auth!.workspaceId])).rows.map(credView));

  app.post('/api/credentials', admin, async (req) => {
    const b = parse(z.object({
      provider: z.enum(PROVIDERS), label: z.string().min(1).max(60),
      baseUrl: z.string().url().max(300).optional().nullable(), apiKey: z.string().max(400).optional().nullable(),
    }), req.body);
    if (b.provider !== 'ollama' && !b.apiKey) throw new MissionError('An API key is required for this provider');
    if (b.apiKey && !rt.secrets) throw new MissionError('Set NEXUS_MASTER_KEY on the server before storing API keys', 409);
    const r = await rt.db.query(
      'insert into provider_credentials (workspace_id, provider, label, base_url, secret_ciphertext, secret_hint) values ($1,$2,$3,$4,$5,$6) returning *',
      [req.auth!.workspaceId, b.provider, b.label, b.baseUrl || null, b.apiKey ? rt.secrets!.seal(b.apiKey) : null, b.apiKey ? hint(b.apiKey) : null],
    ).catch((e) => { if (e.code === '23505') throw new MissionError('A credential with that label already exists', 409); throw e; });
    await audit(rt.db, { workspaceId: req.auth!.workspaceId, actorType: 'user', actorId: req.auth!.userId, action: 'credential.create', target: r.rows[0].id, detail: { provider: b.provider } });
    return credView(r.rows[0]);
  });

  app.delete('/api/credentials/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const r = await rt.db.query('delete from provider_credentials where id = $1 and workspace_id = $2', [id, req.auth!.workspaceId]);
    if (!r.rowCount) throw new MissionError('Credential not found', 404);
    await audit(rt.db, { workspaceId: req.auth!.workspaceId, actorType: 'user', actorId: req.auth!.userId, action: 'credential.delete', target: id });
    return { ok: true };
  });

  app.post('/api/credentials/:id/test', admin, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ model: z.string().min(1).max(120) }), req.body);
    const c = (await rt.db.query('select * from provider_credentials where id = $1 and workspace_id = $2', [id, req.auth!.workspaceId])).rows[0];
    if (!c) throw new MissionError('Credential not found', 404);
    const apiKey = c.secret_ciphertext ? rt.secrets?.open(c.secret_ciphertext) : undefined;
    try {
      const r = await rt.gateway.chat({ provider: c.provider, model: b.model, apiKey, baseUrl: c.base_url },
        { system: 'Reply with the single word: ready', messages: [{ role: 'user', content: [{ type: 'text', text: 'Status check' }] }], tools: [], maxTokens: 2000 });
      const text = r.content.filter((x) => x.type === 'text').map((x: any) => x.text).join(' ').slice(0, 120);
      return { ok: true, model: r.model, reply: text, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 400) };
    }
  });

  app.get('/api/credentials/:id/models', authed, async (req) => {
    const { id } = req.params as { id: string };
    const c = (await rt.db.query('select * from provider_credentials where id = $1 and workspace_id = $2', [id, req.auth!.workspaceId])).rows[0];
    if (!c) throw new MissionError('Credential not found', 404);
    if (c.provider !== 'ollama' && c.provider !== 'openai') return { models: [DEFAULT_MODELS[c.provider as ProviderKind]] };
    const base = (c.base_url || (c.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
    const apiKey = c.secret_ciphertext ? rt.secrets?.open(c.secret_ciphertext) : undefined;
    try {
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { models: [] };
      const data = (await res.json()) as any;
      const models: string[] = (data.data || [])
        .map((m: any) => String(m.id || ''))
        .filter((m: string) => m && !/whisper|tts|guard|playai|orpheus/i.test(m));
      return { models };
    } catch {
      return { models: [] };
    }
  });

  /* ---------------- agents ---------------- */
  app.get('/api/agents', authed, async (req): Promise<AgentConfigView[]> => {
    const ws = req.auth!.workspaceId;
    const rows = (await rt.db.query('select a.*, c.provider from agents a left join provider_credentials c on c.id = a.credential_id where a.workspace_id = $1', [ws])).rows;
    const stats = (await rt.db.query(
      `select t.agent_id,
              count(*) filter (where t.status = 'completed')::int as completed,
              count(*) filter (where t.status = 'failed')::int as failed,
              count(*) filter (where t.status in ('queued','running','waiting_approval'))::int as active
         from tasks t join missions m on m.id = t.mission_id where m.workspace_id = $1 group by t.agent_id`, [ws])).rows;
    const usage = (await rt.db.query('select agent_id, sum(input_tokens + output_tokens)::int as tokens, sum(cost_usd) as cost from usage where workspace_id = $1 group by agent_id', [ws])).rows;
    const out: AgentConfigView[] = [];
    for (const id of AGENT_IDS) {
      const r = rows.find((x) => x.id === id);
      const s = stats.find((x) => x.agent_id === id);
      const u = usage.find((x) => x.agent_id === id);
      const t = await loadAgentTarget(rt.db, rt.secrets, ws, id);
      out.push({
        id, name: AGENT_PROFILES[id].name, role: AGENT_PROFILES[id].role, enabled: r?.enabled ?? false, credentialId: r?.credential_id ?? null,
        provider: r?.provider ?? null, model: r?.model ?? null, effort: r?.effort ?? null, maxSteps: r?.max_steps ?? 30, configured: t.ok,
        stats: { completed: s?.completed ?? 0, failed: s?.failed ?? 0, active: s?.active ?? 0, tokens: u?.tokens ?? 0, costUsd: u?.cost ?? 0 },
      });
    }
    return out;
  });

  app.patch('/api/agents/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    if (!AGENT_IDS.includes(id as AgentId)) throw new MissionError('Unknown agent', 404);
    const b = parse(z.object({
      credentialId: z.string().uuid().nullable().optional(), model: z.string().max(120).nullable().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(), maxSteps: z.number().int().min(3).max(200).optional(), enabled: z.boolean().optional(),
    }), req.body);
    if (b.credentialId) {
      const c = await rt.db.query('select 1 from provider_credentials where id = $1 and workspace_id = $2', [b.credentialId, req.auth!.workspaceId]);
      if (!c.rowCount) throw new MissionError('Credential not found', 404);
    }
    const sets: string[] = []; const vals: unknown[] = [req.auth!.workspaceId, id];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.credentialId !== undefined) add('credential_id', b.credentialId);
    if (b.model !== undefined) add('model', b.model || null);
    if (b.effort !== undefined) add('effort', b.effort);
    if (b.maxSteps !== undefined) add('max_steps', b.maxSteps);
    if (b.enabled !== undefined) add('enabled', b.enabled);
    if (sets.length) await rt.db.query(`update agents set ${sets.join(', ')} where workspace_id = $1 and id = $2`, vals);
    await audit(rt.db, { workspaceId: req.auth!.workspaceId, actorType: 'user', actorId: req.auth!.userId, action: 'agent.configure', target: id, detail: b });
    return { ok: true };
  });

  app.get('/api/models/defaults', authed, async () => DEFAULT_MODELS);

  /* ---------------- office state ---------------- */
  app.get('/api/office', authed, async (req) => {
    const ws = req.auth!.workspaceId;
    const states = await getAgentStates(rt, ws);
    const frames: Record<string, unknown> = {};
    for (const id of AGENT_IDS) { const f = await rt.redis.get(frameKey(ws, id)); if (f) frames[id] = JSON.parse(f); }
    const active = (await rt.db.query("select id from missions where workspace_id = $1 order by (status in ('planning','running','paused')) desc, created_at desc limit 1", [ws])).rows[0];
    return { states, frames, missionId: active?.id ?? null };
  });

  /* ---------------- missions ---------------- */
  app.get('/api/missions', authed, async (req) =>
    (await rt.db.query('select id, brief, status, budget_usd, spent_usd, created_at, project_id from missions where workspace_id = $1 order by created_at desc limit 50', [req.auth!.workspaceId])).rows
      .map((m) => ({ id: m.id, brief: m.brief, status: m.status, budgetUsd: m.budget_usd, spentUsd: m.spent_usd, createdAt: m.created_at.toISOString(), projectId: m.project_id })));

  app.post('/api/missions', operator, async (req) => {
    const b = parse(z.object({ brief: z.string(), budgetUsd: z.number().optional(), projectId: z.string().uuid().nullable().optional() }), req.body);
    return createMission(rt, { workspaceId: req.auth!.workspaceId, userId: req.auth!.userId, brief: b.brief, budgetUsd: b.budgetUsd, projectId: b.projectId });
  });

  app.get('/api/missions/:id', authed, async (req, reply) => {
    const m = await getMission(rt, req.auth!.workspaceId, (req.params as any).id);
    if (!m) return reply.code(404).send({ error: 'Mission not found' });
    const approvals = (await rt.db.query('select * from approvals where mission_id = $1 order by created_at', [m.id])).rows.map(toApprovalView);
    return { ...m, approvals };
  });

  app.get('/api/missions/:id/events', authed, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { after?: string; limit?: string };
    const r = await rt.db.query(
      'select * from events where mission_id = $1 and workspace_id = $2 and id > $3 order by id limit $4',
      [id, req.auth!.workspaceId, Number(q.after ?? 0), Math.min(Number(q.limit ?? 2000), 5000)],
    );
    return r.rows.map(rowToEvent);
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/missions/:id/${action}`, operator, async (req) => {
      const b = parse(z.object({ budgetUsd: z.number().positive().max(1000).optional() }), req.body);
      await controlMission(rt, { workspaceId: req.auth!.workspaceId, userId: req.auth!.userId, missionId: (req.params as any).id, action, budgetUsd: b.budgetUsd });
      return { ok: true };
    });
  }

  app.post('/api/tasks/:id/retry', operator, async (req) => {
    const b = parse(z.object({ budgetUsd: z.number().positive().max(1000).optional() }), req.body);
    await retryTask(rt, { workspaceId: req.auth!.workspaceId, userId: req.auth!.userId, taskId: (req.params as any).id, budgetUsd: b.budgetUsd });
    return { ok: true };
  });

  /* ---------------- approvals ---------------- */
  app.get('/api/approvals', authed, async (req) => {
    const status = (req.query as any).status;
    const r = await rt.db.query(`select * from approvals where workspace_id = $1 ${status ? 'and status = $2' : ''} order by created_at desc limit 100`, status ? [req.auth!.workspaceId, status] : [req.auth!.workspaceId]);
    return r.rows.map(toApprovalView);
  });

  app.post('/api/approvals/:id/decide', operator, async (req) => {
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }), req.body);
    await decideApproval(rt, { workspaceId: req.auth!.workspaceId, userId: req.auth!.userId, approvalId: (req.params as any).id, decision: b.decision, note: b.note });
    return { ok: true };
  });

  app.get('/api/outbox', authed, async (req) =>
    (await rt.db.query('select id, approval_id, channel, payload, status, detail, created_at from outbox where workspace_id = $1 order by created_at desc limit 100', [req.auth!.workspaceId])).rows);

  /* ---------------- projects & files ---------------- */
  const ownProject = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) throw new MissionError('Project not found', 404);
    const p = (await rt.db.query('select * from projects where id = $1 and workspace_id = $2', [id, req.auth!.workspaceId])).rows[0];
    if (!p) throw new MissionError('Project not found', 404);
    return p;
  };

  app.get('/api/projects', authed, async (req) =>
    (await rt.db.query(
      `select p.id, p.name, p.description, p.created_at,
              (select count(*)::int from missions m where m.project_id = p.id) as missions,
              (select status from missions m where m.project_id = p.id order by created_at desc limit 1) as last_status,
              (select count(distinct path)::int from artifacts a where a.project_id = p.id) as files
         from projects p where p.workspace_id = $1 order by p.created_at desc`, [req.auth!.workspaceId])).rows);

  app.get('/api/projects/:id/files', authed, async (req) => {
    const p = await ownProject(req);
    const files = projectFiles(rt, p.id).list('.', 1000);
    const versions = (await rt.db.query('select path, max(version) as version, (array_agg(agent_id order by version desc))[1] as agent_id, max(created_at) as updated_at from artifacts where project_id = $1 group by path', [p.id])).rows;
    return files.map((f) => {
      const v = versions.find((x) => x.path === f.path);
      return { ...f, version: v?.version ?? null, agentId: v?.agent_id ?? null, updatedAt: v?.updated_at?.toISOString() ?? null };
    });
  });

  app.get('/api/projects/:id/history', authed, async (req) => {
    const p = await ownProject(req);
    const file = (req.query as any).path as string | undefined;
    return (await rt.db.query(`select path, version, size, sha256, agent_id, mission_id, created_at from artifacts where project_id = $1 ${file ? 'and path = $2' : ''} order by created_at desc limit 300`, file ? [p.id, file] : [p.id])).rows;
  });

  app.get('/api/projects/:id/file', authed, async (req, reply) => {
    const p = await ownProject(req);
    const q = req.query as { path?: string; version?: string };
    if (!q.path) throw new MissionError('path is required');
    let buf: Buffer;
    if (q.version) {
      const r = (await rt.db.query('select content from artifacts where project_id = $1 and path = $2 and version = $3', [p.id, q.path, Number(q.version)])).rows[0];
      if (!r) throw new MissionError('Version not found', 404);
      buf = r.content;
    } else {
      buf = projectFiles(rt, p.id).read(q.path, 2_000_000).content;
    }
    const ext = path.extname(q.path).toLowerCase();
    // Files are always delivered as inert content here; use /preview to run a site.
    const type = ext in MIME && MIME[ext].startsWith('image/') && ext !== '.svg' ? MIME[ext] : 'text/plain; charset=utf-8';
    return reply.header('content-type', type).header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox").send(buf);
  });

  // Live preview of a project's website. Served with a CSP sandbox (opaque origin), so
  // agent-written scripts cannot read NEXUS cookies or call the API as the viewer.
  const preview = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await ownProject(req);
    let rel = ((req.params as any)['*'] as string) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const files = projectFiles(rt, p.id);
    let data: Buffer;
    try { data = files.read(rel, 5_000_000).content; }
    catch { try { data = files.read(path.posix.join(rel, 'index.html'), 5_000_000).content; rel = path.posix.join(rel, 'index.html'); } catch { return reply.code(404).type('text/plain').send('Not found in project'); } }
    return reply
      .header('content-type', MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox allow-scripts allow-forms allow-popups; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors " + rt.cfg.webOrigins.join(' '))
      .header('cache-control', 'no-store')
      .send(data);
  };
  app.get('/preview/:id/*', authed, preview);
  app.get('/preview/:id', authed, async (req, reply) => reply.redirect(`/preview/${(req.params as any).id}/`));

  /* ---------------- insights & audit ---------------- */
  app.get('/api/insights', authed, async (req) => {
    const ws = req.auth!.workspaceId;
    const days = Math.min(Number((req.query as any).days ?? 30), 365);
    const tasks = (await rt.db.query(
      `select t.agent_id, t.status, extract(epoch from (t.finished_at - t.started_at)) as secs
         from tasks t join missions m on m.id = t.mission_id
        where m.workspace_id = $1 and t.created_at > now() - ($2 || ' days')::interval`, [ws, days])).rows;
    const usage = (await rt.db.query(
      `select agent_id, model, sum(input_tokens)::int as input_tokens, sum(output_tokens)::int as output_tokens, sum(cost_usd) as cost, bool_and(priced) as priced, count(*)::int as calls
         from usage where workspace_id = $1 and created_at > now() - ($2 || ' days')::interval group by agent_id, model`, [ws, days])).rows;
    const daily = (await rt.db.query(
      `select date_trunc('day', created_at) as day, sum(input_tokens + output_tokens)::int as tokens, sum(cost_usd) as cost
         from usage where workspace_id = $1 and created_at > now() - ($2 || ' days')::interval group by 1 order by 1`, [ws, days])).rows;
    const missions = (await rt.db.query(`select status, count(*)::int as n from missions where workspace_id = $1 and created_at > now() - ($2 || ' days')::interval group by status`, [ws, days])).rows;
    const errors = (await rt.db.query(`select agent_id, payload->>'message' as message, created_at from events where workspace_id = $1 and type = 'error' order by id desc limit 20`, [ws])).rows;
    // Utilization: share of the window each agent spent with a task running.
    const busy = (await rt.db.query(
      `select t.agent_id, sum(extract(epoch from (coalesce(t.finished_at, now()) - t.started_at)))::float as secs
         from tasks t join missions m on m.id = t.mission_id
        where m.workspace_id = $1 and t.started_at is not null and t.started_at > now() - ($2 || ' days')::interval group by t.agent_id`, [ws, days])).rows;
    return { days, tasks, usage, daily: daily.map((d) => ({ ...d, day: d.day.toISOString() })), missions, errors, busy };
  });

  app.get('/api/audit', admin, async (req) =>
    (await rt.db.query('select * from audit_log where workspace_id = $1 order by id desc limit 200', [req.auth!.workspaceId])).rows);
}
