export {
  GoogleAdsClient, GoogleAdsApiError, DEFAULT_API_VERSION, normalizeCustomerId, formatCustomerId,
  type GoogleAdsCredentials, type GoogleAdsClientOptions, type GoogleAdsErrorCode, type MutateResult, type MutateResource,
  type CustomerInfo, type ManagerLink, type ClientLink,
} from "./client.js";
export * from "./types.js";
export { RSA_LIMITS, validateAd, validateDraft, validateKeywordText, validateUrl, type ValidationIssue, type ValidationResult } from "./validate.js";
export {
  CAMPAIGNS_QUERY, AD_GROUPS_QUERY, ADS_QUERY, KEYWORDS_QUERY, NEGATIVE_CAMPAIGN_KEYWORDS_QUERY, metricsQuery,
  mapCampaign, mapAdGroup, mapAd, mapKeyword, mapCampaignNegative, mapMetric, customerResource,
} from "./queries.js";
export {
  computeComplianceMetrics, evaluateComplianceRules,
  type ComplianceRule, type ComplianceInput, type ComplianceResult, type ComplianceMetricKey,
} from "./compliance.js";
export { adsStrategist, adsCampaignBuilder, ALL_GOOGLE_ADS_AGENTS } from "./agents.js";
