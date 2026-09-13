/**
 * React bindings for the discovery reads. A separate entry point so the core
 * package stays framework free and a caller that only needs the functions never
 * pulls React into its bundle.
 */

import { useEffect, useRef, useState } from 'react';

import { identityUrl } from './availability.js';
import {
  OAUTH_PROVIDERS_PATH,
  oauthProviders,
  type OAuthProviderInfo,
} from './oauth.js';

/** Options for {@link useOAuthProviders}. */
export interface OAuthProvidersOptions {
  /**
   * The origin the identity routes are mounted on, from `identityOriginFrom`.
   * The empty string reads a path the browser resolves against the current
   * origin.
   */
  identityOrigin: string;
  /** Whether to read at all. False answers `[]` without a request. */
  enabled?: boolean;
  /** The fetch to use. Defaults to the global one. */
  fetchImpl?: typeof fetch;
}

/**
 * The providers to draw buttons for, in the order the deployment listed them.
 *
 * One request for the whole list, shared with every other caller on the page by
 * the module's own cache. The list starts empty and fills in after a round trip,
 * so a page never draws a button for a provider that cannot work.
 *
 * @example
 * ```tsx
 * const providers = useOAuthProviders({ identityOrigin });
 * return providers.map((p) => <ProviderButton key={p.id} provider={p} />);
 * ```
 */
export function useOAuthProviders(
  options: OAuthProvidersOptions
): OAuthProviderInfo[] {
  const [available, setAvailable] = useState<OAuthProviderInfo[]>([]);
  const { identityOrigin } = options;
  const enabled = options.enabled !== false;
  const fetchRef = useRef(options.fetchImpl);
  fetchRef.current = options.fetchImpl;

  useEffect(() => {
    if (!enabled) {
      setAvailable([]);
      return;
    }
    let live = true;

    void oauthProviders(
      identityUrl(identityOrigin, OAUTH_PROVIDERS_PATH),
      fetchRef.current ?? globalThis.fetch
    ).then((providers) => {
      if (!live) {
        return;
      }
      setAvailable(providers);
    });

    return () => {
      live = false;
    };
  }, [enabled, identityOrigin]);

  return available;
}
