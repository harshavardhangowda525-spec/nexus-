'use client';

import {
  AGENT_IDS,
  AGENT_PROFILES,
  PROVIDER_LABELS,
  type AgentConfigView,
  type AgentId,
  type CredentialView,
  type ProviderKind,
  type Role,
} from '@nexus/shared';
import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type ArtifactHistoryItem,
  type AuditItem,
  type HealthResponse,
  type InsightsData,
  type MemberItem,
  type OutboxItem,
  type ProjectFileItem,
  type ProjectSummary,
} from '@/lib/api';

/* ============================================================================
 * WORKFORCE SHEET
 * ========================================================================== */

export function WorkforceSheet({
  agents,
  credentials,
  defaults,
  onChanged,
}: {
  agents: AgentConfigView[];
  credentials: CredentialView[];
  defaults: Record<ProviderKind, string>;
  onChanged: () => Promise<void>;
}) {
  const [provider, setProvider] = useState<ProviderKind>('openai');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [credMsg, setCredMsg] = useState<string | null>(null);
  const [credErr, setCredErr] = useState<string | null>(null);
  const [testModel, setTestModel] = useState<Record<string, string>>({});
  const [credModels, setCredModels] = useState<Record<string, string[]>>({});
  const [testOut, setTestOut] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [drafts, setDrafts] = useState<
    Record<AgentId, { credentialId: string; model: string; effort: string; maxSteps: number; enabled: boolean }>
  >(() => {
    const d = {} as any;
    for (const id of AGENT_IDS) {
      const a = agents.find((x) => x.id === id);
      d[id] = {
        credentialId: a?.credentialId ?? '',
        model: a?.model ?? '',
        effort: a?.effort ?? '',
        maxSteps: a?.maxSteps ?? 30,
        enabled: a?.enabled ?? true,
      };
    }
    return d;
  });
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    for (const c of credentials) {
      api.credentialModels(c.id)
        .then((r) => {
          if (!r.models.length) return;
          setCredModels((p) => ({ ...p, [c.id]: r.models }));
          setTestModel((p) => (p[c.id] ? p : { ...p, [c.id]: r.models[0] }));
        })
        .catch(() => {});
    }
  }, [credentials]);

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const a of agents) {
        next[a.id] = {
          credentialId: a.credentialId ?? '',
          model: a.model ?? '',
          effort: a.effort ?? '',
          maxSteps: a.maxSteps,
          enabled: a.enabled,
        };
      }
      return next;
    });
  }, [agents]);

  async function addCredential(e: FormEvent) {
    e.preventDefault();
    setCredErr(null);
    setCredMsg(null);
    try {
      await api.createCredential({
        provider,
        label: label.trim(),
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || null,
      });
      setLabel('');
      setBaseUrl('');
      setApiKey('');
      setCredMsg('Credential saved (encrypted with AES-256-GCM).');
      await onChanged();
    } catch (err) {
      setCredErr(err instanceof ApiError ? err.message : 'Failed to save credential');
    }
  }

  async function runTest(c: CredentialView) {
    const model = testModel[c.id] || defaults[c.provider] || 'nexus-mock';
    setTestOut((p) => ({ ...p, [c.id]: { ok: true, text: 'Testing…' } }));
    try {
      const r = await api.testCredential(c.id, model);
      setTestOut((p) => ({
        ...p,
        [c.id]: r.ok
          ? { ok: true, text: `OK (${r.model}): "${r.reply || 'ready'}" (${r.inputTokens}/${r.outputTokens} tok)` }
          : { ok: false, text: r.error || 'Test failed' },
      }));
    } catch (err) {
      setTestOut((p) => ({ ...p, [c.id]: { ok: false, text: err instanceof ApiError ? err.message : 'Test failed' } }));
    }
  }

  async function saveAgent(id: AgentId) {
    setSaving(id);
    try {
      const d = drafts[id];
      await api.patchAgent(id, {
        credentialId: d.credentialId || null,
        model: d.model.trim() || null,
        effort: d.effort || null,
        maxSteps: Number(d.maxSteps) || 30,
        enabled: d.enabled,
      });
      await onChanged();
    } finally {
      setSaving(null);
    }
  }

  async function applyToAll(credentialId: string, model: string) {
    setSaving('all');
    try {
      for (const id of AGENT_IDS) {
        await api.patchAgent(id, { credentialId, model, enabled: true });
      }
      await onChanged();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div>
        <h3 style={{ marginTop: 0 }}>Provider credentials</h3>
        {credentials.length > 0 && (
          <div className="cred-list">
            {credentials.map((c) => (
              <div key={c.id} className="cred-row">
                <div>
                  <b>{c.label}</b>{' '}
                  <span className="note">
                    {PROVIDER_LABELS[c.provider]}
                    {c.baseUrl ? ` · ${c.baseUrl}` : ''}
                    {c.secretHint ? ` · ${c.secretHint}` : ''}
                  </span>
                  {testOut[c.id] && (
                    <div className={testOut[c.id].ok ? 'ok-text' : 'err-text'} style={{ fontSize: 12, marginTop: 4 }}>
                      {testOut[c.id].text}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    className="input"
                    list={`models-${c.id}`}
                    style={{ width: 170, padding: '5px 8px', fontSize: 12 }}
                    placeholder={credModels[c.id]?.[0] || defaults[c.provider] || 'model'}
                    value={testModel[c.id] ?? credModels[c.id]?.[0] ?? defaults[c.provider] ?? ''}
                    onChange={(e) => setTestModel((p) => ({ ...p, [c.id]: e.target.value }))}
                  />
                  <datalist id={`models-${c.id}`}>
                    {(credModels[c.id] || []).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <button type="button" className="btn sm" onClick={() => runTest(c)}>
                    Test
                  </button>
                  <button
                    type="button"
                    className="btn sm ok"
                    disabled={saving === 'all'}
                    onClick={() => applyToAll(c.id, testModel[c.id] || defaults[c.provider] || 'nexus-mock')}
                  >
                    Assign to all 5
                  </button>
                  <button
                    type="button"
                    className="btn sm danger"
                    onClick={async () => {
                      await api.deleteCredential(c.id);
                      await onChanged();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <form className="form-grid" onSubmit={addCredential}>
          <div className="field">
            <label htmlFor="cred-provider">Provider</label>
            <select
              id="cred-provider"
              className="select"
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderKind)}
            >
              {(['anthropic', 'openai', 'gemini', 'ollama'] as ProviderKind[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cred-label">Label</label>
            <input
              id="cred-label"
              className="input"
              placeholder="e.g. Anthropic prod"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="cred-url">Base URL (optional)</label>
            <input
              id="cred-url"
              className="input"
              placeholder="http://127.0.0.1:4010/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cred-key">API Key {provider === 'ollama' ? '(optional)' : ''}</label>
            <input
              id="cred-key"
              className="input"
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required={provider !== 'ollama'}
            />
          </div>
          <button type="submit" className="btn primary">
            Add credential
          </button>
        </form>
        {credMsg && <p className="ok-text" style={{ fontSize: 12.5, margin: '8px 0 0' }}>{credMsg}</p>}
        {credErr && <p className="err-text" style={{ fontSize: 12.5, margin: '8px 0 0' }}>{credErr}</p>}
      </div>

      <div>
        <h3>Agents</h3>
        <div className="wf">
          {agents.map((a) => {
            const p = AGENT_PROFILES[a.id];
            const d = drafts[a.id];
            return (
              <div key={a.id} className="wf-card">
                <h4>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: p.color, boxShadow: `0 0 10px ${p.color}` }} />
                  {a.name}
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--f-mono)' }} className={a.configured ? 'ok-text' : 'setup'}>
                    {a.configured ? 'Ready' : 'Setup needed'}
                  </span>
                </h4>
                <p>{a.role}</p>

                <div className="field">
                  <label>Credential</label>
                  <select
                    className="select"
                    value={d.credentialId}
                    onChange={(e) => {
                      const cid = e.target.value;
                      const cred = credentials.find((x) => x.id === cid);
                      setDrafts((prev) => ({
                        ...prev,
                        [a.id]: {
                          ...prev[a.id],
                          credentialId: cid,
                          model: prev[a.id].model || (cred ? defaults[cred.provider] : ''),
                        },
                      }));
                    }}
                  >
                    <option value="">— Unassigned —</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} ({c.provider})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>Model</label>
                  <input
                    className="input"
                    list={d.credentialId ? `models-${d.credentialId}` : undefined}
                    value={d.model}
                    placeholder={credModels[d.credentialId]?.[0] || 'model name'}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [a.id]: { ...prev[a.id], model: e.target.value } }))}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px', gap: 8 }}>
                  <div className="field">
                    <label>Effort</label>
                    <select
                      className="select"
                      value={d.effort}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [a.id]: { ...prev[a.id], effort: e.target.value } }))}
                    >
                      <option value="">Default</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Max steps</label>
                    <input
                      className="input"
                      type="number"
                      min={3}
                      max={200}
                      value={d.maxSteps}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [a.id]: { ...prev[a.id], maxSteps: Number(e.target.value) } }))
                      }
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [a.id]: { ...prev[a.id], enabled: e.target.checked } }))}
                    />
                    Enabled
                  </label>
                  <button type="button" className="btn sm primary" disabled={saving === a.id} onClick={() => saveAgent(a.id)}>
                    {saving === a.id ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * PROJECTS SHEET
 * ========================================================================== */

export function ProjectsSheet({ initialProjectId }: { initialProjectId?: string | null }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialProjectId ?? null);
  const [subTab, setSubTab] = useState<'files' | 'history' | 'preview'>('files');
  const [files, setFiles] = useState<ProjectFileItem[]>([]);
  const [history, setHistory] = useState<ArtifactHistoryItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ path: string; version?: number } | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then((list) => {
      setProjects(list);
      if (!activeId && list.length > 0) setActiveId(list[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeId) return;
    api.projectFiles(activeId).then(setFiles).catch(() => setFiles([]));
    api.projectHistory(activeId).then(setHistory).catch(() => setHistory([]));
    setSelectedFile(null);
    setFileContent(null);
  }, [activeId]);

  async function viewFile(filePath: string, version?: number) {
    if (!activeId) return;
    setSelectedFile({ path: filePath, version });
    if (/\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)) {
      setFileContent(null);
      return;
    }
    try {
      const txt = await api.projectFileText(activeId, filePath, version);
      setFileContent(txt);
    } catch {
      setFileContent('(Unable to load file)');
    }
  }

  const hasSite = files.some((f) => f.path === 'site/index.html');

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="proj">
        {projects.length === 0 && <p className="note">No projects yet. Launch a mission to create one.</p>}
        {projects.map((p) => (
          <div
            key={p.id}
            className="proj-row"
            style={p.id === activeId ? { borderColor: 'var(--cyan)' } : undefined}
            onClick={() => setActiveId(p.id)}
          >
            <div>
              <b>{p.name}</b>
              <small>{p.description}</small>
            </div>
            <small style={{ fontFamily: 'var(--f-mono)', textAlign: 'right' }}>
              {p.files} files · {p.missions} missions · {p.last_status || 'new'}
            </small>
          </div>
        ))}
      </div>

      {activeId && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="tabs" style={{ maxWidth: 380 }}>
            <button type="button" aria-selected={subTab === 'files'} onClick={() => setSubTab('files')}>
              Files ({files.filter((f) => !f.dir).length})
            </button>
            <button type="button" aria-selected={subTab === 'history'} onClick={() => setSubTab('history')}>
              History ({history.length})
            </button>
            <button type="button" aria-selected={subTab === 'preview'} onClick={() => setSubTab('preview')}>
              Site preview
            </button>
          </div>

          {subTab === 'files' && (
            <div className="split">
              <ul className="file-list">
                {files
                  .filter((f) => !f.dir)
                  .map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        className={selectedFile?.path === f.path ? 'active' : ''}
                        onClick={() => viewFile(f.path)}
                      >
                        <span>{f.path}</span>
                        <span style={{ color: 'var(--muted)' }}>{f.version ? `v${f.version}` : ''}</span>
                      </button>
                    </li>
                  ))}
              </ul>
              <div>
                {selectedFile ? (
                  /\.(png|jpg|jpeg|webp|gif)$/i.test(selectedFile.path) ? (
                    <img
                      src={`/api/projects/${activeId}/file?path=${encodeURIComponent(selectedFile.path)}${selectedFile.version ? `&version=${selectedFile.version}` : ''}`}
                      alt={selectedFile.path}
                      style={{ maxWidth: '100%', borderRadius: 12, border: '1px solid var(--line)' }}
                    />
                  ) : (
                    <pre className="code-box">{fileContent ?? 'Loading…'}</pre>
                  )
                ) : (
                  <p className="note">Select a file to inspect its contents.</p>
                )}
              </div>
            </div>
          )}

          {subTab === 'history' && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Version</th>
                    <th>Agent</th>
                    <th>Size</th>
                    <th>Saved</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={`${h.path}-${h.version}`}>
                      <td style={{ fontFamily: 'var(--f-mono)' }}>{h.path}</td>
                      <td>v{h.version}</td>
                      <td>{h.agent_id?.toUpperCase() ?? '—'}</td>
                      <td>{h.size} B</td>
                      <td>{new Date(h.created_at).toLocaleString()}</td>
                      <td>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            setSubTab('files');
                            void viewFile(h.path, h.version);
                          }}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {subTab === 'preview' && (
            <div>
              {hasSite ? (
                <iframe
                  className="preview-frame"
                  src={`/preview/${activeId}/site/`}
                  title="Sandboxed site preview"
                />
              ) : (
                <p className="note">No `site/index.html` exists in this project yet.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * INSIGHTS SHEET
 * ========================================================================== */

export function InsightsSheet() {
  const [data, setData] = useState<InsightsData | null>(null);

  useEffect(() => {
    api.insights(30).then(setData).catch(() => {});
  }, []);

  if (!data) return <p className="note">Loading insights…</p>;

  const totalTasks = data.tasks.length;
  const completedTasks = data.tasks.filter((t) => t.status === 'completed').length;
  const rate = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const durations = data.tasks
    .map((t) => t.secs)
    .filter((s): s is number => typeof s === 'number' && s >= 0)
    .sort((a, b) => a - b);
  const medianSec = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const totalTokens = data.usage.reduce((acc, u) => acc + u.input_tokens + u.output_tokens, 0);
  const hasAnyUnpriced = data.usage.some((u) => !u.priced);
  const allUnpriced = data.usage.length > 0 && data.usage.every((u) => !u.priced);
  const totalCost = data.usage.filter((u) => u.priced).reduce((acc, u) => acc + Number(u.cost || 0), 0);

  const maxBusy = Math.max(1, ...data.busy.map((b) => b.secs || 0));

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="tiles">
        <div className="tile">
          <div className="eyebrow">Tasks completed ({data.days}d)</div>
          <div className="v">{completedTasks}</div>
          <div className="s">{rate}% completion rate ({totalTasks} total)</div>
        </div>
        <div className="tile">
          <div className="eyebrow">Median task duration</div>
          <div className="v">{medianSec !== null ? `${Math.round(medianSec)}s` : '—'}</div>
          <div className="s">{durations.length} timed tasks</div>
        </div>
        <div className="tile">
          <div className="eyebrow">Total tokens</div>
          <div className="v">{totalTokens.toLocaleString()}</div>
          <div className="s">{data.usage.reduce((a, u) => a + u.calls, 0)} model calls</div>
        </div>
        <div className="tile">
          <div className="eyebrow">Estimated API cost</div>
          <div className="v">{allUnpriced ? 'unpriced' : `$${totalCost.toFixed(4)}`}</div>
          <div className="s">{hasAnyUnpriced ? 'Includes unpriced models' : 'All models priced'}</div>
        </div>
      </div>

      <div>
        <h3 style={{ marginTop: 0 }}>Usage &amp; cost by agent / model</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th>Calls</th>
                <th>Input tok</th>
                <th>Output tok</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ color: 'var(--muted)' }}>
                    No usage recorded yet.
                  </td>
                </tr>
              ) : (
                data.usage.map((u) => (
                  <tr key={`${u.agent_id}-${u.model}`}>
                    <td>{u.agent_id.toUpperCase()}</td>
                    <td style={{ fontFamily: 'var(--f-mono)' }}>{u.model}</td>
                    <td>{u.calls}</td>
                    <td>{u.input_tokens.toLocaleString()}</td>
                    <td>{u.output_tokens.toLocaleString()}</td>
                    <td style={{ fontFamily: 'var(--f-mono)' }}>
                      {u.priced ? `$${Number(u.cost).toFixed(4)}` : <span className="setup">unpriced</span>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3>Active time by agent</h3>
        <div className="bars">
          {AGENT_IDS.map((id) => {
            const b = data.busy.find((x) => x.agent_id === id);
            const secs = Math.round(b?.secs ?? 0);
            const pct = Math.round(((b?.secs ?? 0) / maxBusy) * 100);
            return (
              <div key={id} className="bar">
                <span>{AGENT_PROFILES[id].name}</span>
                <span className="track">
                  <span className="fill" style={{ display: 'block', width: `${pct}%`, background: AGENT_PROFILES[id].color }} />
                </span>
                <span className="n">{secs}s</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * SETTINGS SHEET
 * ========================================================================== */

export function SettingsSheet({ userRole }: { userRole: Role }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('operator');
  const [err, setErr] = useState<string | null>(null);

  const isAdmin = userRole === 'owner' || userRole === 'admin';

  async function refresh() {
    api.health().then(setHealth).catch(() => {});
    api.outbox().then(setOutbox).catch(() => {});
    if (isAdmin) {
      api.members().then(setMembers).catch(() => {});
      api.audit().then(setAudit).catch(() => {});
    }
  }

  useEffect(() => {
    void refresh();
  }, [isAdmin]);

  async function addMember(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api.addMember({ email, name, password, role });
      setEmail('');
      setName('');
      setPassword('');
      await refresh();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Failed to add member');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div>
        <h3 style={{ marginTop: 0 }}>Sandbox &amp; infrastructure health</h3>
        {health ? (
          <div className="tiles">
            <div className="tile">
              <div className="eyebrow">Database</div>
              <div className={`v ${health.db ? 'ok-text' : 'err-text'}`}>{health.db ? 'OK' : 'DOWN'}</div>
            </div>
            <div className="tile">
              <div className="eyebrow">Redis</div>
              <div className={`v ${health.redis ? 'ok-text' : 'err-text'}`}>{health.redis ? 'OK' : 'DOWN'}</div>
            </div>
            <div className="tile">
              <div className="eyebrow">Docker</div>
              <div className={`v ${health.sandbox.docker ? 'ok-text' : 'err-text'}`}>{health.sandbox.docker ? 'OK' : 'DOWN'}</div>
              <div className="s">
                Exec: {health.sandbox.execImage ? 'yes' : 'no'} · Browser: {health.sandbox.browserImage ? 'yes' : 'no'}
              </div>
            </div>
            <div className="tile">
              <div className="eyebrow">Egress gateway</div>
              <div className={`v ${health.sandbox.egress ? 'ok-text' : 'err-text'}`}>{health.sandbox.egress ? 'OK' : 'OFF'}</div>
              <div className="s">Worker: {health.worker ? 'embedded' : 'external'}</div>
            </div>
          </div>
        ) : (
          <p className="note">Checking health…</p>
        )}
        {health?.sandbox.detail && <p className="setup" style={{ margin: 0 }}>{health.sandbox.detail}</p>}
      </div>

      <div>
        <h3>Outbox (approved external actions)</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Status</th>
                <th>Detail</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {outbox.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ color: 'var(--muted)' }}>
                    No outbox entries yet.
                  </td>
                </tr>
              ) : (
                outbox.map((o) => (
                  <tr key={o.id}>
                    <td>{o.channel}</td>
                    <td className="setup">{o.status}</td>
                    <td>{o.detail || JSON.stringify(o.payload).slice(0, 120)}</td>
                    <td>{new Date(o.created_at).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isAdmin && (
        <>
          <div>
            <h3>Workspace members</h3>
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td style={{ fontFamily: 'var(--f-mono)' }}>{m.email}</td>
                      <td>{m.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <form className="form-grid" onSubmit={addMember}>
              <div className="field">
                <label>Name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="field">
                <label>Email</label>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="field">
                <label>Password</label>
                <input className="input" type="password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div className="field">
                <label>Role</label>
                <select className="select" value={role} onChange={(e) => setRole(e.target.value as any)}>
                  <option value="operator">operator</option>
                  <option value="admin">admin</option>
                  <option value="viewer">viewer</option>
                </select>
              </div>
              <button type="submit" className="btn primary">
                Add member
              </button>
            </form>
            {err && <p className="err-text">{err}</p>}
          </div>

          <div>
            <h3>Audit log</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.slice(0, 50).map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontFamily: 'var(--f-mono)', whiteSpace: 'nowrap' }}>
                        {new Date(a.created_at).toLocaleTimeString()}
                      </td>
                      <td>
                        {a.actor_type}:{a.actor_id ?? '—'}
                      </td>
                      <td style={{ fontFamily: 'var(--f-mono)' }}>{a.action}</td>
                      <td style={{ fontFamily: 'var(--f-mono)' }}>{a.target ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
