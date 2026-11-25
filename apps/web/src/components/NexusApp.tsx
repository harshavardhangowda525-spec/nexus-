'use client';

import {
  AGENT_IDS,
  AGENT_PROFILES,
  type AgentConfigView,
  type AgentId,
  type AgentVisualState,
  type ApprovalView,
  type CredentialView,
  type NexusEvent,
  type ProviderKind,
  type TaskView,
} from '@nexus/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { Inspector } from '@/components/Inspector';
import { InsightsSheet, ProjectsSheet, SettingsSheet, WorkforceSheet } from '@/components/Sheets';
import { TaskGraphSvg } from '@/components/TaskGraphSvg';
import {
  api,
  ApiError,
  getWsUrl,
  type AuthState,
  type MissionDetail,
  type ProjectFileItem,
} from '@/lib/api';
import { OfficeEngine } from '@/lib/office-engine';

type SheetKind = null | 'workforce' | 'projects' | 'insights' | 'settings';

interface FeedItem {
  id: string;
  time: string;
  who: string;
  color: string;
  text: string;
  kind?: 'ok' | 'err' | 'warn' | 'msg';
}

function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function eventToFeed(ev: NexusEvent): FeedItem | null {
  const agent = ev.agentId;
  const who = agent ? AGENT_PROFILES[agent].name : 'NEXUS';
  const color = agent ? AGENT_PROFILES[agent].color : '#e8edff';
  const time = fmtTime(ev.createdAt);
  const p = ev.payload || {};

  switch (ev.type) {
    case 'mission.created':
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who: 'CEO', color: '#e8edff', text: `Mission: ${String(p.brief || '').slice(0, 110)}` };
    case 'mission.planned':
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who: 'ATLAS', color: AGENT_PROFILES.atlas.color, text: `Plan ready · ${(p.tasks || []).length} tasks` };
    case 'message.sent': {
      const to = p.to && AGENT_PROFILES[p.to as AgentId] ? AGENT_PROFILES[p.to as AgentId].name : String(p.to || '');
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who, color, text: `${to}: ${String(p.body || '')}`, kind: 'msg' };
    }
    case 'browser.navigated':
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who, color, text: `Browsed ${String(p.url || '')}` };
    case 'file.written':
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who, color, text: `Wrote ${String(p.path || '')} (v${p.version ?? 1})` };
    case 'approval.requested':
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who, color, text: `Approval needed: ${String(p.summary || p.action || '')}`, kind: 'warn' };
    case 'approval.decided':
      return {
        id: `e-${ev.id}-${ev.createdAt}`,
        time,
        who: 'CEO',
        color: '#e8edff',
        text: `${p.decision === 'approve' ? 'Approved' : 'Rejected'} ${String(p.action || 'request')}`,
        kind: p.decision === 'approve' ? 'ok' : 'warn',
      };
    case 'task.status':
      if (p.status === 'completed') {
        return { id: `e-${ev.id}-${ev.createdAt}`, time, who, color, text: `Completed ${String(p.key || '')}`, kind: 'ok' };
      }
      if (p.status === 'failed') {
        return { id: `e-${ev.id}-${ev.createdAt}`, time, who, color, text: `Failed ${String(p.key || '')}: ${String(p.error || '')}`, kind: 'err' };
      }
      return null;
    case 'mission.report':
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who: 'ATLAS', color: AGENT_PROFILES.atlas.color, text: 'Mission complete · report.md ready', kind: 'ok' };
    case 'error':
      return { id: `e-${ev.id}-${ev.createdAt}`, time, who, color, text: String(p.message || 'Error'), kind: 'err' };
    default:
      return null;
  }
}

export function NexusApp() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authLoadErr, setAuthLoadErr] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentConfigView[]>([]);
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [defaults, setDefaults] = useState<Record<ProviderKind, string>>({
    anthropic: 'claude-opus-5-5',
    openai: 'gpt-5',
    gemini: 'gemini-2.5-pro',
    ollama: 'llama3.1',
  });
  const [mission, setMission] = useState<MissionDetail | null>(null);
  const [files, setFiles] = useState<ProjectFileItem[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalView[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  const [selectedAgent, setSelectedAgent] = useState<AgentId>('atlas');
  const [agentVisual, setAgentVisual] = useState<Record<AgentId, { state: AgentVisualState; label: string | null }>>(() => {
    const m = {} as Record<AgentId, { state: AgentVisualState; label: string | null }>;
    for (const id of AGENT_IDS) m[id] = { state: 'idle', label: null };
    return m;
  });
  const [terminals, setTerminals] = useState<Record<AgentId, string[]>>(() => {
    const m = {} as Record<AgentId, string[]>;
    for (const id of AGENT_IDS) m[id] = [];
    return m;
  });

  const [brief, setBrief] = useState('Build a premium website for my physiotherapy client and prepare a marketing strategy.');
  const [budgetUsd, setBudgetUsd] = useState('5');
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const [sheet, setSheet] = useState<SheetKind>(null);
  const [showReport, setShowReport] = useState(false);
  const [followActivity, setFollowActivity] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [perfText, setPerfText] = useState('— fps');
  const [webglFailed, setWebglFailed] = useState(false);
  const [clockText, setClockText] = useState('00:00');
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const stageRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirrorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<OfficeEngine | null>(null);
  const followRef = useRef(followActivity);
  const lastFollowRef = useRef(0);
  const missionIdRef = useRef<string | null>(null);
  const agentsRef = useRef<AgentConfigView[]>(agents);

  followRef.current = followActivity;
  missionIdRef.current = mission?.id ?? null;
  agentsRef.current = agents;

  const appendTerm = useCallback((id: AgentId, text: string) => {
    engineRef.current?.appendLine(id, text);
    const parts = text.replace(/\r/g, '').split('\n').filter((l, i, arr) => l !== '' || i < arr.length - 1);
    if (!parts.length) return;
    setTerminals((prev) => ({
      ...prev,
      [id]: [...prev[id], ...parts].slice(-120),
    }));
  }, []);

  const loadAuth = useCallback(async () => {
    setAuthLoadErr(null);
    try {
      const s = await api.authState();
      setAuth(s);
    } catch (err) {
      setAuthLoadErr(
        err instanceof ApiError
          ? `Cannot reach NEXUS backend API (${err.message}). Make sure the server is running on port 4000 and check its terminal log.`
          : 'Cannot reach NEXUS backend API on port 4000. Check the [server] terminal log.',
      );
      setAuth(null);
    }
  }, []);

  useEffect(() => {
    void loadAuth();
  }, [loadAuth]);

  const syncAgentConfigStates = useCallback((list: AgentConfigView[], liveStates?: Record<string, any>) => {
    setAgentVisual((prev) => {
      const next = { ...prev };
      for (const a of list) {
        if (!a.configured) {
          next[a.id] = { state: 'offline', label: 'Setup needed' };
          engineRef.current?.setAgentState(a.id, 'offline', { label: 'Setup needed' });
        } else {
          const live = liveStates?.[a.id];
          const st = (live?.state as AgentVisualState) || (prev[a.id].state === 'offline' ? 'idle' : prev[a.id].state);
          const lbl = live?.label ?? (prev[a.id].state === 'offline' ? null : prev[a.id].label);
          next[a.id] = { state: st, label: lbl };
          engineRef.current?.setAgentState(a.id, st, { label: lbl, detail: live?.detail ?? null });
        }
      }
      return next;
    });
  }, []);

  const refreshConfig = useCallback(async () => {
    const [ag, cr, df] = await Promise.all([api.agents(), api.credentials(), api.modelDefaults()]);
    setAgents(ag);
    setCredentials(cr);
    setDefaults(df);
    syncAgentConfigStates(ag);
  }, [syncAgentConfigStates]);

  const loadMission = useCallback(async (id: string) => {
    const [m, evts] = await Promise.all([api.mission(id), api.missionEvents(id)]);
    setMission(m);
    engineRef.current?.setTasks(m.tasks);
    if (m.status === 'completed' && m.report) setShowReport(true);
    const pending = m.approvals.filter((a) => a.status === 'pending');
    setPendingApprovals(pending);
    for (const ap of pending) engineRef.current?.setApprovalSummary(ap.agentId, ap.summary);

    const projectFiles = await api.projectFiles(m.projectId).catch(() => []);
    setFiles(projectFiles);

    // Populate feed & terminal buffers from persisted events
    const feedItems: FeedItem[] = [];
    const termMap: Record<AgentId, string[]> = { atlas: [], forge: [], scout: [], pulse: [], ledger: [] };
    for (const ev of evts) {
      const fi = eventToFeed(ev);
      if (fi) feedItems.push(fi);
      if (ev.agentId) {
        if (ev.type === 'exec.output' && ev.payload?.text) {
          termMap[ev.agentId].push(...String(ev.payload.text).replace(/\r/g, '').split('\n').filter(Boolean));
        } else if (ev.type === 'tool.call' && ev.payload?.tool) {
          termMap[ev.agentId].push(`› ${ev.payload.tool} ${JSON.stringify(ev.payload.input || {}).slice(0, 80)}`);
        }
      }
    }
    setFeed(feedItems.reverse().slice(0, 80));
    setTerminals(termMap);
    for (const aid of AGENT_IDS) engineRef.current?.setLines(aid, termMap[aid]);
  }, []);

  // Mount 3D OfficeEngine once authenticated
  useEffect(() => {
    if (!auth?.user || !canvasRef.current || !stageRef.current) return;
    const eng = new OfficeEngine({
      canvas: canvasRef.current,
      container: stageRef.current,
      onSelectAgent: (id) => {
        setFollowActivity(false);
        setSelectedAgent(id);
      },
      onPerf: setPerfText,
      onWebGLFailed: () => setWebglFailed(true),
    });
    engineRef.current = eng;
    if (mirrorCanvasRef.current) eng.setMirrorCanvas(mirrorCanvasRef.current);
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => eng.refreshFonts());
    }
    return () => {
      eng.dispose();
      engineRef.current = null;
    };
  }, [auth?.user]);

  useEffect(() => {
    engineRef.current?.setSelectedAgent(selectedAgent);
  }, [selectedAgent]);

  // Initial office hydration once signed in
  useEffect(() => {
    if (!auth?.user) return;
    let cancelled = false;
    (async () => {
      const [ag, cr, df, off, aps] = await Promise.all([
        api.agents(),
        api.credentials(),
        api.modelDefaults(),
        api.office(),
        api.approvals('pending'),
      ]);
      if (cancelled) return;
      setAgents(ag);
      setCredentials(cr);
      setDefaults(df);
      syncAgentConfigStates(ag, off.states);
      setPendingApprovals(aps);
      for (const [aid, frame] of Object.entries(off.frames || {})) {
        if (frame?.data) engineRef.current?.setBrowserFrame(aid as AgentId, frame.data, frame.url || '');
      }
      if (off.missionId) {
        await loadMission(off.missionId);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [auth?.user, syncAgentConfigStates, loadMission]);

  // Real-time WebSocket event stream
  useEffect(() => {
    if (!auth?.user) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(getWsUrl());
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (msg) => {
        let ev: NexusEvent;
        try {
          ev = JSON.parse(msg.data as string);
        } catch {
          return;
        }
        if ((ev as any).type === 'hello') return;

        // Browser live JPEG frame (ephemeral)
        if (ev.type === 'browser.frame' && ev.agentId && ev.payload?.data) {
          engineRef.current?.setBrowserFrame(ev.agentId, String(ev.payload.data), String(ev.payload.url || ''));
          return;
        }

        const fi = eventToFeed(ev);
        if (fi) setFeed((prev) => [fi, ...prev].slice(0, 80));

        if (ev.type === 'agent.state' && ev.agentId) {
          const st = (ev.payload?.state as AgentVisualState) || 'idle';
          const lbl = (ev.payload?.label as string | null) ?? null;
          const detail = (ev.payload?.detail as string | null) ?? null;
          const configured = agentsRef.current.find((a) => a.id === ev.agentId)?.configured ?? true;
          const effState: AgentVisualState = configured ? st : 'offline';
          setAgentVisual((prev) => ({ ...prev, [ev.agentId!]: { state: effState, label: configured ? lbl : 'Setup needed' } }));
          engineRef.current?.setAgentState(ev.agentId, effState, { label: configured ? lbl : 'Setup needed', detail });

          const now = performance.now();
          if (
            followRef.current &&
            effState !== 'idle' &&
            effState !== 'offline' &&
            (effState === 'error' || effState === 'waiting' || now - lastFollowRef.current > 2400)
          ) {
            lastFollowRef.current = now;
            setSelectedAgent(ev.agentId);
          }
        } else if (ev.type === 'exec.output' && ev.agentId && ev.payload?.text) {
          appendTerm(ev.agentId, String(ev.payload.text));
        } else if (ev.type === 'tool.call' && ev.agentId && ev.payload?.tool) {
          appendTerm(ev.agentId, `› ${ev.payload.tool} ${JSON.stringify(ev.payload.input || {}).slice(0, 90)}`);
        } else if (ev.type === 'browser.navigated' && ev.agentId && ev.payload?.url) {
          appendTerm(ev.agentId, `🌐 ${ev.payload.url}`);
        } else if (ev.type === 'message.sent' && ev.payload?.from && ev.payload?.to) {
          engineRef.current?.sendLink(ev.payload.from as AgentId, ev.payload.to as AgentId);
        } else if (ev.type === 'mission.planned' && ev.missionId) {
          const tasks = (ev.payload?.tasks || []) as TaskView[];
          engineRef.current?.setTasks(tasks);
          setMission((prev) => (prev && prev.id === ev.missionId ? { ...prev, status: 'running', tasks } : prev));
        } else if (ev.type === 'task.status' && ev.missionId) {
          const status = ev.payload?.status as TaskView['status'];
          const key = ev.payload?.key as string;
          const err = (ev.payload?.error as string | null) ?? null;
          const res = (ev.payload?.result as string | null) ?? null;
          if (status === 'completed' && ev.agentId) engineRef.current?.celebrate(ev.agentId);
          setMission((prev) => {
            if (!prev || prev.id !== ev.missionId) return prev;
            const tasks = prev.tasks.map((t) =>
              t.key === key || t.id === ev.taskId ? { ...t, status, error: err ?? t.error, result: res ?? t.result } : t,
            );
            engineRef.current?.setTasks(tasks);
            return { ...prev, tasks };
          });
        } else if (ev.type === 'approval.requested' && ev.payload?.approvalId) {
          const ap: ApprovalView = {
            id: String(ev.payload.approvalId),
            missionId: ev.missionId || '',
            taskId: ev.taskId || '',
            agentId: (ev.agentId || 'ledger') as AgentId,
            action: String(ev.payload.action || 'external_action'),
            summary: String(ev.payload.summary || 'External action requested'),
            payload: (ev.payload.details || {}) as Record<string, unknown>,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            createdAt: ev.createdAt,
          };
          engineRef.current?.setApprovalSummary(ap.agentId, ap.summary);
          setPendingApprovals((prev) => (prev.some((x) => x.id === ap.id) ? prev : [ap, ...prev]));
        } else if (ev.type === 'approval.decided' && ev.payload?.approvalId) {
          setPendingApprovals((prev) => prev.filter((x) => x.id !== ev.payload.approvalId));
        } else if (ev.type === 'file.written' && ev.missionId && missionIdRef.current === ev.missionId) {
          setMission((cur) => {
            if (cur?.projectId) void api.projectFiles(cur.projectId).then(setFiles).catch(() => {});
            return cur;
          });
        } else if ((ev.type === 'mission.status' || ev.type === 'mission.report') && ev.missionId) {
          if (missionIdRef.current === ev.missionId || ev.type === 'mission.report') {
            void api.mission(ev.missionId).then((m) => {
              setMission(m);
              engineRef.current?.setTasks(m.tasks);
              if (m.status === 'completed') setShowReport(true);
              void api.projectFiles(m.projectId).then(setFiles).catch(() => {});
            }).catch(() => {});
          }
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [auth?.user, appendTerm]);

  // Mission elapsed clock (real elapsed time from mission.createdAt)
  useEffect(() => {
    if (!mission) {
      setClockText('00:00');
      return;
    }
    const tick = () => {
      const start = new Date(mission.createdAt).getTime();
      const end = ['completed', 'failed', 'cancelled'].includes(mission.status)
        ? new Date(mission.updatedAt).getTime()
        : Date.now();
      setClockText(fmtElapsed((end - start) / 1000));
    };
    tick();
    if (!['planning', 'running', 'paused'].includes(mission.status)) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [mission]);

  const handleMirrorCanvas = useCallback((el: HTMLCanvasElement | null) => {
    mirrorCanvasRef.current = el;
    engineRef.current?.setMirrorCanvas(el);
  }, []);

  async function launchMission() {
    setLaunchErr(null);
    setLaunching(true);
    try {
      const b = Number(budgetUsd);
      const created = await api.createMission({ brief, budgetUsd: Number.isFinite(b) && b > 0 ? b : undefined });
      setShowReport(false);
      setFeed([]);
      setFiles([]);
      for (const id of AGENT_IDS) {
        engineRef.current?.setLines(id, []);
      }
      setTerminals({ atlas: [], forge: [], scout: [], pulse: [], ledger: [] });
      await loadMission(created.id);
    } catch (err) {
      setLaunchErr(err instanceof ApiError ? err.message : 'Could not launch mission');
    } finally {
      setLaunching(false);
    }
  }

  async function decide(ap: ApprovalView, decision: 'approve' | 'reject') {
    setDecidingId(ap.id);
    try {
      await api.decideApproval(ap.id, decision);
      setPendingApprovals((prev) => prev.filter((x) => x.id !== ap.id));
    } finally {
      setDecidingId(null);
    }
  }

  const activeApproval = pendingApprovals[0] ?? null;

  const selectedConfig = useMemo(() => agents.find((a) => a.id === selectedAgent), [agents, selectedAgent]);
  const selectedCurrentTask = useMemo(
    () => mission?.tasks.find((t) => t.agentId === selectedAgent && ['running', 'waiting_approval', 'queued'].includes(t.status)) ?? null,
    [mission, selectedAgent],
  );
  const selectedFailedTask = useMemo(
    () => mission?.tasks.find((t) => t.agentId === selectedAgent && t.status === 'failed') ?? null,
    [mission, selectedAgent],
  );

  const doneCount = mission?.tasks.filter((t) => t.status === 'completed').length ?? 0;
  const totalCount = mission?.tasks.length ?? 0;

  if (!auth) {
    return (
      <div className="auth-wrap">
        <div className="auth-card glass" style={{ textAlign: 'center' }}>
          <span className="word">NEXUS</span>
          {authLoadErr ? (
            <>
              <div className="err-box" style={{ textAlign: 'left' }}>{authLoadErr}</div>
              <button type="button" className="btn primary" onClick={() => void loadAuth()}>
                Retry connection
              </button>
            </>
          ) : (
            <p className="sub">Connecting to office…</p>
          )}
        </div>
      </div>
    );
  }

  if (auth.needsBootstrap || !auth.user) {
    return <AuthGate needsBootstrap={auth.needsBootstrap} onAuthenticated={loadAuth} />;
  }

  const missionDotClass =
    mission?.status === 'running' || mission?.status === 'planning'
      ? 'live-dot on'
      : mission?.status === 'paused' || activeApproval
        ? 'live-dot hold'
        : mission?.status === 'completed'
          ? 'live-dot done'
          : mission?.status === 'failed'
            ? 'live-dot err'
            : 'live-dot';

  const missionStatusText = activeApproval
    ? 'Waiting on approval'
    : mission
      ? mission.status[0].toUpperCase() + mission.status.slice(1)
      : 'Ready';

  const unconfiguredCount = agents.filter((a) => !a.configured).length;

  return (
    <div className="app">
      <header className="top glass">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <defs>
              <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#2fd8ff" />
                <stop offset="1" stopColor="#9b8cff" />
              </linearGradient>
            </defs>
            <path d="M16 2.5 28 9.3v13.4L16 29.5 4 22.7V9.3Z" fill="none" stroke="url(#lg)" strokeWidth="1.8" />
            <circle cx="16" cy="16" r="3.2" fill="url(#lg)" />
            <g stroke="url(#lg)" strokeWidth="1.3">
              <path d="M16 12.8V7.5M18.8 17.6l4.6 2.6M13.2 17.6l-4.6 2.6" />
            </g>
            <g fill="#e8edff">
              <circle cx="16" cy="7" r="1.5" />
              <circle cx="23.8" cy="20.4" r="1.5" />
              <circle cx="8.2" cy="20.4" r="1.5" />
            </g>
          </svg>
          <span className="word">NEXUS</span>
        </div>

        <div className="crumbs">
          <span>Workspace</span>
          <span className="sep">/</span>
          <b>{mission ? mission.brief.slice(0, 48) : 'Office Ready'}</b>
        </div>

        <div className="mstatus">
          <span className={missionDotClass} />
          <span className="mission-label">{missionStatusText}</span>
          <span className="clock">{clockText}</span>
        </div>

        <div className="top-actions">
          <span className={`ws-pill ${wsConnected ? 'live' : 'off'}`}>{wsConnected ? 'WS LIVE' : 'RECONNECTING'}</span>
          {unconfiguredCount > 0 && (
            <button type="button" className="btn sm" style={{ borderColor: 'rgba(255,190,92,.45)', color: 'var(--warn)' }} onClick={() => setSheet('workforce')}>
              {unconfiguredCount} setup needed
            </button>
          )}
          {mission && mission.status === 'running' && (
            <button type="button" className="btn sm" onClick={() => void api.controlMission(mission.id, 'pause').then(() => loadMission(mission.id))}>
              Pause
            </button>
          )}
          {mission && (mission.status === 'paused' || mission.status === 'failed') && (
            <button type="button" className="btn sm ok" onClick={() => void api.controlMission(mission.id, 'resume').then(() => loadMission(mission.id))}>
              Resume
            </button>
          )}
          {mission && ['planning', 'running', 'paused'].includes(mission.status) && (
            <button type="button" className="btn sm danger" onClick={() => void api.controlMission(mission.id, 'cancel').then(() => loadMission(mission.id))}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="avatar"
            title={`${auth.user.name} (${auth.user.role}) — click to sign out`}
            onClick={async () => {
              await api.logout();
              await loadAuth();
            }}
          >
            {auth.user.name.slice(0, 2).toUpperCase()}
          </button>
        </div>
      </header>

      <nav className="rail glass" aria-label="Sections">
        <button type="button" aria-current={sheet === null} onClick={() => { setSheet(null); engineRef.current?.resetOverview(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            <path d="M12 3 21 8l-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 17.5 9 5 9-5" opacity=".5" />
          </svg>
          Office
        </button>
        <button type="button" onClick={() => { setSheet(null); document.getElementById('prompt')?.focus(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="5" cy="6" r="2.2" /><circle cx="5" cy="18" r="2.2" /><circle cx="19" cy="12" r="2.2" />
            <path d="M7.2 6.5c5 .5 5 5 9.6 5.5M7.2 17.5c5-.5 5-5 9.6-5.5" />
          </svg>
          Mission
        </button>
        <button type="button" onClick={() => { setSheet(null); engineRef.current?.focusAgent(selectedAgent); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4M7 8l2.5 2L7 12M11.5 12H15" />
          </svg>
          Computer
        </button>
        <button type="button" aria-current={sheet === 'workforce'} onClick={() => setSheet('workforce')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="6" y="3.5" width="12" height="9" rx="4" /><circle cx="10" cy="8" r="1" fill="currentColor" />
            <circle cx="14" cy="8" r="1" fill="currentColor" /><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6" />
          </svg>
          Workforce
        </button>
        <button type="button" aria-current={sheet === 'projects'} onClick={() => setSheet('projects')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          Projects
        </button>
        <button type="button" aria-current={sheet === 'insights'} onClick={() => setSheet('insights')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
          Insights
        </button>
        <button type="button" aria-current={sheet === 'settings'} onClick={() => setSheet('settings')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
          Settings
        </button>
      </nav>

      <main className="stage glass" ref={stageRef}>
        <canvas ref={canvasRef} id="scene" className="scene-canvas" aria-label="3D office with five AI agents at their workstations" />

        <div className="hud hud-tl">
          <button className="chip-btn" type="button" onClick={() => engineRef.current?.resetOverview()}>
            Overview
          </button>
          <label className="toggle">
            <input type="checkbox" checked={followActivity} onChange={(e) => setFollowActivity(e.target.checked)} />
            <span>Follow activity</span>
          </label>
        </div>

        <div className="hud hud-bl">
          <span className="legend" aria-label="State colors">
            <span><i style={{ background: 'var(--violet)' }} />Thinking</span>
            <span><i style={{ background: 'var(--cyan)' }} />Working</span>
            <span><i style={{ background: 'var(--c-scout)' }} />Browsing</span>
            <span><i style={{ background: 'var(--warn)' }} />Approval</span>
            <span><i style={{ background: 'var(--ok)' }} />Done</span>
            <span><i style={{ background: 'var(--err)' }} />Error</span>
          </span>
          <span className="hint">Drag to orbit · scroll to zoom · click a robot</span>
        </div>

        <div className="hud hud-br">
          <span className="perf">{perfText}</span>
        </div>

        {activeApproval && (
          <div className="approval glass" role="dialog" aria-labelledby="apTitle">
            <div className="eyebrow">Approval needed · {activeApproval.agentId.toUpperCase()}</div>
            <h3 id="apTitle">{activeApproval.summary}</h3>
            <p>External action ({activeApproval.action}). Approved actions are recorded in the outbox.</p>
            <div className="mail">{JSON.stringify(activeApproval.payload, null, 2)}</div>
            <div className="row">
              <button
                className="btn ok"
                type="button"
                disabled={decidingId === activeApproval.id}
                onClick={() => void decide(activeApproval, 'approve')}
              >
                Approve
              </button>
              <button
                className="btn danger"
                type="button"
                disabled={decidingId === activeApproval.id}
                onClick={() => void decide(activeApproval, 'reject')}
              >
                Reject
              </button>
            </div>
          </div>
        )}

        {showReport && mission?.report && (
          <div className="report glass" role="region" aria-label="Mission report">
            <div className="eyebrow">Mission report · ATLAS</div>
            <h3>Mission complete</h3>
            <div className="report-body">{mission.report}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" type="button" onClick={() => setShowReport(false)}>
                Close
              </button>
              <button className="btn primary" type="button" onClick={() => setSheet('projects')}>
                Open deliverables &amp; preview
              </button>
            </div>
          </div>
        )}

        {sheet && (
          <div className="sheet glass" role="dialog" aria-label={sheet}>
            <header>
              <h2>{sheet[0].toUpperCase() + sheet.slice(1)}</h2>
              <button className="btn" type="button" onClick={() => setSheet(null)}>
                Back to office
              </button>
            </header>
            {sheet === 'workforce' && (
              <WorkforceSheet agents={agents} credentials={credentials} defaults={defaults} onChanged={refreshConfig} />
            )}
            {sheet === 'projects' && <ProjectsSheet initialProjectId={mission?.projectId} />}
            {sheet === 'insights' && <InsightsSheet />}
            {sheet === 'settings' && <SettingsSheet userRole={auth.user.role} />}
          </div>
        )}

        {webglFailed && (
          <div className="fallback">
            <div>
              <b style={{ color: 'var(--text)' }}>3D view unavailable</b>
              <br />
              This browser could not start WebGL. The mission, inspector and event stream still run.
            </div>
          </div>
        )}
      </main>

      <Inspector
        agentId={selectedAgent}
        agentConfig={selectedConfig}
        visualState={agentVisual[selectedAgent].state}
        stateLabel={agentVisual[selectedAgent].label}
        terminalLines={terminals[selectedAgent]}
        currentTask={selectedCurrentTask}
        failedTask={selectedFailedTask}
        projectId={mission?.projectId ?? null}
        files={files}
        onMirrorCanvas={handleMirrorCanvas}
        onFocusCamera={() => engineRef.current?.focusAgent(selectedAgent)}
        onRetryTask={async (taskId) => {
          await api.retryTask(taskId);
          if (mission) await loadMission(mission.id);
        }}
        onOpenWorkforce={() => setSheet('workforce')}
      />

      <section className="dock glass" aria-label="Mission control">
        <div className="composer">
          <label htmlFor="prompt" className="eyebrow">
            Mission brief
          </label>
          <textarea
            id="prompt"
            rows={3}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Describe the mission for ATLAS and the team..."
          />
          <div className="row">
            <button className="btn primary" type="button" disabled={launching} onClick={() => void launchMission()}>
              {launching ? 'Launching…' : 'Run mission'}
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              Budget $
              <input
                className="budget-in"
                type="number"
                min={0.5}
                max={1000}
                step={0.5}
                value={budgetUsd}
                onChange={(e) => setBudgetUsd(e.target.value)}
              />
            </label>
          </div>
          {(launchErr || (mission?.status === 'failed' && mission.error)) && (
            <span className="err-text" style={{ fontSize: 12 }}>
              {launchErr || mission?.error}
            </span>
          )}
        </div>

        <div className="graph">
          <div className="eyebrow">
            Task graph <span style={{ color: 'var(--faint)' }}>{totalCount ? `· ${doneCount}/${totalCount} done` : ''}</span>
          </div>
          <TaskGraphSvg
            tasks={mission?.tasks ?? []}
            onSelectAgent={(aid) => {
              setSelectedAgent(aid);
              engineRef.current?.focusAgent(aid);
            }}
          />
        </div>

        <div className="feed">
          <div className="eyebrow">Event stream</div>
          <ol className="feed-list" aria-live="polite">
            {feed.map((item) => (
              <li key={item.id} className={item.kind}>
                <time>{item.time}</time>
                <span className="who" style={{ color: item.color }}>
                  {item.who}
                </span>
                <span className="what">{item.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
