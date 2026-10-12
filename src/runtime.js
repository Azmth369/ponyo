import 'dotenv/config';
import http from 'node:http';
import './discord.js';
import { startSyncScheduler } from './index.js';
import { handleApi } from './api.js';

const port = Number(process.env.PORT || 3000);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'ponyo-coc-api' }));
    return;
  }
  try {
    if (await handleApi(req, res, url)) return;
  } catch (error) {
    console.error('[runtime] request error:', error?.message ?? 'unknown error');
  }
  if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); }
});

server.listen(port, '0.0.0.0', () => console.log(`[runtime] health server listening on ${port}`));
await startSyncScheduler();

const shutdown = signal => {
  console.log(`[runtime] ${signal}; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
