/**
 * Очередь с дедупликацией внутри окна до flush.
 * Одинаковый key пока задача ждёт или уже выполняется получает тот же результат.
 * Новые ключи, пришедшие во время flush, остаются на следующий такт —
 * за один такт обрабатывается только один пакет.
 */
export class BatchQueue {
  constructor() {
    this.pending = new Map();
    this.inflight = null;
    this.flushing = false;
  }

  get size() {
    return this.pending.size;
  }

  enqueue(key, task) {
    const current = this.inflight?.get(key);
    if (current && !current.done) {
      return new Promise((resolve, reject) => {
        current.waiters.push({ resolve, reject });
      });
    }

    let entry = this.pending.get(key);
    if (!entry) {
      entry = { task, waiters: [], done: false };
      this.pending.set(key, entry);
    }
    return new Promise((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  }

  async flush() {
    if (this.flushing) return { ran: false, count: 0 };
    if (this.pending.size === 0) return { ran: true, count: 0 };
    this.flushing = true;
    const batch = this.pending;
    this.pending = new Map();
    this.inflight = batch;
    let count = 0;
    try {
      for (const entry of batch.values()) {
        count += 1;
        try {
          const result = await entry.task();
          entry.done = true;
          for (const waiter of entry.waiters) waiter.resolve(result);
        } catch (error) {
          entry.done = true;
          for (const waiter of entry.waiters) waiter.reject(error);
        }
      }
    } finally {
      this.inflight = null;
      this.flushing = false;
    }
    return { ran: true, count };
  }
}

export function createScheduler({ dataBatchMs, addBatchMs }) {
  const reads = new BatchQueue();
  const writes = new BatchQueue();
  const adds = new BatchQueue();
  let nextDataAt = Date.now() + dataBatchMs;
  let nextAddAt = Date.now() + addBatchMs;
  let dataTimer = null;
  let addTimer = null;
  let dataRunning = false;
  let addRunning = false;
  let stopped = false;

  async function flushData() {
    if (stopped || dataRunning) return;
    dataRunning = true;
    try {
      const writeResult = await writes.flush();
      const readResult = await reads.flush();
      if (writeResult.count || readResult.count) {
        console.log(
          `[data-batch] writes=${writeResult.count} reads=${readResult.count}`,
        );
      }
    } finally {
      dataRunning = false;
    }
  }

  async function flushAdds() {
    if (stopped || addRunning) return;
    addRunning = true;
    try {
      const result = await adds.flush();
      if (result.count) console.log(`[add-batch] adds=${result.count}`);
    } finally {
      addRunning = false;
    }
  }

  return {
    reads,
    writes,
    adds,
    start() {
      dataTimer = setInterval(() => {
        nextDataAt = Date.now() + dataBatchMs;
        void flushData();
      }, dataBatchMs);
      addTimer = setInterval(() => {
        nextAddAt = Date.now() + addBatchMs;
        void flushAdds();
      }, addBatchMs);
    },
    stop() {
      stopped = true;
      clearInterval(dataTimer);
      clearInterval(addTimer);
    },
    timing() {
      return {
        dataMs: dataBatchMs,
        addMs: addBatchMs,
        nextDataInMs: Math.max(0, nextDataAt - Date.now()),
        nextAddInMs: Math.max(0, nextAddAt - Date.now()),
      };
    },
  };
}
