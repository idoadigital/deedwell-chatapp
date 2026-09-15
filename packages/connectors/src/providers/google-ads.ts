import { GoogleProvider } from "./google.js";
import { GOOGLE_SCOPE } from "../google-services.js";

/**
 * Google Ads as its own connector. Same OAuth mechanics as the Google
 * connector, but a separate OAuth client: since September 2026 Google decides
 * Ads API access by the Cloud project that issued the token, so the Ads client
 * lives in the project that holds the API access level, while Gmail/Drive keep
 * using the platform's general Google client. Tokens are stored under
 * provider "google_ads", so the two connections never mix.
 */
export class GoogleAdsProvider extends GoogleProvider {
  override readonly provider: string = "google_ads";
  override readonly label: string = "Google Ads";
  override readonly scopes: string[] = ["openid", GOOGLE_SCOPE.email, GOOGLE_SCOPE.adwords];
}
