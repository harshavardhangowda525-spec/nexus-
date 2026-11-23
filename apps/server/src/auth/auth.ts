import crypto from 'node:crypto';
import { AGENT_IDS, type Role } from '@nexus/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tx, type Db } from '../db/pool.js';
import { hashPassword, sha256, verifyPassword } from '../util/crypto.js';

export const COOKIE = 'nexus_session';
const SESSION_DAYS = 14;
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export interface AuthContext { userId: string; workspaceId: string; role: Role; email: string; name: string }

declare module 'fastify' {
  interface FastifyRequest { auth?: AuthContext }
}

export class AuthError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}

export function validCredentials(email: string, password: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('Enter a valid email address', 400);
  if (password.length < 10) throw new AuthError('Use a password of at least 10 characters', 400);
}

/** First account only: creates the workspace, the owner, and the five agents (unconfigured). */
export async function bootstrap(db: Db, a: { email: string; name: string; password: string; workspaceName: string }) {
  validCredentials(a.email, a.password);
  return tx(db, async (c) => {
    await c.query('lock table users in exclusive mode');
    const n = (await c.query('select count(*)::int as n from users')).rows[0].n;
    if (n > 0) throw new AuthError('This server is already set up. Ask an admin to add you.', 403);
    const u = (await c.query('insert into users (email, name, password_hash) values ($1,$2,$3) returning id', [a.email.toLowerCase(), a.name, hashPassword(a.password)])).rows[0];
    const w = (await c.query('insert into workspaces (name) values ($1) returning id', [a.workspaceName])).rows[0];
    await c.query("insert into memberships (workspace_id, user_id, role) values ($1,$2,'owner')", [w.id, u.id]);
    for (const id of AGENT_IDS) await c.query('insert into agents (workspace_id, id) values ($1,$2)', [w.id, id]);
    return { userId: u.id as string, workspaceId: w.id as string };
  });
}

export async function addMember(db: Db, a: { workspaceId: string; email: string; name: string; password: string; role: Role }) {
  validCredentials(a.email, a.password);
  return tx(db, async (c) => {
    const existing = (await c.query('select id from users where email = $1', [a.email.toLowerCase()])).rows[0];
    const id = existing?.id ?? (await c.query('insert into users (email, name, password_hash) values ($1,$2,$3) returning id', [a.email.toLowerCase(), a.name, hashPassword(a.password)])).rows[0].id;
    await c.query('insert into memberships (workspace_id, user_id, role) values ($1,$2,$3) on conflict (workspace_id, user_id) do update set role = excluded.role', [a.workspaceId, id, a.role]);
    return id as string;
  });
}

export async function login(db: Db, email: string, password: string) {
  const u = (await db.query('select id, password_hash from users where email = $1', [email.toLowerCase()])).rows[0];
  // Hash even when the user is missing so timing does not reveal which emails exist.
  const ok = verifyPassword(password, u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  if (!u || !ok) throw new AuthError('Email or password is incorrect');
  const m = (await db.query('select workspace_id from memberships where user_id = $1 order by role desc limit 1', [u.id])).rows[0];
  if (!m) throw new AuthError('You are not a member of any workspace', 403);
  return createSession(db, u.id, m.workspace_id);
}

export async function createSession(db: Db, userId: string, workspaceId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query("insert into sessions (id, user_id, workspace_id, expires_at) values ($1,$2,$3, now() + interval '14 days')", [sha256(token), userId, workspaceId]);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const r = await db.query(
    `select s.user_id, s.workspace_id, m.role, u.email, u.name from sessions s
       join users u on u.id = s.user_id
       join memberships m on m.user_id = s.user_id and m.workspace_id = s.workspace_id
      where s.id = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
  const row = r.rows[0];
  return row ? { userId: row.user_id, workspaceId: row.workspace_id, role: row.role, email: row.email, name: row.name } : null;
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await db.query('delete from sessions where id = $1', [sha256(token)]);
}

/** Route guard: `requireRole('operator')` allows operators, admins and owners. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Sign in first' });
    if (RANK[req.auth.role] < RANK[min]) return reply.code(403).send({ error: `This needs the ${min} role or higher` });
  };
}
