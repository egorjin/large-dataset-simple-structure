import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const app = createApp();
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`registry listening on http://0.0.0.0:${port}`);
});

function shutdown() {
  app.locals.scheduler.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
