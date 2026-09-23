import 'dotenv/config';
import http from 'node:http';
import './discord.js';
import { startSyncScheduler } from './index.js';

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'coc-discord-bot' }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
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
