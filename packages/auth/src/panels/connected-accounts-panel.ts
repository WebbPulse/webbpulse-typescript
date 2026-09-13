/**
 * The connected accounts panel's state machine: the links the account holds,
 * which providers are still attachable, and the attach and detach calls. The
 * attach leg navigates away, so it reports no notice of its own.
 */

import { useCallback, useMemo, useState } from 'react';

import type { AuthClient } from '../auth-client.js';
import type {
  OAuthLink,
  OAuthLinkOutcome,
  OAuthLinksOutcome,
  OAuthUnlinkOutcome,
} from '../oauth.js';
import {
  PANEL_OK,
  useListPanel,
  type ListPanel,
  type PanelOutcome,
} from './list-panel.js';

/**
 * One provider a deployment offers. Structural rather than imported from
 * `@webbpulse/discovery`, which depends on this package and cannot be depended
 * on back.
 */
export interface ProviderOption {
  /** The provider id, `google` or `github` in the baseline. */
  id: string;
  /** The name to show a user. */
  displayName: string;
}

/** The success copy the connected accounts panel shows. */
export interface ConnectedAccountsMessages {
  /** After a detach. Receives the provider id that was removed. */
  removed?: string | ((provider: string) => string);
}

/** Options for {@link useConnectedAccountsPanel}. */
export interface ConnectedAccountsOptions {
  /** The client to call. */
  client: AuthClient<unknown>;
  /**
   * Every provider the deployment offers, from `@webbpulse/discovery`. Used
   * only to work out what is still attachable; an empty list offers nothing.
   */
  providers?: readonly ProviderOption[];
  /** Where the provider should send the browser back to after the attach. */
  returnTo?: string;
  /**
   * Sends the browser to the authorization URL. Defaults to
   * `location.assign`, and is injected so a test can observe the navigation.
   */
  navigate?: (url: string) => void;
  /** Whether to read the links on mount. Defaults to true. */
  loadOnMount?: boolean;
  /** The success copy. Refusals always use the server's own sentence. */
  messages?: ConnectedAccountsMessages;
}

/** What {@link useConnectedAccountsPanel} returns. */
export interface ConnectedAccountsPanel extends ListPanel<OAuthLink, string> {
  /** Every provider the deployment offers, as given. */
  providers: readonly ProviderOption[];
  /** The providers not yet attached, so a page draws only usable buttons. */
  connectable: ProviderOption[];
  /**
   * Starts the attach for one provider and navigates to it. Resolves after the
   * navigation is requested; a refusal lands in `error` instead.
   */
  link: (provider: string) => Promise<void>;
  /**
   * Detaches one provider. Refused with `last-sign-in-method` when it is the
   * only way into the account, whose sentence names setting a password first.
   */
  unlink: (provider: string) => Promise<void>;
  /**
   * The providers that cannot be detached, mapped to the server's reason. A row
   * disables its own control on this rather than discovering the refusal by
   * making the call. Cleared by every reload.
   */
  blocked: Record<string, string>;
}

/** Reduces an unlink outcome to the panel's shape. */
function settle(outcome: OAuthUnlinkOutcome): PanelOutcome {
  if (outcome.ok) {
    return PANEL_OK;
  }
  return {
    ok: false,
    message: outcome.message,
    unavailable: outcome.reason === 'provider-unavailable',
    stale: outcome.reason === 'not-linked',
  };
}

/**
 * The connected accounts panel, headless. Renders nothing.
 *
 * The link leg is separate from {@link ListPanel.create} because it ends in a
 * navigation rather than a new row: on success the browser leaves for the
 * provider and the list is re-read when the callback lands.
 *
 * @example
 * ```tsx
 * const panel = useConnectedAccountsPanel({ client, providers, returnTo: '/settings' });
 * return panel.connectable.map((p) => (
 *   <button key={p.id} onClick={() => void panel.link(p.id)}>{p.displayName}</button>
 * ));
 * ```
 */
export function useConnectedAccountsPanel(
  options: ConnectedAccountsOptions
): ConnectedAccountsPanel {
  const { client } = options;
  const providers = options.providers ?? [];
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const [unlinked, setUnlinked] = useState<string | null>(null);

  const list = useCallback(async (): Promise<{
    items: OAuthLink[] | null;
    outcome: PanelOutcome;
  }> => {
    const outcome: OAuthLinksOutcome = await client.listOAuthLinks();
    if (outcome.ok) {
      setBlocked({});
      return { items: outcome.links, outcome: PANEL_OK };
    }
    return {
      items: null,
      outcome: { ok: false, message: outcome.message, unavailable: true },
    };
  }, [client]);

  const remove = useCallback(
    async (provider: string): Promise<PanelOutcome> => {
      const outcome = await client.unlinkOAuthProvider(provider);
      if (!outcome.ok && outcome.reason === 'last-sign-in-method') {
        setBlocked((current) => ({
          ...current,
          [provider]: outcome.message,
        }));
      }
      setUnlinked(outcome.ok ? provider : null);
      return settle(outcome);
    },
    [client]
  );

  const removedMessage = options.messages?.removed;
  const notices = useMemo(
    () =>
      removedMessage === undefined || typeof removedMessage === 'function'
        ? {}
        : { removed: removedMessage },
    [removedMessage]
  );

  const panel = useListPanel<OAuthLink, string>({
    list,
    remove,
    ...(options.loadOnMount === undefined
      ? {}
      : { loadOnMount: options.loadOnMount }),
    messages: notices,
  });

  const { remove: runRemove, items, notice, beginCall, endCall, fail } = panel;

  const unlink = useCallback(
    (provider: string) => runRemove(provider),
    [runRemove]
  );

  const { navigate, returnTo } = options;

  const link = useCallback(
    async (provider: string): Promise<void> => {
      beginCall();
      const outcome: OAuthLinkOutcome = await client.linkOAuthProvider(
        provider,
        returnTo === undefined ? {} : { returnTo }
      );
      if (outcome.ok) {
        const go =
          navigate ?? ((url: string) => globalThis.location.assign(url));
        go(outcome.authorizationUrl);
        return;
      }
      endCall();
      fail(outcome.message, outcome.reason === 'provider-unavailable');
    },
    [client, navigate, returnTo, beginCall, endCall, fail]
  );

  const connectable = useMemo(() => {
    const attached = new Set((items ?? []).map((entry) => entry.provider));
    return providers.filter((entry) => !attached.has(entry.id));
  }, [providers, items]);

  const resolved =
    typeof removedMessage === 'function' && unlinked !== null && notice === null
      ? removedMessage(unlinked)
      : notice;

  return useMemo(
    () => ({
      ...panel,
      notice: resolved,
      providers,
      connectable,
      link,
      unlink,
      blocked,
    }),
    [panel, resolved, providers, connectable, link, unlink, blocked]
  );
}
