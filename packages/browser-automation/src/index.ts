import type { Pool } from "pg";
import type { Page } from "playwright";
import { uuidv7, withContext, type StorageAdapter } from "@deedwell/database";
import {
  loadActiveGoogleSession,
  markSessionExpired,
  markSessionUsed,
} from "@deedwell/adgrants-domain";
import type { GoogleAutomationService } from "@deedwell/grant-domain";
import { SessionExpiredError, isGoogleAuthenticated, withGoogleSession } from "./session.js";
import {
  clickActivate,
  clickSubmitEnrollment,
  fillAdGrantsActivation,
  fillNonprofitsEnrollment,
  readReviewStatus,
} from "./nonprofits-flow.js";
import { buildCampaign, clickEnableCampaign } from "./ads-flow.js";

export { startScreencast, dispatchInput, type LiveFrame, type RelayInputEvent } from "./live-relay.js";
export { withGoogleSession, isGoogleAuthenticated, SessionExpiredError } from "./session.js";
export { startGoogleConnectFlow, type ConnectFlowHandlers, type ConnectFlowHandle } from "./connect-flow.js";

const NONPROFITS_CHECK_URL = "https://www.google.com/nonprofits/";

export interface GoogleProgress {
  tenantId: string;
  /** Which automation this belongs to (enrollment, review, activation, campaign). */
  phase: string;
  /** Plain-language line for the timeline: "Filling in the enrollment form". */
  message: string;
  /** A viewport screenshot of what the browser showed at that moment. */
  screenshotKey?: string;
}

export interface GoogleAutomationDeps {
  appPool: Pool;
  storage: StorageAdapter;
  /** Real-time narration of what the browser is doing, with a screenshot per
   *  step, for the dashboard's live view. Optional; never throws through. */
  onProgress?: (progress: GoogleProgress) => Promise<void>;
}

async function screenshot(storage: StorageAdapter, tenantId: string, page: Page, opts: { fullPage?: boolean } = { fullPage: true }): Promise<string> {
  const buf = await page.screenshot({ fullPage: opts.fullPage ?? true, type: "jpeg", quality: 70 }).catch(() => page.screenshot({ type: "jpeg", quality: 70 }));
  const key = `tenants/${tenantId}/ad-grants/${uuidv7()}.jpg`;
  await storage.put(key, buf);
  return key;
}

/**
 * Builds the GoogleAutomationService the ad-grants workflow calls through
 * ctx.services.google. Every method opens its own fresh headless session
 * (see session.ts) seeded from the tenant's stored, encrypted storageState
 * — nothing here holds a browser open across calls, since calls can be
 * separated by a human approval wait of any length.
 */
export function createGoogleAutomation(deps: GoogleAutomationDeps): GoogleAutomationService {
  async function withSession<T>(tenantId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    return withContext(deps.appPool, { tenantId, userId: null }, async (client) => {
      const session = await loadActiveGoogleSession(client, tenantId);
      if (!session) throw new SessionExpiredError();
      try {
        const result = await withGoogleSession(session.storageState, ({ page }) => fn(page));
        await markSessionUsed(client, tenantId);
        return result;
      } catch (err) {
        if (err instanceof SessionExpiredError) await markSessionExpired(client, tenantId);
        throw err;
      }
    });
  }

  /** One line + one frame for the live view. A failure here is logged and
   *  swallowed: narration must never fail the automation it narrates. */
  const progress = async (tenantId: string, phase: string, message: string, page?: Page) => {
    if (!deps.onProgress) return;
    try {
      const screenshotKey = page ? await screenshot(deps.storage, tenantId, page, { fullPage: false }).catch(() => undefined) : undefined;
      await deps.onProgress({ tenantId, phase, message, ...(screenshotKey ? { screenshotKey } : {}) });
    } catch (err) {
      console.error(JSON.stringify({ at: "google.progress_failed", tenantId, phase, err: String((err as Error).message ?? err).slice(0, 200) }));
    }
  };

  return {
    async checkSession(tenantId) {
      return withContext(deps.appPool, { tenantId, userId: null }, async (client) => {
        const session = await loadActiveGoogleSession(client, tenantId);
        if (!session) return { connected: false, accountHint: null };
        await progress(tenantId, "session", "Checking that the Google account is still signed in");
        const connected = await withGoogleSession(session.storageState, async ({ page }) => {
          const ok = await isGoogleAuthenticated(page, NONPROFITS_CHECK_URL);
          await progress(tenantId, "session", ok ? "Google account is signed in" : "Google asked to sign in again", page);
          return ok;
        }).catch(() => false);
        if (!connected) {
          await markSessionExpired(client, tenantId);
          return { connected: false, accountHint: null };
        }
        await markSessionUsed(client, tenantId);
        return { connected: true, accountHint: session.accountHint };
      });
    },

    async runNonprofitsEnrollment(tenantId, facts) {
      return withSession(tenantId, async (page) => {
        await progress(tenantId, "enrollment", "Opening Google for Nonprofits");
        const report = await fillNonprofitsEnrollment(page, facts);
        const filled = report.fields.filter((f) => f.status === "filled").length;
        await progress(tenantId, "enrollment", `Filled in the enrollment form (${filled} of ${report.fields.filter((f) => f.status !== "empty").length} fields) — waiting for your approval`, page);
        const screenshotKey = await screenshot(deps.storage, tenantId, page);
        return { screenshotKey, report };
      });
    },

    async submitNonprofitsEnrollment(tenantId, facts) {
      return withSession(tenantId, async (page) => {
        await progress(tenantId, "enrollment", "Re-opening the enrollment form to submit it");
        const report = await fillNonprofitsEnrollment(page, facts);
        await progress(tenantId, "enrollment", "Submitting the enrollment to Google", page);
        const submitted = await clickSubmitEnrollment(page);
        if (!submitted) throw new Error("Could not find the submit button on Google's enrollment form — nothing was submitted.");
        await progress(tenantId, "enrollment", "Enrollment submitted — Google will now review it", page);
        return { submitted, report };
      });
    },

    async checkGoogleReviewStatus(tenantId) {
      return withSession(tenantId, async (page) => {
        const result = await readReviewStatus(page);
        await progress(tenantId, "review", result.status === "pending" ? "Checked Google's review status: still under review" : result.status === "approved" ? "Google approved the enrollment" : "Google did not approve the enrollment", page);
        return result;
      });
    },

    async runAdGrantsActivation(tenantId) {
      return withSession(tenantId, async (page) => {
        await progress(tenantId, "activation", "Opening the Ad Grants activation page");
        const report = await fillAdGrantsActivation(page);
        await progress(tenantId, "activation", "Prepared the Ad Grants activation — waiting for your approval", page);
        const screenshotKey = await screenshot(deps.storage, tenantId, page);
        return { screenshotKey, report };
      });
    },

    async submitAdGrantsActivation(tenantId) {
      return withSession(tenantId, async (page) => {
        const report = await fillAdGrantsActivation(page);
        await progress(tenantId, "activation", "Activating Ad Grants", page);
        const submitted = await clickActivate(page);
        if (!submitted) throw new Error("Could not find the activate button on Google's Ad Grants page — nothing was submitted.");
        await progress(tenantId, "activation", "Ad Grants activation submitted", page);
        return { submitted, report };
      });
    },

    async publishCampaign(tenantId, plan) {
      return withSession(tenantId, async (page) => {
        await progress(tenantId, "campaign", "Building the campaign in Google Ads");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plan is stored as jsonb; shape is enforced by AdGrantsCampaignPlanOutput at draft time.
        await buildCampaign(page, plan as any);
        const campaignId = await clickEnableCampaign(page);
        return { campaignId: campaignId ?? "unknown" };
      });
    },
  };
}

export type { FillReport, FieldResult, FieldStatus } from "./fill.js";
