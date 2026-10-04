import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchList, type ListResponse, type Side } from './api';

type Options = {
  side: Side;
  filter: string;
  reloadToken: number;
  paused: boolean;
  onPage: (page: ListResponse, offset: number) => void;
};

export function usePagedList({ side, filter, reloadToken, paused, onPage }: Options) {
  const [items, setItemsState] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const itemsCount = useRef(0);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  const pausedRef = useRef(paused);
  const onPageRef = useRef(onPage);
  pausedRef.current = paused;
  onPageRef.current = onPage;

  const setItems = useCallback((next: string[]) => {
    itemsCount.current = next.length;
    setItemsState(next);
  }, []);

  useEffect(() => {
    const gen = generation.current + 1;
    generation.current = gen;
    itemsCount.current = 0;
    hasMoreRef.current = true;
    loadingRef.current = true;
    setItemsState([]);
    setHasMore(true);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const page = await fetchList(side, filter, 0);
        if (generation.current !== gen) return;
        itemsCount.current = page.items.length;
        setItemsState(page.items);
        hasMoreRef.current = page.hasMore;
        setHasMore(page.hasMore);
        onPageRef.current(page, 0);
      } catch {
        if (generation.current === gen) setError('Не удалось загрузить порцию');
      } finally {
        if (generation.current === gen) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    })();
  }, [side, filter, reloadToken]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || pausedRef.current || !hasMoreRef.current) return;
    const gen = generation.current;
    const offset = itemsCount.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = await fetchList(side, filter, offset);
        if (generation.current !== gen) return;
        setItemsState((prev) => {
          const seen = new Set(prev);
          const merged = prev.slice();
          for (const id of page.items) {
            if (!seen.has(id)) merged.push(id);
          }
          itemsCount.current = merged.length;
          return merged;
        });
        hasMoreRef.current = page.hasMore;
        setHasMore(page.hasMore);
        onPageRef.current(page, offset);
      } catch {
        if (generation.current === gen) setError('Не удалось загрузить следующую порцию');
      } finally {
        if (generation.current === gen) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    })();
  }, [side, filter]);

  return { items, setItems, hasMore, loading, error, loadMore };
}
