import type { AgentId, ProviderKind } from '@nexus/shared';
import type { Queryable } from '../db/pool.js';
import type { ModelTarget } from '../models/types.js';
import type { SecretBox } from '../util/crypto.js';

export type AgentTarget =
  | { ok: true; target: ModelTarget; maxSteps: number }
  | { ok: false; reason: string };

/** Resolves an agent's model configuration. Secrets are decrypted only here, in the worker. */
export async function loadAgentTarget(db: Queryable, secrets: SecretBox | null, workspaceId: string, agentId: AgentId): Promise<AgentTarget> {
  const r = await db.query(
    `select a.enabled, a.model, a.effort, a.max_steps, c.provider, c.base_url, c.secret_ciphertext
       from agents a left join provider_credentials c on c.id = a.credential_id
      where a.workspace_id = $1 and a.id = $2`,
    [workspaceId, agentId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: `${agentId.toUpperCase()} is not set up in this workspace` };
  if (!row.enabled) return { ok: false, reason: `${agentId.toUpperCase()} is disabled` };
  if (!row.provider) return { ok: false, reason: `${agentId.toUpperCase()} has no model provider. Choose one in Workforce.` };
  if (!row.model) return { ok: false, reason: `${agentId.toUpperCase()} has no model selected. Choose one in Workforce.` };
  const provider = row.provider as ProviderKind;
  let apiKey: string | undefined;
  if (row.secret_ciphertext) {
    if (!secrets) return { ok: false, reason: 'NEXUS_MASTER_KEY is not set, so stored API keys cannot be decrypted' };
    try { apiKey = secrets.open(row.secret_ciphertext); } catch { return { ok: false, reason: 'Stored API key could not be decrypted (was NEXUS_MASTER_KEY changed?)' }; }
  } else if (provider !== 'ollama') {
    return { ok: false, reason: `The ${provider} credential has no API key` };
  }
  return { ok: true, target: { provider, model: row.model, apiKey, baseUrl: row.base_url, effort: row.effort }, maxSteps: row.max_steps };
}
