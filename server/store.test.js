import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, parseId, cmpId, BASE_MAX, PAGE_SIZE } from './store.js';
import { BatchQueue } from './batchQueue.js';

test('parseId canonicalizes integers and rejects everything else', () => {
  assert.equal(parseId('00012'), '12');
  assert.equal(parseId('  -000 '), '0');
  assert.equal(parseId('-00015'), '-15');
  assert.equal(parseId(12), '12');
  assert.equal(parseId('1.5'), null);
  assert.equal(parseId('1e2'), null);
  assert.equal(parseId(''), null);
  assert.equal(parseId('9007199254740993'), '9007199254740993');
  assert.equal(parseId(Number.MAX_SAFE_INTEGER + 2), null);
  assert.ok(cmpId('-10', '-2') < 0);
  assert.ok(cmpId('-2', '0') < 0);
  assert.ok(cmpId('99', '100') < 0);
  assert.ok(cmpId('10000000000000000001', '999999999999999999') > 0);
});

test('first page is 1..20 and the tail stops at 1000000', () => {
  const store = new Store();
  const first = store.pageAvailable('', 0);
  assert.deepEqual(first.items, Array.from({ length: 20 }, (_, i) => String(i + 1)));
  assert.equal(first.hasMore, true);
  assert.equal(first.total, BASE_MAX);

  const nearEnd = store.pageAvailable('', 999_980);
  assert.deepEqual(
    nearEnd.items,
    Array.from({ length: 20 }, (_, i) => String(999_981 + i)),
  );
  assert.equal(nearEnd.hasMore, false);

  const lastPartial = store.pageAvailable('', 999_990);
  assert.deepEqual(lastPartial.items, Array.from({ length: 10 }, (_, i) => String(999_991 + i)));
  assert.equal(lastPartial.hasMore, false);
});

test('selected ids disappear from the left and keep insertion order on the right', () => {
  const store = new Store();
  store.select('5');
  store.select('1');
  store.select('20');
  const left = store.pageAvailable('', 0);
  assert.equal(left.items[0], '2');
  assert.equal(left.items.includes('1'), false);
  assert.equal(left.items.includes('5'), false);
  assert.equal(left.total, BASE_MAX - 3);
  assert.deepEqual(store.pageSelected('', 0).items.slice(0, 3), ['5', '1', '20']);

  const aroundHole = store.pageAvailable('', 0);
  assert.equal(aroundHole.items[3], '6');

  store.select('50');
  store.select('51');
  store.select('52');
  const page = store.pageAvailable('', 40);
  assert.deepEqual(page.items, [
    '44', '45', '46', '47', '48', '49',
    '53', '54', '55', '56', '57', '58', '59', '60', '61', '62', '63', '64', '65', '66',
  ]);
});

test('kth unselected base id jumps over a dense selection', () => {
  const store = new Store();
  for (let n = 1; n <= 1000; n += 1) store.select(String(n));
  assert.equal(store.kthUnselectedBase(0), 1001);
  assert.equal(store.pageAvailable('', 0).items[0], '1001');
  store.select('1000000');
  assert.equal(store.kthUnselectedBase(998_998), 999_999);
});

test('custom ids keep numeric order and cannot repeat', () => {
  const store = new Store();
  assert.equal(store.add('1000001'), true);
  assert.equal(store.add('0'), true);
  assert.equal(store.add('-10'), true);
  assert.equal(store.add('-2'), true);
  assert.equal(store.add('1000001'), false);
  assert.equal(store.add('0001'), false);
  assert.equal(store.add('1000000'), false);

  const first = store.pageAvailable('', 0);
  assert.deepEqual(first.items.slice(0, 4), ['-10', '-2', '0', '1']);
  const tail = store.pageAvailable('', store.stats().availableCount - 4);
  assert.equal(tail.items.at(-1), '1000001');
  assert.equal(tail.hasMore, false);
  assert.equal(store.stats().availableCount, BASE_MAX + 4);
});

test('filter is a substring, pages by 20, and hides selected ids', () => {
  const store = new Store();
  store.select('13');
  const page = store.pageAvailable('13', 0);
  assert.equal(page.items.includes('13'), false);
  assert.equal(page.items[0], '113');
  assert.equal(page.items.length, PAGE_SIZE);
  assert.equal(page.hasMore, true);
  assert.deepEqual(store.pageSelected('13', 0).items, ['13']);

  const exact = store.pageAvailable('1000000', 0);
  assert.deepEqual(exact.items, ['1000000']);
  assert.equal(exact.hasMore, false);

  const none = store.pageAvailable('10000000', 0);
  assert.deepEqual(none.items, []);
});

test('filtered reorder keeps hidden items in place', () => {
  const store = new Store();
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) store.select(id);
  const result = store.reorder(['8', '6', '4', '2']);
  assert.equal(result.ok, true);
  assert.deepEqual(store.selectedOrder, ['1', '8', '3', '6', '5', '4', '7', '2']);
  assert.deepEqual(
    store.selectedOrder.filter((id) => Number(id) % 2 === 0),
    ['8', '6', '4', '2'],
  );
});

test('reorder rejects ids that are not selected', () => {
  const store = new Store();
  store.select('1');
  store.select('2');
  assert.equal(store.reorder(['2', '3']).ok, false);
  assert.deepEqual(store.selectedOrder, ['1', '2']);
});

test('deselect returns an id to its numeric place', () => {
  const store = new Store();
  store.add('-4');
  store.select('-4');
  store.select('2');
  store.deselect('2');
  store.deselect('-4');
  const page = store.pageAvailable('', 0);
  assert.equal(page.items[0], '-4');
  assert.equal(page.items[1], '1');
  assert.equal(store.pageSelected('', 0).items.length, 0);
});

test('batch queue runs each key once and shares the result', async () => {
  const queue = new BatchQueue();
  let runs = 0;
  const tasks = Array.from({ length: 10 }, () => queue.enqueue('same', async () => {
    runs += 1;
    return 'ok';
  }));
  tasks.push(queue.enqueue('other', async () => {
    runs += 1;
    return 'other';
  }));
  assert.equal(runs, 0);
  await queue.flush();
  const values = await Promise.all(tasks);
  assert.equal(runs, 2);
  assert.deepEqual(values.slice(0, 10), Array.from({ length: 10 }, () => 'ok'));
  assert.equal(values[10], 'other');
});
