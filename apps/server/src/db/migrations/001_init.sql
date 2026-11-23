-- NEXUS initial schema

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','operator','viewer')),
  primary key (workspace_id, user_id)
);

create table sessions (
  id text primary key,               -- sha256 of the session token
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table provider_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null check (provider in ('anthropic','openai','gemini','ollama')),
  label text not null,
  base_url text,
  secret_ciphertext text,            -- AES-256-GCM, never returned by the API
  secret_hint text,
  created_at timestamptz not null default now(),
  unique (workspace_id, label)
);

create table agents (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null check (id in ('atlas','forge','scout','pulse','ledger')),
  enabled boolean not null default true,
  credential_id uuid references provider_credentials(id) on delete set null,
  model text,
  effort text,
  max_steps int not null default 30,
  primary key (workspace_id, id)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table missions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  brief text not null,
  status text not null check (status in ('planning','running','paused','completed','failed','cancelled')),
  budget_usd numeric(12,4) not null,
  spent_usd numeric(12,6) not null default 0,
  report text,
  error text,
  plan_checkpoint jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index missions_ws_idx on missions (workspace_id, created_at desc);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references missions(id) on delete cascade,
  key text not null,
  title text not null,
  description text not null,
  agent_id text not null,
  deps text[] not null default '{}',
  status text not null check (status in ('blocked','queued','running','waiting_approval','completed','failed','cancelled')),
  attempt int not null default 0,
  result text,
  error text,
  checkpoint jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (mission_id, key)
);

create table agent_messages (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references missions(id) on delete cascade,
  from_agent text not null,
  to_agent text not null,
  task_id uuid references tasks(id) on delete set null,
  body text not null,
  delivered boolean not null default false,
  created_at timestamptz not null default now()
);

create table events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  mission_id uuid references missions(id) on delete cascade,
  agent_id text,
  task_id uuid,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_mission_idx on events (mission_id, id);
create index events_ws_idx on events (workspace_id, id);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  mission_id uuid not null references missions(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id text not null,
  tool_use_id text not null,
  action text not null,
  summary text not null,
  payload jsonb not null default '{}',
  status text not null check (status in ('pending','approved','rejected')),
  decided_by uuid references users(id),
  decided_at timestamptz,
  note text,
  result jsonb,
  created_at timestamptz not null default now()
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  mission_id uuid references missions(id) on delete set null,
  path text not null,
  version int not null,
  size int not null,
  sha256 text not null,
  agent_id text,
  content bytea not null,            -- version snapshot; the live copy is on disk
  created_at timestamptz not null default now(),
  unique (project_id, path, version)
);

create table usage (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  mission_id uuid references missions(id) on delete cascade,
  agent_id text not null,
  provider text not null,
  model text not null,
  input_tokens int not null,
  output_tokens int not null,
  cost_usd numeric(12,6) not null,
  priced boolean not null,
  duration_ms int not null,
  created_at timestamptz not null default now()
);
create index usage_ws_idx on usage (workspace_id, created_at);

create table outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  approval_id uuid not null references approvals(id) on delete cascade,
  channel text not null,
  payload jsonb not null,
  status text not null check (status in ('queued','delivered','undeliverable')),
  detail text,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  workspace_id uuid,
  actor_type text not null check (actor_type in ('user','agent','system')),
  actor_id text,
  action text not null,
  target text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_ws_idx on audit_log (workspace_id, id desc);
