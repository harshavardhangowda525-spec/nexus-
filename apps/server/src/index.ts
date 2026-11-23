import { buildServer } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const { app } = await buildServer(cfg);
await app.listen({ port: cfg.port, host: cfg.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig}: shutting down`);
    await app.close();
    process.exit(0);
  });
}
