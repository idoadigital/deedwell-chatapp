import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api, createOrg, createTestEnv, registerUser, uploadDoc, type TestEnv,
} from "../helpers.js";
import { workspaceBridgeFlush } from "../../apps/api/src/workspace.js";
import type { ResearchPageResult } from "@deedwell/grant-domain";

/**
 * Spec §4: the research step really fetches the opportunity's linked pages,
 * records every source (including failures) with provenance, and never
 * invents content. The fetcher is stubbed here (tests run offline); the same
 * interface is implemented by @deedwell/browser-research in production.
 */

const DOC_WITH_LINKS = `Riverbend Community Fund — Youth Mentoring Grants 2026

Full program details: https://funder.example.gov/youth-mentoring
Application portal help: https://portal.example.org/help/apply
Internal admin (must never be fetched): http://localhost:9999/secret

Eligibility: Applicants must be a registered nonprofit 501(c)(3) organization.
Deadline: Applications are due 2026-09-30.
Narrative: Describe your youth mentoring program and the community it serves.
Budget: Provide a line-item budget with justification.
`;

const fetchedUrls: string[] = [];

const stubResearch = {
  async fetchPage(url: string): Promise<ResearchPageResult> {
    fetchedUrls.push(url);
    const accessedAt = new Date().toISOString();
    if (url.includes("funder.example.gov")) {
      return {
        url, finalUrl: url, title: "Youth Mentoring — Riverbend Community Fund",
        text: "The Youth Mentoring program funds mentoring for young people ages 10-18. Awards range from $25,000 to $150,000.",
        links: [], accessedAt, via: "browser", status: "retrieved",
      };
    }
    return {
      url, finalUrl: url, title: "", text: "", links: [], accessedAt,
      via: "browser", status: "failed", error: "HTTP 404",
    };
  },
};

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ research: stubResearch });
});
afterAll(async () =>
  env.close());

describe("browser-backed research (stubbed fetcher, real records)", () => {
  it("records retrieved and failed sources with provenance, and never fetches internal hosts", async () => {
    const { app } = env;
    const { token } = await registerUser(app, "research@example.org");
    const orgId = await createOrg(app, token, "research-org");
    await api(app, "POST", `/v1/orgs/${orgId}/facts`, {
      token,
      body: { facts: [
        { key: "entity_type", value: "501(c)(3) public charity" },
        { key: "registration_status", value: "registered" },
        { key: "service_area", value: "Riverbend County" },
        { key: "annual_budget", value: "400000" },
      ] },
    });
    const project = await api(app, "POST", `/v1/orgs/${orgId}/projects`, {
      token, body: { name: "Youth Mentoring 2026", type: "grant_application" },
    });
    const projectId = project.body.projectId;
    const opp = await api(app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/opportunities`, {
      token,
      body: {
        title: "Youth Mentoring Grants", funder: "Riverbend Community Fund",
        opportunityNumber: "RCF-2026-07", deadline: "2026-09-30", fundingMax: 150000, source: "manual",
      },
    });
    const fileId = await uploadDoc(app, token, orgId, projectId, DOC_WITH_LINKS);
    const started = await api(app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/grant-application`, {
      token, body: { opportunityId: opp.body.opportunityId, fileId },
    });
    expect(started.status).toBe(201);

    await env.deps.engine.drain("research-test");
    await workspaceBridgeFlush();

    // The internal URL never reached the fetcher (first-line SSRF filter).
    expect(fetchedUrls.some((u) => u.includes("localhost"))).toBe(false);
    expect(fetchedUrls.some((u) => u.includes("funder.example.gov"))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes("portal.example.org"))).toBe(true);

    const ws = await api(app, "GET", `/v1/orgs/${orgId}/projects/${projectId}/grant-workspace`, { token });
    const sources = ws.body.sources as Array<Record<string, unknown>>;

    // Retrieved page: real title, excerpt, publisher, traceable URL.
    const good = sources.find((s) => String(s.url).includes("funder.example.gov"));
    expect(good).toBeTruthy();
    expect(good!.fetch_status).toBe("retrieved");
    expect(good!.title).toContain("Youth Mentoring");
    expect(String(good!.excerpt)).toContain("mentoring");
    expect(good!.publisher).toBe("funder.example.gov");
    expect(good!.reliability).toBe("SECONDARY_OFFICIAL"); // .gov, not the announcement itself

    // Unreachable page: recorded honestly as failed, marked unverified.
    const bad = sources.find((s) => String(s.url).includes("portal.example.org"));
    expect(bad).toBeTruthy();
    expect(bad!.fetch_status).toBe("failed");
    expect(bad!.reliability).toBe("UNVERIFIED");

    // Live timeline events exist for the step and for each page visit.
    const events = ws.body.events as Array<Record<string, unknown>>;
    expect(events.some((e) => e.event_type === "step:research_sources")).toBe(true);
    const pageEvents = events.filter((e) => e.event_type === "research:page");
    expect(pageEvents.some((e) => e.status === "completed")).toBe(true);
    expect(pageEvents.some((e) => e.status === "failed" && String(e.error).includes("404"))).toBe(true);
  });

  it("with no fetcher configured, the step records an honest skip — no fake sources", async () => {
    const bare = await createTestEnv({ research: undefined });
    try {
      const { app } = bare;
      const { token } = await registerUser(app, "noresearch@example.org");
      const orgId = await createOrg(app, token, "noresearch-org");
      const project = await api(app, "POST", `/v1/orgs/${orgId}/projects`, {
        token, body: { name: "NR", type: "grant_application" },
      });
      const projectId = project.body.projectId;
      const opp = await api(app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/opportunities`, {
        token, body: { title: "T", funder: "F", source: "manual" },
      });
      const fileId = await uploadDoc(app, token, orgId, projectId, DOC_WITH_LINKS);
      await api(app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/grant-application`, {
        token, body: { opportunityId: opp.body.opportunityId, fileId },
      });
      await bare.deps.engine.drain("nr-test");
      await workspaceBridgeFlush();

      const ws = await api(app, "GET", `/v1/orgs/${orgId}/projects/${projectId}/grant-workspace`, { token });
      const events = ws.body.events as Array<Record<string, unknown>>;
      expect(events.some((e) => e.event_type === "research:skipped")).toBe(true);
      // No web sources were fabricated (the announcement source rows come only
      // from real retrieval, which this manual-upload path doesn't do).
      const sources = ws.body.sources as Array<Record<string, unknown>>;
      expect(sources.filter((s) => s.source_type === "LINKED_PAGE")).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});
