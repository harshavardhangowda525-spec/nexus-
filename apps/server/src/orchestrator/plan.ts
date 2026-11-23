import { SPECIALIST_IDS, type AgentId } from '@nexus/shared';
import { z } from 'zod';
import type { ToolSpec } from '../models/types.js';

export const SUBMIT_PLAN: ToolSpec = {
  name: 'submit_plan',
  description: 'Submit the mission plan: tasks for your specialists, with dependencies.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One or two sentences on how the team will approach the brief' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short id like T1' },
            title: { type: 'string', description: 'Under 40 characters' },
            description: { type: 'string' },
            agent: { type: 'string', enum: [...SPECIALIST_IDS] },
            deps: { type: 'array', items: { type: 'string' }, description: 'Keys of tasks that must finish first' },
          },
          required: ['key', 'title', 'description', 'agent', 'deps'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'tasks'],
    additionalProperties: false,
  },
};

const PlanSchema = z.object({
  summary: z.string().min(1).max(1000),
  tasks: z.array(z.object({
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,9}$/, 'key must be a short id like T1'),
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(3000),
    agent: z.enum(SPECIALIST_IDS),
    deps: z.array(z.string()).max(6),
  })).min(1).max(8),
});

export type Plan = z.infer<typeof PlanSchema>;

/** Validates a plan proposed by the model: schema, unique keys, known deps, available agents, no cycles. */
export function validatePlan(input: unknown, available: AgentId[]): { ok: true; plan: Plan } | { ok: false; error: string } {
  const p = PlanSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const plan = p.data;
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (keys.has(t.key)) return { ok: false, error: `duplicate task key ${t.key}` };
    if (t.key === 'R') return { ok: false, error: 'task key R is reserved for the final report' };
    keys.add(t.key);
  }
  for (const t of plan.tasks) {
    if (!available.includes(t.agent)) return { ok: false, error: `${t.agent.toUpperCase()} is not available; use only: ${available.join(', ')}` };
    for (const d of t.deps) {
      if (!keys.has(d)) return { ok: false, error: `task ${t.key} depends on unknown task ${d}` };
      if (d === t.key) return { ok: false, error: `task ${t.key} depends on itself` };
    }
  }
  // Cycle check (Kahn).
  const indeg = new Map(plan.tasks.map((t) => [t.key, t.deps.length]));
  const queue = plan.tasks.filter((t) => t.deps.length === 0).map((t) => t.key);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift()!;
    seen++;
    for (const t of plan.tasks) if (t.deps.includes(k)) {
      indeg.set(t.key, indeg.get(t.key)! - 1);
      if (indeg.get(t.key) === 0) queue.push(t.key);
    }
  }
  if (seen !== plan.tasks.length) return { ok: false, error: 'the dependencies contain a cycle' };
  return { ok: true, plan };
}
