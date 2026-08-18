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

export interface GoogleAutomationDeps {
  appPool: Pool;
  storage: StorageAdapter;
}

async function screenshot(storage: StorageAdapter, tenantId: string, page: Page): Promise<string> {
  const buf = await page.screenshot({ fullPage: true });
  const key = `tenants/${tenantId}/ad-grants/${uuidv7()}.png`;
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

  return {
    async checkSession(tenantId) {
      return withContext(deps.appPool, { tenantId, userId: null }, async (client) => {
        const session = await loadActiveGoogleSession(client, tenantId);
        if (!session) return { connected: false, accountHint: null };
        const connected = await withGoogleSession(session.storageState, ({ page }) =>
          isGoogleAuthenticated(page, NONPROFITS_CHECK_URL)
        ).catch(() => false);
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
        await fillNonprofitsEnrollment(page, facts);
        const screenshotKey = await screenshot(deps.storage, tenantId, page);
        return { screenshotKey };
      });
    },

    async submitNonprofitsEnrollment(tenantId, facts) {
      return withSession(tenantId, async (page) => {
        await fillNonprofitsEnrollment(page, facts);
        await clickSubmitEnrollment(page);
        return { submitted: true };
      });
    },

    async checkGoogleReviewStatus(tenantId) {
      return withSession(tenantId, (page) => readReviewStatus(page));
    },

    async runAdGrantsActivation(tenantId) {
      return withSession(tenantId, async (page) => {
        await fillAdGrantsActivation(page);
        const screenshotKey = await screenshot(deps.storage, tenantId, page);
        return { screenshotKey };
      });
    },

    async submitAdGrantsActivation(tenantId) {
      return withSession(tenantId, async (page) => {
        await fillAdGrantsActivation(page);
        await clickActivate(page);
        return { submitted: true };
      });
    },

    async publishCampaign(tenantId, plan) {
      return withSession(tenantId, async (page) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plan is stored as jsonb; shape is enforced by AdGrantsCampaignPlanOutput at draft time.
        await buildCampaign(page, plan as any);
        const campaignId = await clickEnableCampaign(page);
        return { campaignId: campaignId ?? "unknown" };
      });
    },
  };
}
