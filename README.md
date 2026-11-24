# NEXUS

NEXUS is a multi-agent AI workforce running inside a live interactive 3D office. Five specialized agents (**ATLAS**, **FORGE**, **SCOUT**, **PULSE**, **LEDGER**) collaborate on missions directed by a human CEO. Every animation, monitor texture, messaging arc, task graph node, and approval prompt in the 3D office is driven strictly by real backend events — never faked progress.

## Architecture Overview

NEXUS is a TypeScript monorepo with three workspaces plus an isolated browser worker:

- **`packages/shared`** (`@nexus/shared`): Shared agent profiles, event types (`NexusEvent`), task/mission/approval view models, and tool-to-visual-state mappings.
- **`apps/server`** (`@nexus/server`): Node 22, Fastify 5, Postgres (`pg`), BullMQ 5 (`ioredis`), Zod 3, Vitest 3.
  - **API & WebSocket (`src/api/`)**: Session-authenticated REST API (`/api/*`), sandboxed site preview (`/preview/:id/*`), and real-time workspace event stream (`/api/ws`).
  - **Orchestrator (`src/orchestrator/`)**: ATLAS planning via `submit_plan` with DAG validation (unique keys, known deps, available agents, cycle detection), final report task `R`, per-agent scheduling, pause/resume/cancel, task retry, approval decisions + outbox recording, and BullMQ queue/worker with crash recovery on startup.
  - **Agent Runner & Tools (`src/agents/`)**: Checkpointed step-by-step execution persisted to Postgres (`tasks.checkpoint`), budget & step-limit enforcement, inter-agent messaging, approval parking, versioned file artifacts, and role-scoped tools (`run_command` for FORGE, `search_web`/`browse`/`screenshot` for SCOUT, `request_approval` for LEDGER).
  - **Model Gateway (`src/models/`)**: Provider-agnostic gateway with retries, exponential backoff, pricing, and usage tracking across Anthropic (`@anthropic-ai/sdk` 1.12), OpenAI-compatible, Google Gemini, and Ollama. Raw provider assistant content (Anthropic thinking blocks, Gemini thought signatures) is stored and replayed unchanged.
  - **Sandboxes & Egress (`src/sandbox/`)**: Per-agent Docker execution computers, Playwright Chromium browser containers, HTTP(S) egress proxy gateway, and host-side path confinement.
- **`apps/web`** (`@nexus/web`): Next.js 15, React 19, Three.js 0.170, GSAP 3.12.
  - Typed `OfficeEngine` rendering the 3D office, five distinct robots, live monitor canvases (including SCOUT's streamed JPEG browser frames), messaging arcs, celebration bursts, and adaptive quality (pixel ratio cap, shadow drop below ~40 fps, `prefers-reduced-motion`, responsive layout).
  - Same-origin Next.js rewrites for `/api/*` and `/preview/*`, plus live `/api/ws` WebSocket updates.
- **`sandbox/browser-worker`**: Standalone Playwright Chromium driver (`playwright-core` 1.49.1) mounted read-only into SCOUT's browser container. Intentionally excluded from npm workspaces; install separately with `npm install --prefix sandbox/browser-worker`.

## Security Model

- **Execution Sandboxes (FORGE)**: Every `run_command` runs inside a dedicated Docker container (`mirror.gcr.io/library/node:22-bookworm-slim`) with:
  - `--network none` (zero network interfaces besides loopback)
  - `--read-only` root filesystem, writable only at `/workspace` (project files) and `/tmp` (`tmpfs`, `nosuid`, `size=512m`)
  - `--cap-drop ALL` and `--security-opt no-new-privileges`
  - Non-root UID:GID (`SANDBOX_UID`, defaulting to current non-root host UID:GID)
  - Hard resource limits (`--memory`, `--memory-swap`, `--cpus`, `--pids-limit`) and command timeouts
  - Model-generated commands are never executed on the host.
- **Browser Sandbox & Egress Gateway (SCOUT)**: Runs `mcr.microsoft.com/playwright:v1.49.1-noble` with `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root `pwuser`, and a dedicated Docker bridge network (`nexus-browser`). All HTTP/HTTPS traffic routes through NEXUS's `EgressGateway`:
  - Per-sandbox random `Proxy-Authorization` tokens tied to `(workspaceId, missionId, agentId)`.
  - Blocks loopback, RFC 1918 private ranges, CGNAT, link-local, cloud metadata (`169.254.169.254`, `metadata.google.internal`), `.local`/`.internal` hostnames, and non-80/443 ports — both by hostname and after DNS resolution.
  - Supports configurable `EGRESS_ALLOW` / `EGRESS_DENY` lists and records `egress.allow` / `egress.deny` entries in `audit_log`.
  - Behind a TLS-inspecting corporate proxy, set `SANDBOX_EXTRA_CA_FILE` to import the proxy CA into Chromium's NSS database. TLS verification is never disabled.
- **Host Path Confinement**: `ProjectFiles` rejects path traversal, absolute paths, null bytes, and symlinks escaping the project root, and opens writes with `O_NOFOLLOW`.
- **Sandboxed Site Previews**: `/preview/:id/*` serves agent-built websites with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups; ... connect-src 'none'` (opaque origin), preventing agent-written scripts from reading NEXUS session cookies or calling `/api/*`.
- **Human-in-the-Loop Approvals**: External side effects (email, CRM updates, invoices) always pause the task via `request_approval` until the CEO explicitly approves or rejects them.
- **Encrypted Credentials**: Provider API keys are encrypted at rest with AES-256-GCM (`NEXUS_MASTER_KEY`, 32 random bytes base64-encoded). Keys are never returned by the API, never sent to the frontend, and never logged. The Anthropic adapter explicitly sets `baseURL` and `authToken: null` so server environment variables never leak into workspace calls.
- **Prompt-Injection Defense**: Content read from web pages, search results, and project files is wrapped in `<untrusted_content>` delimiters (with inner closing tags stripped) and explicit data-not-instructions framing.
- **Audit Trail & RBAC**: Workspace roles (`owner`, `admin`, `operator`, `viewer`), scrypt password hashing, `HttpOnly` `SameSite=Lax` session cookies, CSRF origin/JSON checks, and an append-only `audit_log` table.

## Setup on Neon Postgres

1. **Prerequisites**: Node.js >= 22, Docker daemon running, and Redis (local Docker Redis or Upstash TCP/TLS URL).
2. **Install dependencies**:
   ```bash
   npm install
   npm run sandbox:setup
   ```
   `sandbox:setup` pulls `mirror.gcr.io/library/node:22-bookworm-slim` and `mcr.microsoft.com/playwright:v1.49.1-noble`, installs `sandbox/browser-worker` dependencies, and creates the `nexus-browser` Docker bridge network.
3. **Configure `.env`**:
   ```bash
   cp .env.example .env
   openssl rand -base64 32   # paste into NEXUS_MASTER_KEY
   ```
   - Set `DATABASE_URL` to your **Neon Postgres** connection string (must include `sslmode=require`).
   - `gen_random_uuid()` is built into Postgres 13+, so no extensions are required on Neon.
4. **Run migrations** (use Neon's **direct, non-pooler** connection URL for migrations; the pooled URL is fine for running the app):
   ```bash
   DATABASE_URL="postgres://...@ep-xxx.aws.neon.tech/neondb?sslmode=require" npm run migrate
   ```
5. **Start Redis** (if running locally via Docker Compose):
   ```bash
   docker compose up -d redis
   ```
   For offline local development without Neon, you can also start a local Postgres container:
   ```bash
   docker compose --profile local-db up -d redis postgres
   ```
6. **Run NEXUS**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000`, complete the first-time CEO workspace bootstrap, and configure your model providers in **Workforce**.

> **Docker Compose privilege note**: If you run `server` and `worker` inside Docker via `docker-compose.yml`, note that mounting `/var/run/docker.sock` is **privileged** (effectively root-equivalent on the host). Run only on a dedicated host/VM.

## Running with Real Model Providers

In the NEXUS UI, open **Workforce** → **Provider credentials** to add keys (encrypted at rest) and test them before assigning to agents:

- **Anthropic**: Select *Anthropic*, enter your `sk-ant-...` API key. Default model: `claude-opus-5-5` (supports `effort`: `low` / `medium` / `high` / `xhigh` / `max`).
- **OpenAI-compatible**: Select *OpenAI-compatible*, enter your API key and optional custom Base URL (defaults to `https://api.openai.com/v1`). Default model: `gpt-5`.
- **Google Gemini**: Select *Google Gemini*, enter your Gemini API key. Default model: `gemini-2.5-pro`.
- **Ollama (local)**: Select *Ollama (local)*, no API key required; set Base URL (default `http://127.0.0.1:11434/v1`). Default model: `llama3.1`.

Unknown models are recorded and displayed as **`unpriced`** in Insights rather than falsely reporting `$0`.

## Development / Test Mock Model (Dev-Only)

`scripts/mock-llm.mjs` is a **development and testing only** scripted OpenAI-compatible server. It is **not** an AI model — it replays deterministic tool calls for the physiotherapy mission so you can exercise the real orchestrator, Postgres, Redis, Docker sandboxes, Playwright browser, approvals, WebSockets, and 3D UI without spending API tokens.

```bash
npm run mock-llm
# Configure in Workforce as OpenAI-compatible:
#   Base URL: http://127.0.0.1:4010/v1
#   API Key:  any non-empty string (e.g. mock-key)
#   Model:    nexus-mock
```

## Verification & Tests

```bash
npm run typecheck       # TypeScript checks across shared, server, and web
npm run test:unit       # 25 unit tests (crypto, path safety, DAG validation, egress policy, provider adapters)
npm run test            # Full server suite including real Postgres/Redis/Docker/Browser E2E & sandbox isolation
npm run build           # Production Next.js build
npm run test:e2e        # Playwright UI E2E (--trace off)
```

## Known Limits

- **No external delivery transports**: NEXUS does not ship with SMTP, CRM, or invoicing integrations. When the CEO approves an external action (e.g., LEDGER's kickoff email), it is recorded in the `outbox` table with status `undeliverable` and the agent is explicitly informed that it was saved for manual sending.
- **Browser network egress enforcement**: Egress policy enforcement relies on `EgressGateway` being the only route out of the `nexus-browser` Docker network. In production, configure host firewall rules (e.g. `iptables`/`nftables` on the `nexus-browser` bridge) to block direct internet egress from containers on that bridge so only traffic to the gateway host/port is permitted.
- **Exec sandbox toolchain**: `mirror.gcr.io/library/node:22-bookworm-slim` includes Node.js 22 and npm, but does not pre-install `git`. If you want FORGE to run `git` commands inside its sandbox, build a custom exec image with `git` installed and set `SANDBOX_EXEC_IMAGE`.
