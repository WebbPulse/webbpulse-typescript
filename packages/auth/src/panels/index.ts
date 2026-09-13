/**
 * Headless state machines for the identity settings panels: passkeys, connected
 * accounts and TOTP. Every hook returns state and handlers only, so a product
 * keeps its own markup, copy and layout.
 *
 * Refusals carry the server's own sentence in `error`, which a product renders
 * verbatim. Success copy is the product's, passed as the `messages` option.
 */

export {
  PANEL_CANCELLED,
  PANEL_OK,
  useListPanel,
  type ListPanel,
  type ListPanelConfig,
  type PanelMessages,
  type PanelOutcome,
  type PanelState,
} from './list-panel.js';

export {
  usePasskeyPanel,
  type PasskeyPanel,
  type PasskeyPanelMessages,
  type PasskeyPanelOptions,
} from './passkey-panel.js';

export {
  useConnectedAccountsPanel,
  type ConnectedAccountsMessages,
  type ConnectedAccountsOptions,
  type ConnectedAccountsPanel,
  type ProviderOption,
} from './connected-accounts-panel.js';

export {
  useTotpPanel,
  type FactorState,
  type TotpPanel,
  type TotpPanelMessages,
  type TotpPanelOptions,
  type TotpPrompt,
  type TotpStep,
} from './totp-panel.js';
