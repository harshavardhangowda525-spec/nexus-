import type { Queryable } from '../db/pool.js';
import { sha256 } from '../util/crypto.js';

/** Stores a new version of a project file if its content changed. Returns the version number. */
export async function recordArtifact(db: Queryable, a: { projectId: string; missionId: string | null; path: string; agentId: string | null; content: Buffer }) {
  const hash = sha256(a.content);
  const last = await db.query('select version, sha256 from artifacts where project_id = $1 and path = $2 order by version desc limit 1', [a.projectId, a.path]);
  if (last.rows[0]?.sha256 === hash) return { version: last.rows[0].version as number, changed: false };
  const version = (last.rows[0]?.version ?? 0) + 1;
  await db.query(
    'insert into artifacts (project_id, mission_id, path, version, size, sha256, agent_id, content) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [a.projectId, a.missionId, a.path, version, a.content.length, hash, a.agentId, a.content],
  );
  return { version, changed: true };
}
