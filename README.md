# A Million IDs

**English** | [Русский](README.ru.md)

Two lists over a registry of 1,000,000 IDs: everything not selected on the left, the selected items in their chosen order on the right.

## Running

Requires Node.js 20+.

```bash
npm install
npm test
npm run dev
```

UI:  http://localhost:5173

Production, as a single process:

```bash
npm run build
npm start
```

App: http://localhost:3000

Selection state is shared by all open tabs and lives in the process memory. Restarting the server resets the selection. Multiple processes do not share memory with each other.

Filters live only in the page state and are cleared on reload.

## How the lists work

The base IDs `1…1000000` are not stored in an array. A page of 20 available items is computed: extra IDs are kept in sorted arrays, and gaps inside the base range are found with binary search.

A batch is always 20 items. The next one loads when the bottom of the list approaches the visible area.

The filter matches the entered string as a substring of the ID's decimal form.

Drag & Drop in the right list reorders the loaded rows. Items hidden by the filter or not loaded yet stay in their positions.

A new ID is passed as a string, so numbers larger than `2^53` work too. Adding an ID that already exists is rejected immediately.

## Queue

- List reads and selection/order changes are collected and executed as one batch once per second. Within a batch, writes are applied first and reads second, so reads see the changes already applied.
- Identical reads within a window are merged into one request. Repeating a select or deselect of the same ID while the operation is pending joins that operation. The opposite operation is queued after it and does not overwrite it.
- Adds are executed as a batch once every 10 seconds. While an ID is reserved, parallel adds of the same value get one result and create one entry.

The service endpoint `GET /api/meta` responds immediately: it is queue telemetry, not a registry read.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/items?side=available\|selected&filter=&offset=` | A batch of 20 items |
| POST | `/api/items` `{ "id": "1000001" }` | Add an ID |
| POST | `/api/selection` `{ "id": "5" }` | Select |
| POST | `/api/selection/remove` `{ "id": "5" }` | Deselect |
| POST | `/api/selection/reorder` `{ "ids": ["3","1"] }` | Reorder a loaded subset |
| GET | `/api/health` | Process health check |
| GET | `/api/meta` | Counters and upcoming batches |

The intervals can be changed with the `DATA_BATCH_MS` and `ADD_BATCH_MS` environment variables.
