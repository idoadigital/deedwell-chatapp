/**
 * The contract every connector implements. Adding LinkedIn, TikTok, Slack or
 * Mailchimp later means writing one of these and adding a registry entry —
 * no route changes, no UI changes, no migration.
 */
export type ConnectorStatus = "connected" | "needs_attention" | "expired" | "disconnected";

/** What the browser is allowed to see. Deliberately has no token fields: the
 *  route layer builds this shape, so a token cannot leak by accident. */
export interface ConnectionView {
  id: string;
  provider: string;
  connectorType: string;
  accountName: string | null;
  accountHandle: string | null;
  accountAvatarUrl: string | null;
  status: ConnectorStatus;
  statusDetail: string | null;
  scopes: string[];
  connectedAt: string;
  metadata: Record<string, unknown>;
}

/** An account the provider says this user can manage, offered for selection
 *  when there is more than one (a Facebook Page, an Instagram account). */
export interface SelectableAccount {
  connectorType: string;
  providerAccountId: string;
  name: string;
  handle?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OAuthTokens {
  /** The provider's own id for the person who authorized. Needed to honour a
   *  data-deletion request, which identifies a person rather than an account. */
  providerUserId?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes: string[];
}

export interface ConnectorProvider {
  readonly provider: string;
  /** Human name, shown on the card. */
  readonly label: string;
  /** OAuth scopes requested at connect time. Kept minimal on purpose —
   *  additional scopes are requested when a feature is actually switched on. */
  readonly scopes: string[];
  /** True when the provider is configured (client id/secret present). A
   *  connector with no credentials is shown as unavailable rather than
   *  offering a Connect button that cannot work. */
  isConfigured(): boolean;
  /** Where to send the browser. `state` is already the single-use CSRF value. */
  authorizeUrl(args: { state: string; redirectUri: string; codeChallenge?: string }): string;
  /** Server-side code exchange. Never called from the browser. */
  exchangeCode(args: { code: string; redirectUri: string; codeVerifier?: string }): Promise<OAuthTokens>;
  /** Accounts the user may attach, after authorization. */
  listAccounts(tokens: OAuthTokens): Promise<SelectableAccount[]>;
  /** Cheap liveness probe used by the health checker. */
  validate(tokens: OAuthTokens): Promise<{ ok: boolean; detail?: string }>;
  /** Long-lived credential refresh, where the provider supports it. */
  refresh?(tokens: OAuthTokens): Promise<OAuthTokens>;
  /** Best-effort revocation at the provider. Local disconnect happens either way. */
  revoke?(tokens: OAuthTokens): Promise<void>;
}
