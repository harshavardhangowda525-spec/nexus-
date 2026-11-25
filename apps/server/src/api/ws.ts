import type { NexusEvent } from '@nexus/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import { COOKIE, resolveSession } from '../auth/auth.js';
import { EVENTS_CHANNEL } from '../events/bus.js';
import type { Runtime } from '../runtime.js';

/** Pushes every event of the viewer's workspace to their browser in real time. */
export async function registerWs(app: FastifyInstance, rt: Runtime) {
  const clients = new Map<WebSocket, string>();
  const dispatch = (raw: string) => {
    let ws = '';
    try { ws = (JSON.parse(raw) as NexusEvent).workspaceId; } catch { return; }
    for (const [sock, wid] of clients) if (wid === ws && sock.readyState === sock.OPEN) sock.send(raw);
  };

  let stopSub: () => void;
  if (rt.memoryMode) {
    stopSub = rt.redis.subscribe(EVENTS_CHANNEL, dispatch);
  } else {
    const sub = new Redis(rt.cfg.redisUrl);
    await sub.subscribe(EVENTS_CHANNEL);
    sub.on('message', (_ch, raw) => dispatch(raw));
    stopSub = () => sub.disconnect();
  }

  app.get('/api/ws', { websocket: true }, async (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !rt.cfg.webOrigins.includes(origin)) { socket.close(4403, 'origin not allowed'); return; }
    const auth = await resolveSession(rt.db, req.cookies[COOKIE]);
    if (!auth) { socket.close(4401, 'sign in first'); return; }
    clients.set(socket, auth.workspaceId);
    socket.send(JSON.stringify({ type: 'hello', workspaceId: auth.workspaceId }));
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000);
    socket.on('close', () => { clients.delete(socket); clearInterval(ping); });
  });

  app.addHook('onClose', async () => { stopSub(); for (const s of clients.keys()) s.close(); });
}
