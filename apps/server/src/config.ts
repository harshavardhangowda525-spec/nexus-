import path from 'node:path';

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** All runtime configuration comes from the environment. See .env.example. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(env.NEXUS_DATA_DIR || path.join(process.cwd(), '../../data'));
  return {
    port: num(env.PORT, 4000),
    host: env.HOST || '127.0.0.1',
    webOrigins: list(env.WEB_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000'),
    databaseUrl: env.DATABASE_URL || 'postgres://nexus:nexus@127.0.0.1:5432/nexus',
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    /** 32-byte key, base64. Encrypts provider credentials at rest. */
    masterKey: env.NEXUS_MASTER_KEY || '',
    cookieSecure: env.COOKIE_SECURE === 'true',
    dataDir,
    runWorker: env.NEXUS_RUN_WORKER !== 'false',
    workerConcurrency: num(env.NEXUS_WORKER_CONCURRENCY, 4),
    defaultMissionBudgetUsd: num(env.NEXUS_DEFAULT_BUDGET_USD, 5),
    queuePrefix: env.NEXUS_QUEUE_PREFIX || 'nexus',
    supabase: {
      url: env.SUPABASE_URL || '',
      anonKey: env.SUPABASE_ANON_KEY || '',
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    },
    sandbox: {
      provider: (env.SANDBOX_PROVIDER === 'e2b' ? 'e2b' : 'docker') as 'docker' | 'e2b',
      e2bApiKey: env.E2B_API_KEY || '',
      e2bTemplate: env.E2B_TEMPLATE || '',
      execImage: env.SANDBOX_EXEC_IMAGE || 'mirror.gcr.io/library/node:22-bookworm-slim',
      browserImage: env.SANDBOX_BROWSER_IMAGE || 'mcr.microsoft.com/playwright:v1.49.1-noble',
      memory: env.SANDBOX_MEMORY || '1g',
      cpus: env.SANDBOX_CPUS || '1',
      pids: num(env.SANDBOX_PIDS, 256),
      execTimeoutMs: num(env.SANDBOX_EXEC_TIMEOUT_MS, 120_000),
      maxOutputBytes: num(env.SANDBOX_MAX_OUTPUT_BYTES, 64_000),
      uid: env.SANDBOX_UID || (process.getuid && process.getuid() > 0 ? `${process.getuid()}:${process.getgid!()}` : '1000:1000'),
      browserNetwork: env.SANDBOX_BROWSER_NETWORK || 'nexus-browser',
      browserWorkerDir: path.resolve(env.SANDBOX_BROWSER_WORKER_DIR || path.join(process.cwd(), '../../sandbox/browser-worker')),
      browserTimeoutMs: num(env.SANDBOX_BROWSER_TIMEOUT_MS, 45_000),
      /** Optional PEM file trusted inside the browser sandbox (for TLS-inspecting corporate proxies). */
      extraCaFile: env.SANDBOX_EXTRA_CA_FILE || '',
    },
    egress: {
      port: num(env.EGRESS_PORT, 3128),
      /** Upstream HTTP proxy for the gateway itself (CONNECT). Defaults to HTTPS_PROXY. */
      upstreamProxy: env.EGRESS_UPSTREAM_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? '',
      allow: list(env.EGRESS_ALLOW),
      deny: list(env.EGRESS_DENY || 'metadata.google.internal,169.254.169.254'),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
