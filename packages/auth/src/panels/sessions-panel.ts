/**
 * The active sessions panel's state machine: the signed-in user's live
 * sessions with the calling one marked, ending one of the others, and ending
 * every other one at once. The calling session is ended by `logout`, so the
 * panel splits it out as `current` rather than offering it to `revoke`.
 */

import { useCallback, useMemo } from 'react';

import type { AccountSession, SessionRevokeOutcome } from '../account.js';
import type { AuthClient } from '../auth-client.js';
import {
  PANEL_OK,
  useListPanel,
  type ListPanel,
  type PanelOutcome,
} from './list-panel.js';

/** The sentence a call that never reached an answer shows by default. */
const DEFAULT_FAILED =
  'Could not reach the server. Check your connection and try again.';

/** The copy the sessions panel shows. A missing success shows no notice. */
export interface SessionsPanelMessages {
  /** After one session is ended. */
  removed?: string;
  /** After every other session is ended. Receives how many ended. */
  revokedOthers?: string | ((count: number) => string);
  /**
   * When a call throws rather than answering, such as a dropped connection.
   * Refusals the server answers still carry its own sentence.
   */
  failed?: string;
}

/** Options for {@link useSessionsPanel}. */
export interface SessionsPanelOptions {
  /** The client to call. */
  client: AuthClient<unknown>;
  /** Whether to read the list on mount. Defaults to true. */
  loadOnMount?: boolean;
  /** The copy. Refusals always use the server's own sentence. */
  messages?: SessionsPanelMessages;
}

/** What {@link useSessionsPanel} returns. */
export interface SessionsPanel extends ListPanel<AccountSession, never> {
  /** The session making the calls, or null before the first load. */
  current: AccountSession | null;
  /** Every other live session, in the server's most-recent-first order. */
  others: AccountSession[];
  /**
   * Ends one of the other sessions, then reloads. A session already gone
   * counts as ended, since that is what the user asked for.
   */
  revoke: (id: string) => Promise<void>;
  /**
   * Ends every session except the current one in one call, then reloads. The
   * current session keeps its token and cookie.
   */
  revokeOthers: () => Promise<void>;
}

/** Reduces a single revoke outcome to the panel's shape. */
function settle(outcome: SessionRevokeOutcome): PanelOutcome {
  if (outcome.ok || outcome.reason === 'not-found') {
    return PANEL_OK;
  }
  return { ok: false, message: outcome.message };
}

/**
 * The active sessions panel, headless. Renders nothing: a product destructures
 * this and keeps its own markup, copy, confirmation and layout.
 *
 * @example
 * ```tsx
 * const panel = useSessionsPanel({
 *   client,
 *   messages: {
 *     removed: 'Session ended.',
 *     revokedOthers: (count) => `${count} other sessions ended.`,
 *   },
 * });
 * return panel.others.map((session) => (
 *   <Row key={session.id} session={session} onEnd={() => void panel.revoke(session.id)} />
 * ));
 * ```
 */
export function useSessionsPanel(options: SessionsPanelOptions): SessionsPanel {
  const { client } = options;
  const failed = options.messages?.failed ?? DEFAULT_FAILED;

  const list = useCallback(async (): Promise<{
    items: AccountSession[] | null;
    outcome: PanelOutcome;
  }> => {
    try {
      const outcome = await client.listSessions();
      return { items: outcome.sessions, outcome: PANEL_OK };
    } catch {
      return { items: null, outcome: { ok: false, message: failed } };
    }
  }, [client, failed]);

  const remove = useCallback(
    async (id: string): Promise<PanelOutcome> => {
      try {
        return settle(await client.revokeSession(id));
      } catch {
        return { ok: false, message: failed };
      }
    },
    [client, failed]
  );

  const removedMessage = options.messages?.removed;
  const notices = useMemo(
    () => (removedMessage === undefined ? {} : { removed: removedMessage }),
    [removedMessage]
  );

  const panel = useListPanel<AccountSession, never>({
    list,
    remove,
    ...(options.loadOnMount === undefined
      ? {}
      : { loadOnMount: options.loadOnMount }),
    messages: notices,
  });

  const { remove: runRemove, mutate, items } = panel;

  const revoke = useCallback((id: string) => runRemove(id), [runRemove]);

  const othersMessage = options.messages?.revokedOthers;

  const revokeOthers = useCallback(
    () =>
      mutate(async (): Promise<PanelOutcome> => {
        try {
          const { revoked } = await client.revokeOtherSessions();
          return {
            ok: true,
            message:
              typeof othersMessage === 'function'
                ? othersMessage(revoked)
                : (othersMessage ?? null),
          };
        } catch {
          return { ok: false, message: failed };
        }
      }),
    [client, mutate, othersMessage, failed]
  );

  const current = useMemo(
    () => (items ?? []).find((session) => session.current) ?? null,
    [items]
  );

  const others = useMemo(
    () => (items ?? []).filter((session) => !session.current),
    [items]
  );

  return useMemo(
    () => ({ ...panel, current, others, revoke, revokeOthers }),
    [panel, current, others, revoke, revokeOthers]
  );
}
