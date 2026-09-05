import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** Generation is detached from the request, so the client polls. */
async function waitSettled(env: TestEnv, orgId: string, token: string, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/content/${id}`, { token });
    if (r.body.contentProject.status !== "generating") return r.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("campaign never settled");
}

describe("Content Studio → public share links", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let assetId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "share@example.org"));
    orgId = await createOrg(env.app, token, "share-org");
    const created = await api(env.app, "POST", `/v1/orgs/${orgId}/content`, {
      token, body: { kind: "social", prompt: "Announce our winter coat drive" },
    });
    expect(created.status).toBe(202);
    const settled = await waitSettled(env, orgId, token, created.body.contentProject.id);
    expect(settled.contentProject.status).toBe("ready");
    assetId = settled.assets[0].id;
  });
  afterAll(async () => { await env.close(); });

  it("mints one link per design and serves the image to anyone holding it", async () => {
    const first = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/share`, { token });
    expect(first.status).toBe(201);
    expect(first.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(first.body.path).toBe(`/v1/share/designs/${first.body.token}`);

    // Asking again hands back the same link rather than a second one.
    const again = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/share`, { token });
    expect(again.status).toBe(200);
    expect(again.body.token).toBe(first.body.token);

    // No session, no API key: the token is the credential.
    const pub = await env.app.inject({ method: "GET", url: first.body.path });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers["content-type"]).toMatch(/^image\//);
    expect(pub.headers["content-disposition"]).toMatch(/^inline/);
    expect(pub.headers["cache-control"]).toMatch(/public/);
    expect(pub.rawPayload.length).toBeGreaterThan(0);

    const dl = await env.app.inject({ method: "GET", url: `${first.body.path}?download=1` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
  });

  it("goes dark once revoked", async () => {
    const made = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/share`, { token });
    const path = made.body.path as string;
    const revoked = await api(env.app, "DELETE", `/v1/orgs/${orgId}/content/assets/${assetId}/share`, { token });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(1);
    const gone = await env.app.inject({ method: "GET", url: path });
    expect(gone.statusCode).toBe(404);
    // A fresh share after revoking is a new token, so the old link stays dead.
    const fresh = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/share`, { token });
    expect(fresh.status).toBe(201);
    expect(fresh.body.path).not.toBe(path);
  });

  it("rejects unknown tokens and designs from another organization", async () => {
    const junk = await env.app.inject({ method: "GET", url: "/v1/share/designs/not-a-real-token-at-all" });
    expect(junk.statusCode).toBe(404);
    const { token: otherToken } = await registerUser(env.app, "other@example.org");
    const otherOrg = await createOrg(env.app, otherToken, "other-org");
    const cross = await api(env.app, "POST", `/v1/orgs/${otherOrg}/content/assets/${assetId}/share`, { token: otherToken });
    expect(cross.status).toBe(404);
  });

  it("does not let a viewer share", async () => {
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/share`, {});
    expect(res.status).toBe(401);
  });
});
