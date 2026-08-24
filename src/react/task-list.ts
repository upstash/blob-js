import { useCallback, useRef, useSyncExternalStore } from 'react';

export interface ListRecord {
  id: string;
  status: string;
}

/** What the store needs of a task. Neither task implementation imports React. */
export interface ListEntry<R extends ListRecord> {
  readonly id: string;
  subscribe(onChange: () => void): () => void;
  status(): string;
  record(): R;
  start(): void;
}

export interface ListOptions<R extends ListRecord> {
  /** Files in flight. */
  concurrency?: number;
  onDone?: (record: R) => void;
  onError?: (record: R) => void;
}

export interface TaskList<R extends ListRecord> {
  uploads: R[];
  task: R | null;
  add(entries: ListEntry<R>[]): R[];
  clear(id?: string): void;
}

const TERMINAL = new Set(['done', 'error', 'canceled']);
const DEFAULT_CONCURRENCY = 3;

interface Slot<R extends ListRecord> {
  entry: ListEntry<R>;
  unsubscribe: () => void;
  started: boolean;
  settled: boolean;
  listed: boolean;
}

class ListStore<R extends ListRecord> {
  options: ListOptions<R> = {};

  private slots: Slot<R>[] = [];
  /** Cleared while still running: they keep their place in the queue and finish. */
  private detached: Slot<R>[] = [];
  private running = new Set<Slot<R>>();
  private cache: R[] | undefined;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): R[] => (this.cache ??= this.slots.map((s) => s.entry.record()));

  add(entries: ListEntry<R>[]): R[] {
    const added = entries.map((entry) => {
      const slot: Slot<R> = { entry, unsubscribe: () => {}, started: false, settled: false, listed: true };
      slot.unsubscribe = entry.subscribe(this.onChange);
      this.slots.push(slot);
      return slot;
    });
    this.cache = undefined;
    this.settle();
    this.emit();
    const ids = new Set(added.map((s) => s.entry.id));
    return this.getSnapshot().filter((r) => ids.has(r.id));
  }

  clear(id?: string): void {
    const keep: Slot<R>[] = [];
    for (const slot of this.slots) {
      if (id !== undefined && slot.entry.id !== id) {
        keep.push(slot);
        continue;
      }
      slot.listed = false;
      if (slot.settled || !slot.started) slot.unsubscribe();
      else this.detached.push(slot);
    }
    this.slots = keep;
    this.cache = undefined;
    this.pump();
    this.emit();
  }

  private onChange = (): void => {
    this.cache = undefined;
    this.settle();
    this.emit();
  };

  private settle(): void {
    for (const slot of [...this.slots, ...this.detached]) {
      if (!TERMINAL.has(slot.entry.status())) {
        // retry() takes a task back out of 'error', and a slot left settled would never fire
        // onDone/onError again nor count against the concurrency limit.
        if (slot.settled) {
          slot.settled = false;
          this.running.add(slot);
        }
        continue;
      }
      if (slot.settled) continue;
      slot.settled = true;
      this.running.delete(slot);
      if (!slot.listed) {
        slot.unsubscribe();
        this.detached = this.detached.filter((s) => s !== slot);
      }
      const status = slot.entry.status();
      const fire = status === 'done' ? this.options.onDone : status === 'error' ? this.options.onError : undefined;
      fire?.(slot.entry.record());
    }
    this.pump();
  }

  private pump(): void {
    const limit = this.options.concurrency ?? DEFAULT_CONCURRENCY;
    for (const slot of this.slots) {
      if (this.running.size >= limit) return;
      // A task canceled while queued is only marked settled on its next notify, and onDone/onError
      // can clear() inside that window: starting it there reports the cancel as an error instead.
      if (slot.started || slot.settled || TERMINAL.has(slot.entry.status())) continue;
      slot.started = true;
      this.running.add(slot);
      slot.entry.start();
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The list, the queue and the render records, shared by useUpload and useUploadProxy. */
export function useTaskList<R extends ListRecord>(options: ListOptions<R>): TaskList<R> {
  const ref = useRef<ListStore<R> | undefined>(undefined);
  const store = (ref.current ??= new ListStore<R>());
  // Read when a task settles, so a callback defined inline is never a render behind.
  store.options = options;

  const uploads = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const add = useCallback((entries: ListEntry<R>[]) => store.add(entries), [store]);
  const clear = useCallback((id?: string) => store.clear(id), [store]);

  return { uploads, task: uploads.at(-1) ?? null, add, clear };
}
