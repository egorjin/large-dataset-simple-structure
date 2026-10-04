import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Store, parseId } from './store.js';
import { createScheduler } from './batchQueue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_OFFSET = 2_000_000;
const MAX_QUEUED_READS = 2_000;
const MAX_QUEUED_WRITES = 5_000;
const MAX_QUEUED_ADDS = 5_000;

function send(res, payload) {
  const status = payload.status ?? (payload.ok === false ? 400 : 200);
  const body = { ...payload };
  delete body.status;
  res.status(status).json(body);
}

export function createApp(options = {}) {
  const dataBatchMs = options.dataBatchMs ?? Number(process.env.DATA_BATCH_MS || 1000);
  const addBatchMs = options.addBatchMs ?? Number(process.env.ADD_BATCH_MS || 10_000);
  const store = options.store ?? new Store();
  const scheduler = createScheduler({ dataBatchMs, addBatchMs });
  const addJobs = new Map();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.locals.store = store;
  app.locals.scheduler = scheduler;
  app.locals.addJobs = addJobs;

  function snapshot(extra = {}) {
    return { ...extra, ...store.stats(), version: store.version };
  }

  function requestAdd(rawId) {
    const id = parseId(rawId);
    if (!id) return Promise.resolve({ ok: false, error: 'invalid', status: 400 });
    // Уже зафиксированные ID отклоняются сразу, без ожидания 10-секундного пакета.
    if (store.exists(id)) {
      return Promise.resolve({ ok: false, error: 'exists', status: 409, id });
    }
    const inflight = addJobs.get(id);
    if (inflight) return inflight;
    if (addJobs.size >= MAX_QUEUED_ADDS) {
      return Promise.resolve({ ok: false, error: 'overloaded', status: 429 });
    }

    // Резервирование синхронное: второй параллельный запрос с тем же ID
    // присоединяется к первому и не создаёт вторую вставку.
    const promise = scheduler.adds.enqueue(id, () => {
      if (store.exists(id) || !store.add(id)) {
        return snapshot({ ok: false, error: 'exists', status: 409, id });
      }
      return snapshot({ ok: true, status: 200, id });
    });
    const tracked = promise.finally(() => {
      if (addJobs.get(id) === tracked) addJobs.delete(id);
    });
    addJobs.set(id, tracked);
    return tracked;
  }

  const selectionPending = new Map();
  let writeSeq = 0;
  let latestReorder = null;

  function rejectOverloaded(res) {
    if (scheduler.writes.size < MAX_QUEUED_WRITES) return false;
    send(res, { ok: false, error: 'overloaded', status: 429 });
    return true;
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/meta', (_req, res) => {
    res.json({
      ...store.stats(),
      version: store.version,
      queues: {
        reads: scheduler.reads.size,
        writes: scheduler.writes.size,
        adds: addJobs.size,
      },
      batch: scheduler.timing(),
    });
  });

  app.get('/api/items', (req, res) => {
    const side = req.query.side;
    if (side !== 'available' && side !== 'selected') {
      return res.status(400).json({ error: 'invalid_side' });
    }
    const filter = String(req.query.filter ?? '').trim().slice(0, 50);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
      return res.status(400).json({ error: 'invalid_offset' });
    }
    if (scheduler.reads.size >= MAX_QUEUED_READS) {
      return res.status(429).json({ error: 'overloaded' });
    }
    const key = `${side}|${filter}|${offset}`;
    scheduler.reads
      .enqueue(key, () => {
        const page = side === 'available'
          ? store.pageAvailable(filter, offset)
          : store.pageSelected(filter, offset);
        return { ...page, ...store.stats(), version: store.version };
      })
      .then((body) => res.json(body))
      .catch((error) => {
        console.error(error);
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
      });
  });

  app.post('/api/items', (req, res) => {
    requestAdd(req.body?.id)
      .then((payload) => send(res, payload))
      .catch((error) => {
        console.error(error);
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
      });
  });

  function settle(res, promise) {
    promise
      .then((payload) => send(res, payload))
      .catch((error) => {
        console.error(error);
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
      });
  }

  function enqueueSelection(id, action) {
    const pending = selectionPending.get(id);
    if (pending?.action === action) return pending.promise;
    writeSeq += 1;
    const promise = scheduler.writes.enqueue(`${action}:${id}:${writeSeq}`, () => {
      const result = action === 'select' ? store.select(id) : store.deselect(id);
      const status = result.ok ? 200 : 404;
      return snapshot({ ...result, status });
    });
    const tracked = promise.finally(() => {
      if (selectionPending.get(id)?.promise === tracked) selectionPending.delete(id);
    });
    selectionPending.set(id, { action, promise: tracked });
    latestReorder = null;
    return tracked;
  }

  app.post('/api/selection', (req, res) => {
    const id = parseId(req.body?.id);
    if (!id) return send(res, { ok: false, error: 'invalid', status: 400 });
    if (!store.exists(id)) return send(res, { ok: false, error: 'missing', status: 404, id });
    const pending = selectionPending.get(id);
    if (pending?.action !== 'select' && rejectOverloaded(res)) return undefined;
    return settle(res, enqueueSelection(id, 'select'));
  });

  app.post('/api/selection/remove', (req, res) => {
    const id = parseId(req.body?.id);
    if (!id) return send(res, { ok: false, error: 'invalid', status: 400 });
    const pending = selectionPending.get(id);
    if (pending?.action !== 'deselect' && rejectOverloaded(res)) return undefined;
    return settle(res, enqueueSelection(id, 'deselect'));
  });

  app.post('/api/selection/reorder', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) {
      return send(res, { ok: false, error: 'invalid_order', status: 400 });
    }
    const signature = ids.map((id) => String(id)).join('\n');
    if (latestReorder?.signature === signature) {
      return settle(res, latestReorder.promise);
    }
    if (rejectOverloaded(res)) return undefined;
    writeSeq += 1;
    const epoch = writeSeq;
    const promise = scheduler.writes.enqueue(`reorder:${epoch}`, () => {
      const result = store.reorder(ids);
      return snapshot({ ...result, status: result.ok ? 200 : 400 });
    });
    const tracked = promise.finally(() => {
      if (latestReorder?.epoch === epoch) latestReorder = null;
    });
    latestReorder = { signature, promise: tracked, epoch };
    return settle(res, tracked);
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const distDir = path.join(__dirname, '../client/dist');
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'), (error) => {
      if (error) next();
    });
  });

  scheduler.start();
  return app;
}
