'use client';

import { AGENT_PROFILES, type AgentConfigView, type AgentId, type AgentVisualState, type TaskView } from '@nexus/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type ProjectFileItem } from '@/lib/api';
import { STATE_META } from '@/lib/office-engine';

interface Props {
  agentId: AgentId;
  agentConfig?: AgentConfigView;
  visualState: AgentVisualState;
  stateLabel: string | null;
  terminalLines: string[];
  currentTask: TaskView | null;
  failedTask: TaskView | null;
  projectId: string | null;
  files: ProjectFileItem[];
  onMirrorCanvas: (el: HTMLCanvasElement | null) => void;
  onFocusCamera: () => void;
  onRetryTask: (taskId: string) => Promise<void>;
  onOpenWorkforce: () => void;
}

export function Inspector({
  agentId,
  agentConfig,
  visualState,
  stateLabel,
  terminalLines,
  currentTask,
  failedTask,
  projectId,
  files,
  onMirrorCanvas,
  onFocusCamera,
  onRetryTask,
  onOpenWorkforce,
}: Props) {
  const [tab, setTab] = useState<'screen' | 'terminal' | 'files'>('screen');
  const [retrying, setRetrying] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const mirrorRef = useRef<HTMLCanvasElement | null>(null);
  const termRef = useRef<HTMLPreElement | null>(null);

  const profile = AGENT_PROFILES[agentId];
  const st = STATE_META[visualState];
  const isOffline = !agentConfig?.configured;

  useEffect(() => {
    onMirrorCanvas(tab === 'screen' ? mirrorRef.current : null);
    return () => onMirrorCanvas(null);
  }, [tab, onMirrorCanvas]);

  useEffect(() => {
    if (tab === 'terminal' && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [terminalLines, tab]);

  async function openFile(filePath: string) {
    if (!projectId) return;
    setPreviewPath(filePath);
    if (/\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)) {
      setPreviewText(null);
      return;
    }
    try {
      const txt = await api.projectFileText(projectId, filePath);
      setPreviewText(txt);
    } catch {
      setPreviewText('(Could not load file)');
    }
  }

  const visibleFiles = files.filter((f) => !f.dir);

  return (
    <aside className="insp glass" aria-label="Agent computer">
      <div className="insp-head">
        <span className="agent-dot" style={{ background: profile.color, boxShadow: `0 0 22px -4px ${profile.color}` }}>
          {profile.glyph}
        </span>
        <div>
          <h2>{profile.name}</h2>
          <p>{profile.role}</p>
        </div>
        <span className="state-pill" style={{ color: isOffline ? '#ffbe5c' : st.color }}>
          {isOffline ? 'Setup needed' : stateLabel || st.label}
        </span>
      </div>

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'screen'} onClick={() => setTab('screen')}>
          Screen
        </button>
        <button type="button" role="tab" aria-selected={tab === 'terminal'} onClick={() => setTab('terminal')}>
          Terminal
        </button>
        <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
          Files ({visibleFiles.length})
        </button>
      </div>

      {tab === 'screen' && (
        <div className="mirror-wrap">
          <canvas ref={mirrorRef} className="mirror-canvas" width={640} height={400} />
          <span className="mirror-cap">
            {visualState === 'browsing' ? `LIVE · chromium · ${agentId}-01` : `LIVE · ${agentId}-01`}
          </span>
        </div>
      )}

      {tab === 'terminal' && (
        <pre ref={termRef} className="term-pre">
          {terminalLines.length === 0 ? (
            <span className="dim">No output yet for {profile.name}.</span>
          ) : (
            terminalLines.map((l, idx) => {
              const cls = l.startsWith('$')
                ? 'cmd'
                : l.includes('✓') || l.includes('pass ')
                  ? 'ok'
                  : l.includes('✗') || l.includes('fail ') || l.startsWith('ERROR')
                    ? 'err'
                    : l.startsWith('  ')
                      ? 'dim'
                      : '';
              return (
                <span key={idx} className={cls}>
                  {l}
                  {'\n'}
                </span>
              );
            })
          )}
        </pre>
      )}

      {tab === 'files' && (
        <div style={{ display: 'grid', gap: 8 }}>
          {visibleFiles.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>
              No project files written yet.
            </p>
          ) : (
            <ul className="insp-files">
              {visibleFiles.map((f) => (
                <li key={f.path}>
                  <button type="button" onClick={() => openFile(f.path)}>
                    <span>{f.path}</span>
                    <span>{f.size >= 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {previewPath && projectId && (
            <div style={{ display: 'grid', gap: 6 }}>
              <div className="eyebrow" style={{ justifyContent: 'space-between' }}>
                <span>{previewPath}</span>
                <button type="button" className="btn sm" onClick={() => setPreviewPath(null)}>
                  Close
                </button>
              </div>
              {/\.(png|jpg|jpeg|webp|gif)$/i.test(previewPath) ? (
                <img
                  src={`/api/projects/${projectId}/file?path=${encodeURIComponent(previewPath)}`}
                  alt={previewPath}
                  style={{ width: '100%', borderRadius: 10, border: '1px solid var(--line)' }}
                />
              ) : (
                <pre className="term-pre" style={{ height: 140 }}>
                  {previewText ?? 'Loading…'}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {failedTask && (
        <div className="err-box">
          <b>
            {failedTask.key} failed: {failedTask.error || 'Execution error'}
          </b>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn sm ok"
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await onRetryTask(failedTask.id);
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? 'Retrying…' : 'Retry task'}
            </button>
            <button className="btn sm" type="button" onClick={() => setTab('terminal')}>
              Open terminal
            </button>
          </div>
        </div>
      )}

      <dl className="facts">
        <div>
          <dt>Current task</dt>
          <dd>{currentTask ? `${currentTask.key} · ${currentTask.title}` : '—'}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            {isOffline ? (
              <span className="setup">Setup needed</span>
            ) : (
              `${agentConfig?.provider} · ${agentConfig?.model}`
            )}
          </dd>
        </div>
        <div>
          <dt>Sandbox</dt>
          <dd>
            {agentId === 'forge'
              ? 'docker · node 22 · network none'
              : agentId === 'scout'
                ? 'docker · chromium · egress proxy'
                : `${agentId}-01 · workspace tools`}
          </dd>
        </div>
      </dl>

      <div className="insp-actions">
        <button className="btn" type="button" onClick={onFocusCamera}>
          Focus camera
        </button>
        {isOffline && (
          <button className="btn primary" type="button" onClick={onOpenWorkforce}>
            Configure model
          </button>
        )}
      </div>
    </aside>
  );
}
