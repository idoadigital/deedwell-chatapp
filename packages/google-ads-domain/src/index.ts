export {
  GoogleAdsClient, GoogleAdsApiError, DEFAULT_API_VERSION, normalizeCustomerId, formatCustomerId,
  type GoogleAdsCredentials, type GoogleAdsClientOptions, type GoogleAdsErrorCode, type MutateResult, type MutateResource,
  type CustomerInfo, type ManagerLink, type ClientLink,
} from "./client.js";
export * from "./types.js";
export { RSA_LIMITS, ASSET_LIMITS, validateAd, validateAsset, validateDraft, validateKeywordText, validateUrl, type ValidationIssue, type ValidationResult } from "./validate.js";
export {
  CAMPAIGNS_QUERY, AD_GROUPS_QUERY, ADS_QUERY, KEYWORDS_QUERY, NEGATIVE_CAMPAIGN_KEYWORDS_QUERY, metricsQuery,
  mapCampaign, mapAdGroup, mapAd, mapKeyword, mapCampaignNegative, mapMetric, customerResource,
} from "./queries.js";
export {
  computeComplianceMetrics, evaluateComplianceRules,
  type ComplianceRule, type ComplianceInput, type ComplianceResult, type ComplianceMetricKey,
} from "./compliance.js";
export { adsStrategist, adsCampaignBuilder, ALL_GOOGLE_ADS_AGENTS } from "./agents.js";
export { AD_GRANTS_MANAGER_PROMPT, AD_GRANTS_MANAGER_OPERATING_ADDENDUM, AD_GRANTS_MANAGER_PROMPT_VERSION } from "./grants-manager-prompt.js";
export { adsGrantsManager } from "./agents.js";
export { utilizationForecast, AD_GRANTS_MONTHLY_LIMIT_USD, AD_GRANTS_DAILY_CAP_USD, type UtilizationForecast, type UtilizationInput } from "./utilization.js";
export { REQUEST_GOALS, OPEN_REQUEST_STATUSES, CLOSED_REQUEST_STATUSES, CANCELLABLE_REQUEST_STATUSES, isOpenRequest, type RequestGoal, type RequestStatus } from "./requests.js";
