/**
 * The passkey settings panel's state machine. Both products hold the same
 * fields around `AuthClient`'s four passkey calls: the list, an unavailable
 * flag, busy, error, a notice, the add form's draft name, and the row being
 * renamed with a draft of its own.
 */

import { useCallback, useMemo, useState } from 'react';

import type { AuthClient } from '../auth-client.js';
import {
  passkeysSupported,
  type Passkey,
  type PasskeyDeleteOutcome,
  type PasskeyListOutcome,
  type PasskeyRegistrationOutcome,
  type PasskeyRenameOutcome,
} from '../passkeys.js';
import {
  PANEL_CANCELLED,
  PANEL_OK,
  useListPanel,
  type ListPanel,
  type PanelOutcome,
} from './list-panel.js';

/** The success copy the passkey panel shows. A missing one shows no notice. */
export interface PasskeyPanelMessages {
  /** After an enrolment. Receives the name the server settled on. */
  created?: string | ((passkey: Passkey) => string);
  /** After a rename. */
  renamed?: string;
  /** After a delete. */
  removed?: string;
}

/** Options for {@link usePasskeyPanel}. */
export interface PasskeyPanelOptions {
  /**
   * The client to call. Explicit rather than read from context, since both
   * products build their identity client outside the provider tree.
   */
  client: AuthClient<unknown>;
  /** Whether to read the list on mount. Defaults to true. */
  loadOnMount?: boolean;
  /** The success copy. Refusals always use the server's own sentence. */
  messages?: PasskeyPanelMessages;
}

/**
 * What {@link usePasskeyPanel} returns: the collection loop plus the two drafts
 * both products keep beside it.
 */
export interface PasskeyPanel extends ListPanel<Passkey, string> {
  /**
   * Whether this browser can run a WebAuthn ceremony. False hides the add
   * control while leaving the list readable, since a passkey enrolled elsewhere
   * still signs in on another browser and is still worth deleting here.
   */
  supported: boolean;
  /** Whether the add form is open. */
  adding: boolean;
  /** The draft name for the credential being enrolled. */
  draftName: string;
  /** Opens the add form with an empty draft. */
  startCreate: () => void;
  /** Closes the add form, discarding the draft. */
  cancelCreate: () => void;
  /** Replaces the add form's draft name. */
  setDraftName: (name: string) => void;
  /** Enrols with the current draft name, closing the form on success. */
  commitCreate: () => Promise<void>;
  /** The credential id currently being renamed, or null. */
  renaming: string | null;
  /** The draft name for {@link PasskeyPanel.renaming}. */
  draftRename: string;
  /** Opens the rename form on one row, seeding the draft with its name. */
  startRename: (passkey: Passkey) => void;
  /** Closes the rename form, discarding the draft. */
  cancelRename: () => void;
  /** Replaces the rename draft. */
  setDraftRename: (name: string) => void;
  /** Commits the open rename, closing the form on success. */
  commitRename: () => Promise<void>;
}

/**
 * Reduces a passkey outcome to the panel's shape. A cancellation reports
 * nothing, since the browser has already told the user, and `unavailable` is
 * the deployment switching the capability off rather than a failure to show.
 */
function settle(
  outcome:
    PasskeyRegistrationOutcome | PasskeyRenameOutcome | PasskeyDeleteOutcome
): PanelOutcome {
  if (outcome.ok) {
    return PANEL_OK;
  }
  if (outcome.reason === 'cancelled') {
    return PANEL_CANCELLED;
  }
  return {
    ok: false,
    message: outcome.message,
    unavailable: outcome.reason === 'unavailable',
    stale: outcome.reason === 'not-found',
  };
}

/**
 * The passkey settings panel, headless. Renders nothing: a product destructures
 * this and keeps its own markup, copy and layout.
 *
 * `create` takes the label for the new credential and runs both ceremony legs,
 * so a dismissed browser prompt leaves the panel untouched rather than showing
 * an error. A delete refused with `last-credential` surfaces the server's
 * sentence, which names setting a password as the remedy.
 *
 * @example
 * ```tsx
 * const panel = usePasskeyPanel({
 *   client,
 *   messages: { created: (key) => `Passkey "${key.name}" added.` },
 * });
 * if (panel.unavailable) return <p>Passkeys are off in this deployment.</p>;
 * ```
 */
export function usePasskeyPanel(options: PasskeyPanelOptions): PasskeyPanel {
  const { client } = options;
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftRename, setDraftRename] = useState('');
  const [created, setCreated] = useState<Passkey | null>(null);

  const list = useCallback(async (): Promise<{
    items: Passkey[] | null;
    outcome: PanelOutcome;
  }> => {
    const outcome: PasskeyListOutcome = await client.listPasskeys();
    if (outcome.ok) {
      return { items: outcome.passkeys, outcome: PANEL_OK };
    }
    return {
      items: null,
      outcome: { ok: false, message: outcome.message, unavailable: true },
    };
  }, [client]);

  const create = useCallback(
    async (name: string): Promise<PanelOutcome> => {
      const trimmed = name.trim();
      const outcome = await client.registerPasskey(
        trimmed === '' ? {} : { name: trimmed }
      );
      setCreated(outcome.ok ? outcome.passkey : null);
      return settle(outcome);
    },
    [client]
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<PanelOutcome> =>
      settle(await client.renamePasskey(id, name.trim())),
    [client]
  );

  const remove = useCallback(
    async (id: string): Promise<PanelOutcome> =>
      settle(await client.deletePasskey(id)),
    [client]
  );

  const createdMessage = options.messages?.created;
  const notices = useMemo(
    () => ({
      ...(createdMessage === undefined || typeof createdMessage === 'function'
        ? {}
        : { created: createdMessage }),
      ...(options.messages?.renamed === undefined
        ? {}
        : { renamed: options.messages.renamed }),
      ...(options.messages?.removed === undefined
        ? {}
        : { removed: options.messages.removed }),
    }),
    [createdMessage, options.messages?.renamed, options.messages?.removed]
  );

  const panel = useListPanel<Passkey, string>({
    list,
    create,
    rename,
    remove,
    ...(options.loadOnMount === undefined
      ? {}
      : { loadOnMount: options.loadOnMount }),
    messages: notices,
  });

  const { create: runCreate, rename: runRename, notice } = panel;

  const startCreate = useCallback((): void => {
    setAdding(true);
    setDraftName('');
  }, []);

  const cancelCreate = useCallback((): void => {
    setAdding(false);
    setDraftName('');
  }, []);

  const commitCreate = useCallback(async (): Promise<void> => {
    await runCreate(draftName);
    setAdding(false);
    setDraftName('');
  }, [draftName, runCreate]);

  const startRename = useCallback((passkey: Passkey): void => {
    setRenaming(passkey.credentialId);
    setDraftRename(passkey.name);
  }, []);

  const cancelRename = useCallback((): void => {
    setRenaming(null);
    setDraftRename('');
  }, []);

  const commitRename = useCallback(async (): Promise<void> => {
    if (renaming === null) {
      return;
    }
    const target = renaming;
    await runRename(target, draftRename);
    setRenaming((current) => (current === target ? null : current));
    setDraftRename('');
  }, [renaming, draftRename, runRename]);

  const supported = useMemo(() => passkeysSupported(), []);

  const resolved =
    typeof createdMessage === 'function' && created !== null && notice === null
      ? createdMessage(created)
      : notice;

  return useMemo(
    () => ({
      ...panel,
      notice: resolved,
      supported,
      adding,
      draftName,
      startCreate,
      cancelCreate,
      setDraftName,
      commitCreate,
      renaming,
      draftRename,
      startRename,
      cancelRename,
      setDraftRename,
      commitRename,
    }),
    [
      panel,
      resolved,
      supported,
      adding,
      draftName,
      startCreate,
      cancelCreate,
      commitCreate,
      renaming,
      draftRename,
      startRename,
      cancelRename,
      commitRename,
    ]
  );
}
