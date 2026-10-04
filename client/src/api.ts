export type Side = 'available' | 'selected';

export type ListResponse = {
  items: string[];
  hasMore: boolean;
  total: number | null;
  version: number;
  availableCount: number;
  selectedCount: number;
};

export type MutationResponse = {
  ok: boolean;
  error?: string;
  id?: string;
  version?: number;
  availableCount?: number;
  selectedCount?: number;
  already?: boolean;
};

export type MetaResponse = {
  availableCount: number;
  selectedCount: number;
  extraCount: number;
  version: number;
  queues: { reads: number; writes: number; adds: number };
  batch: {
    dataMs: number;
    addMs: number;
    nextDataInMs: number;
    nextAddInMs: number;
  };
};

async function readBody<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : 'http';
    return { ...(data ?? {}), ok: false, error } as T;
  }
  return data as T;
}

export function fetchList(side: Side, filter: string, offset: number) {
  const params = new URLSearchParams({ side, offset: String(offset) });
  if (filter) params.set('filter', filter);
  return fetch(`/api/items?${params}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  }).then((response) => readBody<ListResponse>(response));
}

export function fetchMeta() {
  return fetch('/api/meta', {
    cache: 'no-store',
    signal: AbortSignal.timeout(4000),
  }).then((response) => readBody<MetaResponse>(response));
}

function post<T>(url: string, body: unknown, timeoutMs: number) {
  return fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then((response) => readBody<T>(response));
}

export function addItem(id: string) {
  return post<MutationResponse>('/api/items', { id }, 20000);
}

export function selectItem(id: string) {
  return post<MutationResponse>('/api/selection', { id }, 8000);
}

export function deselectItem(id: string) {
  return post<MutationResponse>('/api/selection/remove', { id }, 8000);
}

export function reorderItems(ids: string[]) {
  return post<MutationResponse>('/api/selection/reorder', { ids }, 8000);
}

export function errorText(code?: string) {
  switch (code) {
    case 'exists':
      return 'Такой ID уже есть в реестре';
    case 'invalid':
      return 'ID должен быть целым числом';
    case 'missing':
      return 'Элемент не найден';
    case 'invalid_order':
      return 'Не удалось сохранить порядок';
    case 'overloaded':
      return 'Очередь переполнена, повторите запрос';
    default:
      return 'Запрос не выполнился';
  }
}

export function formatCount(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value);
}
