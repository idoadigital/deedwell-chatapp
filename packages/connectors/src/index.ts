export type {
  ConnectorProvider, ConnectorStatus, ConnectionView, SelectableAccount, OAuthTokens,
} from "./types.js";
export { getProvider, listProviders, PROVIDER_NAMES } from "./registry.js";
export { MetaProvider } from "./providers/meta.js";
export { GoogleProvider } from "./providers/google.js";
export {
  SocialPublishingService, MetaPublishingProvider,
  type PublishRequest, type PublishResult, type PublishingProvider,
} from "./publishing.js";
export {
  currentEnvironment, readPlatformCredentials, listPlatformIntegrations,
  savePlatformCredentials, updateIntegrationConfiguration, markIntegrationValidated,
  disableIntegration,
  type IntegrationEnvironment, type IntegrationStatus, type PlatformIntegrationView,
  type PlatformCredentials,
} from "./platform-config.js";
export { ConnectorHealthService, unseal, providerLabel, type HealthResult } from "./health.js";
export { startPublishWorker, runPublishBatch, reclaimStalePosts, type WorkerDeps } from "./worker.js";
export { parseSignedRequest, newConfirmationCode, SignedRequestError, type SignedRequestPayload } from "./data-deletion.js";
export {
  GOOGLE_SERVICES, GOOGLE_SERVICE_KEYS, GOOGLE_SCOPE, normalizeScope, normalizeScopes, serviceByKey, scopesForServices,
  missingScopes, serviceStatuses, type GoogleService, type GoogleServiceStatus,
} from "./google-services.js";
export {
  GoogleConnectionService, GoogleConnectionError, summarize as summarizeGoogleConnection,
  type GoogleConnectionSummary, type GoogleAccess, type GoogleConnectionErrorCode,
} from "./google-connection.js";
