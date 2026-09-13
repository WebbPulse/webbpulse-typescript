/**
 * The state machine every identity settings panel runs: load a collection,
 * mutate one row, report what the server said, reload. Headless, so a product
 * keeps its own markup, copy and layout and only the transitions are shared.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * What a panel is showing. `items` is null until the first load settles, which
 * a skeleton gates on, and stays at its last value across a reload so a list
 * does not blink empty between a mutation and its refresh.
 */
export interface PanelState<T> {
  /** The rows, or null while the first load is outstanding. */
  items: T[] | null;
  /** True until the first load settles. Gate a skeleton on this. */
  loading: boolean;
  /** True while any call is in flight, the first load included. */
  busy: boolean;
  /** The server's own sentence for the last refusal, or null. */
  error: string | null;
  /** The sentence for the last success, or null. */
  notice: string | null;
  /**
   * Whether a mutation has landed since the panel mounted, so a caller can
   * prompt about unsaved context or re-read a dependent panel.
   */
  dirty: boolean;
  /**
   * Whether the deployment cannot offer this capability at all. A panel hides
   * itself on this rather than rendering a failure.
   */
  unavailable: boolean;
}

/** A collection panel with the four calls every one of them makes. */
export interface ListPanel<T, TDraft> extends PanelState<T> {
  /** Re-reads the collection. Never throws; a refusal lands in `error`. */
  reload: () => Promise<void>;
  /** Adds a row from `draft`, then reloads. */
  create: (draft: TDraft) => Promise<void>;
  /** Relabels one row, then reloads. */
  rename: (id: string, name: string) => Promise<void>;
  /** Removes one row, then reloads. */
  remove: (id: string) => Promise<void>;
  /** Clears `error` and `notice`. For a dismissable banner. */
  dismiss: () => void;
  /**
   * Marks a call started: sets `busy` and clears both banners. For a call the
   * panel does not model, such as one that ends in a navigation.
   */
  beginCall: () => void;
  /**
   * Marks a call finished. Deliberately not called by an operation that
   * navigates away, so the controls stay disabled until the page goes.
   */
  endCall: () => void;
  /** Records a refusal, with the server's own sentence. */
  fail: (message: string, unavailable?: boolean) => void;
}

/**
 * What one call resolved to, in the shape the hooks reduce every outcome to.
 * `ok` false with a null `message` is a cancellation, which leaves the panel
 * untouched because the user has already seen the browser's own dismissal.
 */
export interface PanelOutcome {
  ok: boolean;
  /** The server's sentence, or null when there is nothing to show. */
  message: string | null;
  /** Whether the refusal means the deployment cannot do this at all. */
  unavailable?: boolean;
  /**
   * Whether the refusal means the row is already gone, which reloads the
   * collection so the panel stops showing something the server does not have.
   * The reload keeps the refusal's message on screen, so the row vanishing is
   * explained rather than silent.
   */
  stale?: boolean;
}

/** A success that carries no server sentence of its own. */
export const PANEL_OK: PanelOutcome = { ok: true, message: null };

/**
 * A cancellation: not a success and not something to report. Returned by an
 * operation the user dismissed.
 */
export const PANEL_CANCELLED: PanelOutcome = { ok: false, message: null };

/** How {@link useListPanel} reads and mutates one collection. */
export interface ListPanelConfig<T, TDraft> {
  /** Reads the collection. */
  list: () => Promise<{ items: T[] | null; outcome: PanelOutcome }>;
  /** Adds a row. Omit to leave {@link ListPanel.create} a no-op. */
  create?: (draft: TDraft) => Promise<PanelOutcome>;
  /** Relabels a row. Omit to leave {@link ListPanel.rename} a no-op. */
  rename?: (id: string, name: string) => Promise<PanelOutcome>;
  /** Removes a row. Omit to leave {@link ListPanel.remove} a no-op. */
  remove?: (id: string) => Promise<PanelOutcome>;
  /** Whether to read the collection on mount. Defaults to true. */
  loadOnMount?: boolean;
  /** The sentence to show after each kind of success. */
  messages?: PanelMessages;
}

/**
 * The success copy a panel shows. Every field is optional and a missing one
 * shows no notice, since refusals carry the server's own sentence and only
 * successes need wording the product chooses.
 */
export interface PanelMessages {
  /** After {@link ListPanel.create}. */
  created?: string;
  /** After {@link ListPanel.rename}. */
  renamed?: string;
  /** After {@link ListPanel.remove}. */
  removed?: string;
}

/**
 * Runs the load-mutate-reload loop over one collection. The three identity
 * panels are built from it, and it is exported so a product can apply the same
 * shape to a collection this package does not model.
 *
 * A mutation sets `busy`, clears the banners, calls the server, records what it
 * said, and reloads on success. Concurrent calls are serialised by `busy` at
 * the call site rather than queued here, and a load that resolves after the
 * hook unmounts is dropped.
 *
 * @example
 * ```ts
 * const panel = useListPanel({
 *   list: async () => ({ items: await readTokens(), outcome: PANEL_OK }),
 *   remove: async (id) => ({ ok: await revokeToken(id), message: null }),
 *   messages: { removed: 'Token revoked.' },
 * });
 * ```
 */
export function useListPanel<T, TDraft>(
  config: ListPanelConfig<T, TDraft>
): ListPanel<T, TDraft> {
  const [items, setItems] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(config.loadOnMount !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const live = useRef(true);
  const latest = useRef(config);
  latest.current = config;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /**
   * Re-reads the collection. `keepError` leaves an error already on screen
   * alone, for the reload a stale refusal triggers: that reload is caused by
   * the refusal, so clearing the message would drop the only explanation the
   * user gets for the row disappearing.
   */
  const read = useCallback(async (keepError: boolean): Promise<void> => {
    setBusy(true);
    try {
      const { items: rows, outcome } = await latest.current.list();
      if (!live.current) {
        return;
      }
      if (outcome.ok) {
        setItems(rows ?? []);
        if (!keepError) {
          setError(null);
        }
        setUnavailable(false);
      } else {
        setError(outcome.message);
        setUnavailable(outcome.unavailable === true);
        if (outcome.unavailable === true) {
          setItems([]);
        }
      }
    } finally {
      if (live.current) {
        setBusy(false);
        setLoading(false);
      }
    }
  }, []);

  const reload = useCallback(() => read(false), [read]);

  const run = useCallback(
    async (
      call: (() => Promise<PanelOutcome>) | undefined,
      success: string | undefined
    ): Promise<void> => {
      if (call === undefined) {
        return;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      let outcome: PanelOutcome;
      try {
        outcome = await call();
      } finally {
        if (live.current) {
          setBusy(false);
        }
      }
      if (!live.current) {
        return;
      }
      if (outcome.ok) {
        setDirty(true);
        setNotice(outcome.message ?? success ?? null);
        await read(false);
        return;
      }
      if (outcome.message !== null) {
        setError(outcome.message);
      }
      if (outcome.unavailable === true) {
        setUnavailable(true);
      }
      if (outcome.stale === true) {
        await read(true);
      }
    },
    [read]
  );

  const create = useCallback(
    (draft: TDraft) =>
      run(
        latest.current.create === undefined
          ? undefined
          : () => latest.current.create?.(draft) ?? Promise.resolve(PANEL_OK),
        latest.current.messages?.created
      ),
    [run]
  );

  const rename = useCallback(
    (id: string, name: string) =>
      run(
        latest.current.rename === undefined
          ? undefined
          : () =>
              latest.current.rename?.(id, name) ?? Promise.resolve(PANEL_OK),
        latest.current.messages?.renamed
      ),
    [run]
  );

  const remove = useCallback(
    (id: string) =>
      run(
        latest.current.remove === undefined
          ? undefined
          : () => latest.current.remove?.(id) ?? Promise.resolve(PANEL_OK),
        latest.current.messages?.removed
      ),
    [run]
  );

  const dismiss = useCallback((): void => {
    setError(null);
    setNotice(null);
  }, []);

  const beginCall = useCallback((): void => {
    setBusy(true);
    setError(null);
    setNotice(null);
  }, []);

  const endCall = useCallback((): void => {
    if (live.current) {
      setBusy(false);
    }
  }, []);

  const fail = useCallback((message: string, gone = false): void => {
    if (!live.current) {
      return;
    }
    setError(message);
    if (gone) {
      setUnavailable(true);
    }
  }, []);

  const loadOnMount = config.loadOnMount !== false;
  const started = useRef(false);

  useEffect(() => {
    if (!loadOnMount || started.current) {
      return;
    }
    started.current = true;
    void reload();
  }, [loadOnMount, reload]);

  return useMemo(
    () => ({
      items,
      loading,
      busy,
      error,
      notice,
      dirty,
      unavailable,
      reload,
      create,
      rename,
      remove,
      dismiss,
      beginCall,
      endCall,
      fail,
    }),
    [
      items,
      loading,
      busy,
      error,
      notice,
      dirty,
      unavailable,
      reload,
      create,
      rename,
      remove,
      dismiss,
      beginCall,
      endCall,
      fail,
    ]
  );
}
