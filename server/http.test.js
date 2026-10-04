import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function close(server, app) {
  app.locals.scheduler.stop();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('duplicate adds are reserved once and committed on the add batch', async () => {
  const app = createApp({ dataBatchMs: 80, addBatchMs: 180 });
  const { server, base } = await listen(app);
  try {
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '1000001' }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }))),
    );
    assert.ok(Date.now() - started >= 120);
    assert.ok(responses.every((item) => item.status === 200 && item.body.ok && item.body.id === '1000001'));
    assert.equal(app.locals.store.extraSet.size, 1);

    const again = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '0001000001' }),
    });
    assert.equal(again.status, 409);
    assert.equal(app.locals.store.extraSet.size, 1);
  } finally {
    await close(server, app);
  }
});

test('existing ids are rejected immediately and distinct ids all land in one batch', async () => {
  const app = createApp({ dataBatchMs: 50, addBatchMs: 120 });
  const { server, base } = await listen(app);
  try {
    const existingStarted = Date.now();
    const existing = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 42 }),
    });
    assert.equal(existing.status, 409);
    assert.ok(Date.now() - existingStarted < 80);

    const ids = Array.from({ length: 30 }, (_, index) => String(2_000_000 + index));
    const created = await Promise.all(ids.map((id) => fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then((response) => response.json())));
    assert.ok(created.every((item) => item.ok));
    assert.equal(app.locals.store.extraSet.size, 30);
    assert.deepEqual(app.locals.store.above, ids);
  } finally {
    await close(server, app);
  }
});

test('reads are deduplicated and see writes from the same data batch', async () => {
  const app = createApp({ dataBatchMs: 100, addBatchMs: 5000 });
  const { server, base } = await listen(app);
  const store = app.locals.store;
  const original = store.pageAvailable.bind(store);
  let reads = 0;
  store.pageAvailable = (...args) => {
    reads += 1;
    return original(...args);
  };
  try {
    const [selectResult, listA, listB] = await Promise.all([
      fetch(`${base}/api/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '1' }),
      }).then((response) => response.json()),
      fetch(`${base}/api/items?side=available&offset=0`).then((response) => response.json()),
      fetch(`${base}/api/items?side=available&offset=0`).then((response) => response.json()),
    ]);
    assert.equal(selectResult.ok, true);
    assert.equal(reads, 1);
    assert.equal(listA.items[0], '2');
    assert.deepEqual(listA.items, listB.items);
    assert.equal(listA.version, selectResult.version);

    const selected = await fetch(`${base}/api/items?side=selected&offset=0`).then((response) => response.json());
    assert.deepEqual(selected.items, ['1']);

    const reordered = await fetch(`${base}/api/selection/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['1'] }),
    }).then((response) => response.json());
    assert.equal(reordered.ok, true);

    await fetch(`${base}/api/selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '3' }),
    });
    await fetch(`${base}/api/selection/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1' }),
    });
    const after = await fetch(`${base}/api/items?side=selected&offset=0`).then((response) => response.json());
    assert.deepEqual(after.items, ['3']);
    const available = await fetch(`${base}/api/items?side=available&offset=0`).then((response) => response.json());
    assert.equal(available.items[0], '1');
  } finally {
    await close(server, app);
  }
});

test('selection toggles queued in one window stay in arrival order', async () => {
  const app = createApp({ dataBatchMs: 400, addBatchMs: 5000 });
  const { server, base } = await listen(app);
  try {
    const post = (pathname, body) => fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const select = post('/api/selection', { id: '7' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const remove = post('/api/selection/remove', { id: '7' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const selectAgain = post('/api/selection', { id: '7' });
    const results = await Promise.all([select, remove, selectAgain]);
    assert.ok(results.every((response) => response.ok));
    const selected = await fetch(`${base}/api/items?side=selected&offset=0`).then((response) => response.json());
    assert.deepEqual(selected.items, ['7']);
  } finally {
    await close(server, app);
  }
});
