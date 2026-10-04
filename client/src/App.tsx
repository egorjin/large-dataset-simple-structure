import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import {
  addItem,
  deselectItem,
  errorText,
  fetchMeta,
  formatCount,
  reorderItems,
  selectItem,
  type ListResponse,
  type MetaResponse,
  type Side,
} from './api';
import { usePagedList } from './usePagedList';

function secondsLeft(ms: number) {
  return Math.max(0, Math.ceil(ms / 1000));
}

export function App() {
  const [leftQuery, setLeftQuery] = useState('');
  const [rightQuery, setRightQuery] = useState('');
  const [leftFilter, setLeftFilter] = useState('');
  const [rightFilter, setRightFilter] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [stats, setStats] = useState({ availableCount: 1_000_000, selectedCount: 0 });
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [draftId, setDraftId] = useState('');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<'ok' | 'error'>('ok');
  const busyRef = useRef(0);
  const dirtyRef = useRef(false);
  const [busy, setBusy] = useState(0);
  const readySides = useRef(new Set<Side>());

  useEffect(() => {
    const timer = setTimeout(() => setLeftFilter(leftQuery.trim()), 250);
    return () => clearTimeout(timer);
  }, [leftQuery]);

  useEffect(() => {
    const timer = setTimeout(() => setRightFilter(rightQuery.trim()), 250);
    return () => clearTimeout(timer);
  }, [rightQuery]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetchMeta()
        .then((next) => {
          if (!cancelled) setMeta(next);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    readySides.current.clear();
  }, [leftFilter, rightFilter, reloadToken]);

  function rememberPage(side: Side, page: ListResponse, offset: number) {
    setStats({
      availableCount: page.availableCount,
      selectedCount: page.selectedCount,
    });
    if (offset !== 0) return;
    readySides.current.add(side);
    if (readySides.current.has('available') && readySides.current.has('selected')) {
      readySides.current.clear();
      setPendingIds(new Set());
    }
  }

  function begin(id?: string) {
    busyRef.current += 1;
    setBusy(busyRef.current);
    if (!id) return;
    setPendingIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  function finish(reload: boolean) {
    if (reload) dirtyRef.current = true;
    busyRef.current = Math.max(0, busyRef.current - 1);
    setBusy(busyRef.current);
    if (busyRef.current === 0 && dirtyRef.current) {
      dirtyRef.current = false;
      setReloadToken((token) => token + 1);
    }
  }

  async function onSelect(id: string) {
    begin(id);
    try {
      const result = await selectItem(id);
      if (!result.ok) {
        setNoticeTone('error');
        setNotice(errorText(result.error));
      }
      finish(true);
    } catch {
      setNoticeTone('error');
      setNotice('Не удалось выбрать элемент');
      finish(true);
    }
  }

  async function onDeselect(id: string) {
    begin(id);
    try {
      const result = await deselectItem(id);
      if (!result.ok) {
        setNoticeTone('error');
        setNotice(errorText(result.error));
      }
      finish(true);
    } catch {
      setNoticeTone('error');
      setNotice('Не удалось вернуть элемент');
      finish(true);
    }
  }

  async function onReorder(nextIds: string[], rollback: () => void) {
    begin();
    try {
      const result = await reorderItems(nextIds);
      if (!result.ok) {
        rollback();
        setNoticeTone('error');
        setNotice(errorText(result.error));
        finish(true);
        return;
      }
      if (typeof result.selectedCount === 'number' && typeof result.availableCount === 'number') {
        setStats({
          availableCount: result.availableCount,
          selectedCount: result.selectedCount,
        });
      }
      finish(false);
    } catch {
      rollback();
      setNoticeTone('error');
      setNotice('Не удалось сохранить порядок');
      finish(true);
    }
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    const id = draftId.trim();
    if (!id) {
      setNoticeTone('error');
      setNotice('Введите ID');
      return;
    }
    setAdding(true);
    setNoticeTone('ok');
    setNotice('ID в очереди добавления. Пакет применяется раз в 10 секунд.');
    try {
      const result = await addItem(id);
      if (!result.ok) {
        setNoticeTone('error');
        setNotice(errorText(result.error));
        return;
      }
      setDraftId('');
      setNoticeTone('ok');
      setNotice(`ID ${result.id} добавлен`);
      setReloadToken((token) => token + 1);
    } catch {
      setNoticeTone('error');
      setNotice('Не удалось добавить ID. Если пакет уже ушёл, обновите список.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Общий реестр в памяти сервера</p>
          <h1>Миллион идентификаторов</h1>
        </div>
        <dl className="totals">
          <div>
            <dt>Доступно</dt>
            <dd>{formatCount(stats.availableCount)}</dd>
          </div>
          <div>
            <dt>Выбрано</dt>
            <dd>{formatCount(stats.selectedCount)}</dd>
          </div>
        </dl>
      </header>

      <div className="batch-bar" aria-live="polite">
        <span>
          Чтение и изменение — пакет раз в 1 с
          {meta ? `, через ${secondsLeft(meta.batch.nextDataInMs)} с` : ''}
        </span>
        <span>
          Добавление — пакет раз в 10 с
          {meta ? `, через ${secondsLeft(meta.batch.nextAddInMs)} с` : ''}
        </span>
        <span>
          В очереди: чтение {meta?.queues.reads ?? 0}, изменение {meta?.queues.writes ?? 0},
          добавление {meta?.queues.adds ?? 0}
        </span>
      </div>

      {notice ? <p className={`notice notice-${noticeTone}`}>{notice}</p> : null}

      <main className="workspace">
        <Panel
          title="Доступные"
          tone="available"
          hint="Все ID, которые ещё не выбраны. Новые попадают сюда."
          query={leftQuery}
          onQuery={setLeftQuery}
          extra={(
            <form className="add-form" onSubmit={onAdd}>
              <label>
                <span>Новый ID</span>
                <input
                  value={draftId}
                  onChange={(event) => setDraftId(event.target.value)}
                  placeholder="Например, 1000001 или -4"
                  autoComplete="off"
                  disabled={adding}
                />
              </label>
              <button type="submit" disabled={adding}>
                {adding ? 'В очереди…' : 'Добавить'}
              </button>
            </form>
          )}
          side="available"
          filter={leftFilter}
          reloadToken={reloadToken}
          paused={busy > 0}
          pendingIds={pendingIds}
          onPage={(page, offset) => rememberPage('available', page, offset)}
          onRetry={() => setReloadToken((token) => token + 1)}
          onAction={onSelect}
          actionLabel="Выбрать"
        />
        <SelectedPanel
          query={rightQuery}
          onQuery={setRightQuery}
          filter={rightFilter}
          reloadToken={reloadToken}
          paused={busy > 0}
          pendingIds={pendingIds}
          onPage={(page, offset) => rememberPage('selected', page, offset)}
          onRetry={() => setReloadToken((token) => token + 1)}
          onDeselect={onDeselect}
          onReorder={onReorder}
          locked={busy > 0}
        />
      </main>
    </div>
  );
}

function Panel({
  title,
  tone,
  hint,
  query,
  onQuery,
  extra,
  side,
  filter,
  reloadToken,
  paused,
  pendingIds,
  onPage,
  onRetry,
  onAction,
  actionLabel,
}: {
  title: string;
  tone: Side;
  hint: string;
  query: string;
  onQuery: (value: string) => void;
  extra?: ReactNode;
  side: Side;
  filter: string;
  reloadToken: number;
  paused: boolean;
  pendingIds: Set<string>;
  onPage: (page: ListResponse, offset: number) => void;
  onRetry: () => void;
  onAction: (id: string) => void;
  actionLabel: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const list = usePagedList({ side, filter, reloadToken, paused, onPage });

  useScrollReset(scrollRef, filter, reloadToken);
  useInfiniteScroll(scrollRef, sentinelRef, list.loadMore, list.items.length, list.loading, list.hasMore);

  return (
    <section className={`panel panel-${tone}`} aria-labelledby={`${tone}-title`}>
      <div className="panel-head">
        <div>
          <h2 id={`${tone}-title`}>{title}</h2>
          <p>{hint}</p>
        </div>
        <label className="filter">
          <span>Фильтр по ID</span>
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Содержит…"
            autoComplete="off"
          />
        </label>
      </div>
      {extra}
      <div className="list-scroll" ref={scrollRef}>
        {list.items.length === 0 && !list.loading ? (
          <p className="empty">{list.error ? list.error : 'Ничего не найдено'}</p>
        ) : (
          <ul className="rows">
            {list.items.map((id) => {
              const pending = pendingIds.has(id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={pending ? 'row is-pending' : 'row'}
                    onClick={() => onAction(id)}
                    disabled={pending}
                  >
                    <span className="mono">{id}</span>
                    <span className="action">{pending ? 'В очереди' : actionLabel}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={sentinelRef} className="sentinel" />
        {list.loading ? <p className="status">Порция в пакете чтения, до 1 с…</p> : null}
        {list.error && list.items.length > 0 ? (
          <button type="button" className="retry" onClick={onRetry}>{list.error}. Повторить</button>
        ) : null}
        {!list.loading && !list.hasMore && list.items.length > 0 ? (
          <p className="status">Больше нет элементов</p>
        ) : null}
      </div>
    </section>
  );
}

function SelectedPanel({
  query,
  onQuery,
  filter,
  reloadToken,
  paused,
  pendingIds,
  onPage,
  onRetry,
  onDeselect,
  onReorder,
  locked,
}: {
  query: string;
  onQuery: (value: string) => void;
  filter: string;
  reloadToken: number;
  paused: boolean;
  pendingIds: Set<string>;
  onPage: (page: ListResponse, offset: number) => void;
  onRetry: () => void;
  onDeselect: (id: string) => void;
  onReorder: (ids: string[], rollback: () => void) => void;
  locked: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const list = usePagedList({
    side: 'selected',
    filter,
    reloadToken,
    paused,
    onPage,
  });
  const itemsRef = useRef(list.items);
  itemsRef.current = list.items;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useScrollReset(scrollRef, filter, reloadToken);
  useInfiniteScroll(scrollRef, sentinelRef, list.loadMore, list.items.length, list.loading, list.hasMore);

  function onDragEnd(event: DragEndEvent) {
    if (locked) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const current = itemsRef.current;
    const oldIndex = current.indexOf(String(active.id));
    const newIndex = current.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const previous = current;
    const next = arrayMove(current, oldIndex, newIndex);
    list.setItems(next);
    onReorder(next, () => list.setItems(previous));
  }

  return (
    <section className="panel panel-selected" aria-labelledby="selected-title">
      <div className="panel-head">
        <div>
          <h2 id="selected-title">Выбранные</h2>
          <p>Порядок сохраняется на сервере и остаётся после обновления страницы.</p>
        </div>
        <label className="filter">
          <span>Фильтр по ID</span>
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Содержит…"
            autoComplete="off"
          />
        </label>
      </div>
      {filter ? (
        <p className="filter-note">
          Перетаскивание меняет порядок среди загруженных строк. Скрытые фильтром элементы остаются на своих местах.
        </p>
      ) : null}
      <div className="list-scroll" ref={scrollRef}>
        {list.items.length === 0 && !list.loading ? (
          <p className="empty">{list.error ? list.error : 'Пока ничего не выбрано'}</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={list.items} strategy={verticalListSortingStrategy}>
              <ul className="rows">
                {list.items.map((id) => (
                  <SortableRow
                    key={id}
                    id={id}
                    pending={pendingIds.has(id)}
                    locked={locked}
                    onRemove={onDeselect}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        <div ref={sentinelRef} className="sentinel" />
        {list.loading ? <p className="status">Порция в пакете чтения, до 1 с…</p> : null}
        {list.error && list.items.length > 0 ? (
          <button type="button" className="retry" onClick={onRetry}>{list.error}. Повторить</button>
        ) : null}
        {!list.loading && !list.hasMore && list.items.length > 0 ? (
          <p className="status">Больше нет элементов</p>
        ) : null}
      </div>
    </section>
  );
}

function SortableRow({
  id,
  pending,
  locked,
  onRemove,
}: {
  id: string;
  pending: boolean;
  locked: boolean;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: locked || pending,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li ref={setNodeRef} style={style} className={isDragging ? 'is-dragging' : undefined}>
      <div className={pending ? 'row is-pending' : 'row'}>
        <button
          type="button"
          className="handle"
          aria-label={`Перетащить ${id}`}
          disabled={locked || pending}
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true" />
        </button>
        <span className="mono">{id}</span>
        <button type="button" className="action" onClick={() => onRemove(id)} disabled={pending || locked}>
          {pending ? 'В очереди' : 'Вернуть'}
        </button>
      </div>
    </li>
  );
}

function useScrollReset(scrollRef: RefObject<HTMLDivElement | null>, filter: string, reloadToken: number) {
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [scrollRef, filter, reloadToken]);
}

function useInfiniteScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  sentinelRef: RefObject<HTMLDivElement | null>,
  loadMore: () => void,
  itemCount: number,
  loading: boolean,
  hasMore: boolean,
) {
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: '160px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollRef, sentinelRef, loadMore, itemCount, loading, hasMore]);
}
