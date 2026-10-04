export const BASE_MAX = 1_000_000;
export const PAGE_SIZE = 20;
const MAX_ID_DIGITS = 100;

/**
 * Канонический ID — десятичная запись целого числа без ведущих нулей.
 * Строка, а не Number: значения больше 2^53 не теряют точность.
 */
export function parseId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    return canonicalize(String(value));
  }
  if (typeof value === 'string') return canonicalize(value);
  return null;
}

export function canonicalize(input) {
  const trimmed = input.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  let neg = false;
  let digits = trimmed;
  if (digits[0] === '-') {
    neg = true;
    digits = digits.slice(1);
  }
  if (digits.length > MAX_ID_DIGITS) return null;
  digits = digits.replace(/^0+/, '') || '0';
  if (digits === '0') return '0';
  return neg ? `-${digits}` : digits;
}

/** Сравнение десятичных ID, включая отрицательные и длиннее безопасного целого. */
export function cmpId(a, b) {
  const aNeg = a[0] === '-';
  const bNeg = b[0] === '-';
  if (aNeg !== bNeg) return aNeg ? -1 : 1;
  const as = aNeg ? a.slice(1) : a;
  const bs = bNeg ? b.slice(1) : b;
  if (as.length !== bs.length) {
    const byLength = as.length < bs.length ? -1 : 1;
    return aNeg ? -byLength : byLength;
  }
  if (as === bs) return 0;
  const byLex = as < bs ? -1 : 1;
  return aNeg ? -byLex : byLex;
}

export function isBaseId(id) {
  if (id[0] === '-' || id === '0') return false;
  if (id.length < 7) return true;
  if (id.length > 7) return false;
  return id <= '1000000';
}

function insertSorted(arr, id) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmpId(arr[mid], id) < 0) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo] === id) return false;
  arr.splice(lo, 0, id);
  return true;
}

function removeSorted(arr, id) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cmp = cmpId(arr[mid], id);
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo] !== id) return false;
  arr.splice(lo, 1);
  return true;
}

function insertSortedNumber(arr, n) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < n) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo] === n) return false;
  arr.splice(lo, 0, n);
  return true;
}

function removeSortedNumber(arr, n) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < n) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo] !== n) return false;
  arr.splice(lo, 1);
  return true;
}

export class Store {
  constructor() {
    this.version = 0;
    this.extraSet = new Set();
    this.below = [];
    this.above = [];
    this.belowAvailable = [];
    this.aboveAvailable = [];
    this.selectedOrder = [];
    this.selectedSet = new Set();
    this.selectedBase = [];
    this.selectedBaseSet = new Set();
  }

  exists(id) {
    return isBaseId(id) || this.extraSet.has(id);
  }

  stats() {
    const extraCount = this.extraSet.size;
    const selectedCount = this.selectedOrder.length;
    return {
      baseCount: BASE_MAX,
      extraCount,
      selectedCount,
      availableCount: BASE_MAX + extraCount - selectedCount,
    };
  }

  touch() {
    this.version += 1;
  }

  add(id) {
    if (this.exists(id)) return false;
    this.extraSet.add(id);
    if (cmpId(id, '1') < 0) {
      insertSorted(this.below, id);
      insertSorted(this.belowAvailable, id);
    } else {
      insertSorted(this.above, id);
      insertSorted(this.aboveAvailable, id);
    }
    this.touch();
    return true;
  }

  select(id) {
    if (!this.exists(id)) return { ok: false, error: 'missing' };
    if (this.selectedSet.has(id)) return { ok: true, already: true };
    this.selectedSet.add(id);
    this.selectedOrder.push(id);
    if (isBaseId(id)) {
      const n = Number(id);
      insertSortedNumber(this.selectedBase, n);
      this.selectedBaseSet.add(n);
    } else if (cmpId(id, '1') < 0) {
      removeSorted(this.belowAvailable, id);
    } else {
      removeSorted(this.aboveAvailable, id);
    }
    this.touch();
    return { ok: true };
  }

  deselect(id) {
    if (!this.selectedSet.has(id)) return { ok: true, already: true };
    this.selectedSet.delete(id);
    const index = this.selectedOrder.indexOf(id);
    if (index !== -1) this.selectedOrder.splice(index, 1);
    if (isBaseId(id)) {
      const n = Number(id);
      removeSortedNumber(this.selectedBase, n);
      this.selectedBaseSet.delete(n);
    } else if (cmpId(id, '1') < 0) {
      insertSorted(this.belowAvailable, id);
    } else {
      insertSorted(this.aboveAvailable, id);
    }
    this.touch();
    return { ok: true };
  }

  /**
   * Переставляет уже выбранные id, сохраняя позиции остальных.
   * Так Drag & Drop работает и по отфильтрованному окну: скрытые фильтром
   * и ещё не загруженные элементы остаются на своих местах.
   */
  reorder(rawIds) {
    if (!Array.isArray(rawIds) || rawIds.length > 2000) {
      return { ok: false, error: 'invalid_order' };
    }
    if (rawIds.length === 0) return { ok: true };
    const ids = [];
    const moving = new Set();
    for (const raw of rawIds) {
      const id = parseId(raw);
      if (!id || !this.selectedSet.has(id) || moving.has(id)) {
        return { ok: false, error: 'invalid_order' };
      }
      moving.add(id);
      ids.push(id);
    }
    let cursor = 0;
    let changed = false;
    const next = this.selectedOrder.map((id) => {
      if (!moving.has(id)) return id;
      const replacement = ids[cursor++];
      if (replacement !== id) changed = true;
      return replacement;
    });
    if (changed) {
      this.selectedOrder = next;
      this.touch();
    }
    return { ok: true };
  }

  countSelectedBaseUpTo(n) {
    let lo = 0;
    let hi = this.selectedBase.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.selectedBase[mid] <= n) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** k-й (с нуля) невыбранный ID в диапазоне 1..1_000_000. */
  kthUnselectedBase(k) {
    if (this.selectedBase.length === 0) return k + 1;
    let lo = 1;
    let hi = BASE_MAX;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const unselected = mid - this.countSelectedBaseUpTo(mid);
      if (unselected >= k + 1) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  pageAvailable(filter, offset) {
    if (!filter) return this.pageAvailablePlain(offset, PAGE_SIZE);
    return this.pageAvailableFiltered(filter, offset, PAGE_SIZE);
  }

  pageSelected(filter, offset) {
    const limit = PAGE_SIZE;
    if (!filter) {
      const slice = this.selectedOrder.slice(offset, offset + limit + 1);
      const hasMore = slice.length > limit;
      return {
        items: hasMore ? slice.slice(0, limit) : slice.slice(),
        hasMore,
        total: this.selectedOrder.length,
      };
    }
    const items = [];
    let matched = 0;
    const stopAt = offset + limit + 1;
    for (const id of this.selectedOrder) {
      if (!id.includes(filter)) continue;
      if (matched >= offset) items.push(id);
      matched += 1;
      if (matched >= stopAt) break;
    }
    const hasMore = items.length > limit;
    return {
      items: hasMore ? items.slice(0, limit) : items,
      hasMore,
      total: null,
    };
  }

  pageAvailablePlain(offset, limit) {
    const below = this.belowAvailable;
    const above = this.aboveAvailable;
    const baseCount = BASE_MAX - this.selectedBase.length;
    const belowEnd = below.length;
    const baseEnd = belowEnd + baseCount;
    const total = baseEnd + above.length;
    if (offset >= total) return { items: [], hasMore: false, total };

    const lastExclusive = Math.min(total, offset + limit + 1);
    const items = [];

    if (offset < belowEnd) {
      const to = Math.min(belowEnd, lastExclusive);
      for (let index = offset; index < to; index += 1) items.push(below[index]);
    }

    if (lastExclusive > belowEnd && offset < baseEnd) {
      const from = Math.max(offset, belowEnd);
      const to = Math.min(baseEnd, lastExclusive);
      for (let index = from; index < to; index += 1) {
        items.push(String(this.kthUnselectedBase(index - belowEnd)));
      }
    }

    if (lastExclusive > baseEnd) {
      const from = Math.max(offset, baseEnd);
      const to = Math.min(total, lastExclusive);
      for (let index = from; index < to; index += 1) items.push(above[index - baseEnd]);
    }

    const hasMore = items.length > limit;
    return {
      items: hasMore ? items.slice(0, limit) : items,
      hasMore,
      total,
    };
  }

  pageAvailableFiltered(filter, offset, limit) {
    const items = [];
    let matched = 0;
    const stopAt = offset + limit + 1;
    let stop = false;

    const take = (id) => {
      if (!id.includes(filter)) return false;
      if (matched >= offset) items.push(id);
      matched += 1;
      return matched >= stopAt;
    };

    for (const id of this.below) {
      if (this.selectedSet.has(id)) continue;
      if (take(id)) {
        stop = true;
        break;
      }
    }

    // Базовые ID — только цифры без знака, длина не больше 7.
    if (!stop && /^\d+$/.test(filter) && filter.length <= 7) {
      for (let n = 1; n <= BASE_MAX; n += 1) {
        if (this.selectedBaseSet.has(n)) continue;
        if (take(String(n))) {
          stop = true;
          break;
        }
      }
    }

    if (!stop) {
      for (const id of this.above) {
        if (this.selectedSet.has(id)) continue;
        if (take(id)) break;
      }
    }

    const hasMore = items.length > limit;
    return {
      items: hasMore ? items.slice(0, limit) : items,
      hasMore,
      total: null,
    };
  }
}
