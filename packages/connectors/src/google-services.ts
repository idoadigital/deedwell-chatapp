/**
 * The catalogue of Google services Deedwell can act on, each with the OAuth
 * scopes it needs. This is the single place a new Google integration is
 * declared: add an entry, and the connector UI shows it, the authorize
 * route knows which scopes to ask for incrementally, and
 * GoogleConnectionService.require() can gate on it.
 *
 * `identity` is granted by every connection. The Ad Grants application only
 * needs identity from OAuth — the automation itself acts through a separate,
 * secure browser session (google_sessions), which the connector reports
 * alongside these but which no OAuth scope can replace.
 */
export interface GoogleService {
  key: string;
  label: string;
  description: string;
  scopes: string[];
  /** Part of the base connection: granted by the first authorization. */
  base?: boolean;
}

export const GOOGLE_SCOPE = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
  spreadsheets: "https://www.googleapis.com/auth/spreadsheets",
  adwords: "https://www.googleapis.com/auth/adwords",
} as const;

export const GOOGLE_SERVICES: GoogleService[] = [
  { key: "identity", label: "Google account", description: "Your name, email address and profile photo.", scopes: [GOOGLE_SCOPE.openid, GOOGLE_SCOPE.email, GOOGLE_SCOPE.profile], base: true },
  { key: "gmail", label: "Gmail", description: "Read and send email on your behalf.", scopes: [GOOGLE_SCOPE.gmailRead, GOOGLE_SCOPE.gmailSend], base: true },
  { key: "drive", label: "Google Drive", description: "Save documents and images Deedwell creates to your Drive.", scopes: [GOOGLE_SCOPE.driveFile] },
  { key: "calendar", label: "Google Calendar", description: "Create and update events.", scopes: [GOOGLE_SCOPE.calendarEvents] },
  { key: "sheets", label: "Google Sheets", description: "Read and write spreadsheets.", scopes: [GOOGLE_SCOPE.spreadsheets] },
  { key: "googleads", label: "Google Ads", description: "Let Deedwell manage your Google Ads campaigns and show advertising performance.", scopes: [GOOGLE_SCOPE.adwords] },
  { key: "adgrants", label: "Google Ad Grants", description: "Identifies the Google account that manages your Ad Grants application. Steps on Google for Nonprofits use a secure browser session.", scopes: [GOOGLE_SCOPE.openid, GOOGLE_SCOPE.email, GOOGLE_SCOPE.profile] },
];

export const GOOGLE_SERVICE_KEYS = GOOGLE_SERVICES.map((s) => s.key);

/** Google spells identity scopes two ways ("email" in the request,
 *  ".../userinfo.email" in the token response). Compare on one spelling. */
export function normalizeScope(scope: string): string {
  if (scope === "email") return GOOGLE_SCOPE.email;
  if (scope === "profile") return GOOGLE_SCOPE.profile;
  return scope;
}

export function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map(normalizeScope))];
}

export function serviceByKey(key: string): GoogleService | undefined {
  return GOOGLE_SERVICES.find((s) => s.key === key);
}

export function scopesForServices(keys: string[]): string[] {
  return normalizeScopes(keys.flatMap((k) => serviceByKey(k)?.scopes ?? []));
}

export function missingScopes(granted: string[], required: string[]): string[] {
  const have = new Set(normalizeScopes(granted));
  return normalizeScopes(required).filter((s) => !have.has(s));
}

export interface GoogleServiceStatus extends GoogleService {
  granted: boolean;
  missing: string[];
}

/** Every catalogue entry with whether the given grant covers it. */
export function serviceStatuses(grantedScopes: string[]): GoogleServiceStatus[] {
  return GOOGLE_SERVICES.map((s) => {
    const missing = missingScopes(grantedScopes, s.scopes);
    return { ...s, granted: missing.length === 0, missing };
  });
}
