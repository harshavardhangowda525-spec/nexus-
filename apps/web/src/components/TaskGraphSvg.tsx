'use client';

import { AGENT_PROFILES, type TaskView } from '@nexus/shared';

interface Props {
  tasks: TaskView[];
  onSelectAgent?: (agentId: TaskView['agentId']) => void;
}

export function TaskGraphSvg({ tasks, onSelectAgent }: Props) {
  if (!tasks.length) {
    return (
      <div className="graph-scroll">
        <svg className="graph-svg" viewBox="0 0 560 172" preserveAspectRatio="xMidYMid meet" aria-label="Task dependency graph" />
        <p className="empty">ATLAS draws the plan here once it breaks down the brief.</p>
      </div>
    );
  }

  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const depth = new Map<string, number>();
  const getDepth = (k: string, seen = new Set<string>()): number => {
    if (depth.has(k)) return depth.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const t = byKey.get(k);
    const d = t && t.deps.length ? Math.max(...t.deps.map((dp) => getDepth(dp, seen) + 1)) : 0;
    depth.set(k, d);
    return d;
  };
  tasks.forEach((t) => getDepth(t.key));

  const cols = new Map<number, TaskView[]>();
  for (const t of tasks) {
    const d = depth.get(t.key) ?? 0;
    cols.set(d, [...(cols.get(d) ?? []), t]);
  }
  const colCount = Math.max(1, cols.size);
  const nodeW = 160;
  const nodeH = 44;
  const colGap = 36;
  const width = Math.max(560, colCount * nodeW + (colCount - 1) * colGap + 16);
  const maxRows = Math.max(1, ...Array.from(cols.values()).map((l) => l.length));
  const height = Math.max(172, maxRows * 56 + 12);

  const pos = new Map<string, { x: number; y: number }>();
  for (const [col, list] of cols) {
    const x = 4 + col * (nodeW + colGap);
    const totalH = list.length * nodeH + (list.length - 1) * 14;
    const startY = Math.max(6, (height - totalH) / 2);
    list.forEach((t, idx) => {
      pos.set(t.key, { x, y: startY + idx * (nodeH + 14) });
    });
  }

  return (
    <div className="graph-scroll">
      <svg className="graph-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-label="Task dependency graph">
        <g>
          {tasks.flatMap((t) =>
            t.deps.map((dk) => {
              const s = pos.get(dk);
              const e = pos.get(t.key);
              if (!s || !e) return null;
              const x1 = s.x + nodeW;
              const y1 = s.y + nodeH / 2;
              const x2 = e.x;
              const y2 = e.y + nodeH / 2;
              const cx = (x1 + x2) / 2;
              const srcStatus = byKey.get(dk)?.status;
              const cls = srcStatus === 'completed' ? (t.status === 'running' ? 'edge flow' : 'edge done') : 'edge';
              return <path key={`${dk}-${t.key}`} className={cls} d={`M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`} />;
            }),
          )}
        </g>
        {tasks.map((t) => {
          const p = pos.get(t.key);
          if (!p) return null;
          const profile = AGENT_PROFILES[t.agentId];
          const label = t.title.length > 17 ? t.title.slice(0, 16) + '…' : t.title;
          return (
            <g
              key={t.id}
              className={`node ${t.status}`}
              transform={`translate(${p.x},${p.y})`}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelectAgent?.(t.agentId)}
            >
              <rect width={nodeW} height={nodeH} rx="11" />
              <circle cx="16" cy="22" r="5" fill={profile.color} />
              <text className="nt" x="30" y="19">
                {t.key} · {label}
              </text>
              <text className="ns" x="30" y="34">
                {profile.name} · {t.status.replace('_', ' ')}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
