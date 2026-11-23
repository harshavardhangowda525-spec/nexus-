// Standalone worker process (scale horizontally; run the API with NEXUS_RUN_WORKER=false).
import { createRuntime, recover } from './app.js';
import { loadConfig } from './config.js';
import { startWorker } from './orchestrator/queue.js';

const cfg = loadConfig();
const { rt, close } = await createRuntime(cfg);
const worker = startWorker(rt, cfg.redisUrl, cfg.queuePrefix, cfg.workerConcurrency);
await recover(rt);
console.log(`[nexus] worker running (concurrency ${cfg.workerConcurrency})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await worker.close();
    await close();
    process.exit(0);
  });
}
