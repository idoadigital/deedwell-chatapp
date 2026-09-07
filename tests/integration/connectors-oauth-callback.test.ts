import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MetaProvider, SocialPublishingService, runPublishBatch } from "@deedwell/connectors";
import { publishingMediaPath } from "../../apps/api/src/routes-content.js";
import { uuidv7 } from "@deedwell/database";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** The provider redirects back with only `code` and `state`. The state row is
 *  what identifies the tenant, so the callback has to be able to find it
 *  before any tenant context exists — a regression here turns every
 *  authorization into "already used or expired". */
describe("Connectors: OAuth callback", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let userId: string;
  let assetId: string;
  let pageId: string;

  beforeAll(async () => {
    process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "connectors@example.org"));
    orgId = await createOrg(env.app, token, "connectors-org");
    vi.spyOn(MetaProvider.prototype, "isConfigured").mockReturnValue(true);
    vi.spyOn(MetaProvider.prototype, "exchangeCode").mockResolvedValue({
      providerUserId: "u1", accessToken: "tok", refreshToken: null, expiresAt: null, scopes: ["pages_manage_posts"],
    });
    vi.spyOn(MetaProvider.prototype, "listAccounts").mockResolvedValue([
      { connectorType: "facebook_page", providerAccountId: "page-1", name: "Deedwell Page", handle: null, avatarUrl: null,
        metadata: { pageAccessToken: "PAGE-SECRET" } },
    ]);
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });

  it("claims the state issued by authorize and stages the accounts once", async () => {
    const auth = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/meta/authorize`, { token, body: {} });
    expect(auth.status).toBe(200);
    const state = new URL(auth.body.authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    const cb = await env.app.inject({ method: "GET", url: `/v1/connectors/meta/callback?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('"ok":true');
    expect(cb.body).not.toContain("already been used");

    // The authorization is staged against the right tenant.
    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    expect(list.status).toBe(200);
    const pending = list.body.connections.find((c: any) => c.provider === "meta" && c.connectorType === "pending_selection");
    expect(pending).toBeTruthy();
    expect(cb.body).toContain(pending.id);
    // The staged candidates reach the picker, their page tokens do not.
    expect(pending.metadata.candidates).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("PAGE-SECRET");

    // Single use: replaying the redirect is refused.
    const replay = await env.app.inject({ method: "GET", url: `/v1/connectors/meta/callback?code=abc&state=${state}` });
    expect(replay.body).toContain('"ok":false');
    expect(replay.body).toContain("already been used");
  });

  it("retires an abandoned authorization when a new one lands, and selection connects the page", async () => {
    const authorize = async () => {
      const auth = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/meta/authorize`, { token, body: {} });
      const state = new URL(auth.body.authorizeUrl).searchParams.get("state");
      await env.app.inject({ method: "GET", url: `/v1/connectors/meta/callback?code=abc&state=${state}` });
    };
    await authorize();
    await authorize();
    let list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    const pendings = list.body.connections.filter((c: any) => c.connectorType === "pending_selection");
    expect(pendings).toHaveLength(1);

    const sel = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/meta/select`, {
      token, body: { pendingId: pendings[0].id, accountIds: ["page-1"] },
    });
    expect(sel.status).toBe(200);
    list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    const page = list.body.connections.find((c: any) => c.connectorType === "facebook_page");
    expect(page?.status).toBe("connected");
    expect(page.accountName).toBe("Deedwell Page");
    expect(JSON.stringify(list.body)).not.toContain("PAGE-SECRET");
    expect(list.body.connections.filter((c: any) => c.connectorType === "pending_selection")).toHaveLength(0);
  });

  it("queues an approved design for a connected page, idempotently per destination", async () => {
    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    const page = list.body.connections.find((c: any) => c.connectorType === "facebook_page" && c.status === "connected");
    pageId = page.id;
    const projectId = uuidv7();
    assetId = uuidv7();
    await env.adminPool.query(
      `INSERT INTO content_projects (id, tenant_id, kind, title, prompt, status, created_by) VALUES ($1,$2,'social','Spring drive','posts','ready',$3)`,
      [projectId, orgId, userId]
    );
    await env.adminPool.query(
      `INSERT INTO content_assets (id, tenant_id, content_project_id, position, prompt, post_text, approval) VALUES ($1,$2,$3,0,'p','Join our spring drive!','approved')`,
      [assetId, orgId, projectId]
    );
    const first = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/publish`, { token, body: { connectorIds: [page.id] } });
    expect(first.status, first.raw).toBe(202);
    expect(first.body.posts[0].status).toBe("scheduled");
    expect(first.body.posts[0].content).toBe("Join our spring drive!");
    // Publishing the same design to the same page again reuses the row.
    const again = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/publish`, { token, body: { connectorIds: [page.id], content: "Updated copy" } });
    expect(again.status).toBe(202);
    expect(again.body.posts[0].id).toBe(first.body.posts[0].id);
    expect(again.body.posts[0].content).toBe("Updated copy");
    const posts = await api(env.app, "GET", `/v1/orgs/${orgId}/content/posts`, { token });
    expect(posts.body.posts.filter((p: any) => p.content_asset_id === assetId)).toHaveLength(1);
  });

  it("the worker publishes queued posts with a public image link and records the outcome", async () => {
    // Give the design an image, as Content Studio would.
    const projectId = uuidv7();
    const fileId = uuidv7();
    await env.adminPool.query(
      `INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,'Files','grant_application',$3)`,
      [projectId, orgId, userId]
    );
    await env.deps.storage.put(`t/${fileId}.png`, Buffer.from("89504e47", "hex"));
    await env.adminPool.query(
      `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
       VALUES ($1,$2,$3,'design.png','image/png',4,'x',$4,$5)`,
      [fileId, orgId, projectId, `t/${fileId}.png`, userId]
    );
    await env.adminPool.query(`UPDATE content_assets SET file_id = $2 WHERE id = $1`, [assetId, fileId]);
    const queued = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/publish`, { token, body: { connectorIds: [pageId] } });
    expect(queued.status).toBe(202);
    const postId = queued.body.posts[0].id;

    const publish = vi.spyOn(SocialPublishingService, "publish").mockResolvedValue({ providerPostId: "fb_123" } as any);
    const worker = {
      pool: env.adminPool,
      mediaUrlFor: async (ref: any) => `https://coworkers.test${await publishingMediaPath(env.adminPool, ref)}`,
    };
    expect(await runPublishBatch(worker)).toBe(1);
    const mediaUrl = publish.mock.calls[0]![0].mediaUrls?.[0] as string;
    expect(mediaUrl).toMatch(/^https:\/\/coworkers\.test\/v1\/share\/designs\/[A-Za-z0-9_-]+$/);
    // Meta fetches that link with no session.
    const fetched = await env.app.inject({ method: "GET", url: new URL(mediaUrl).pathname });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["content-type"]).toBe("image/png");
    let { rows } = await env.adminPool.query(`SELECT status, provider_post_id, error FROM scheduled_posts WHERE id = $1`, [postId]);
    expect(rows[0]).toMatchObject({ status: "published", provider_post_id: "fb_123", error: null });
    expect(await runPublishBatch(worker)).toBe(0);

    // A permission failure is recorded on the post and flags the connection.
    publish.mockRejectedValueOnce(new Error("(#200) Requires pages_manage_posts permission"));
    const re = await api(env.app, "POST", `/v1/orgs/${orgId}/content/assets/${assetId}/publish`, { token, body: { connectorIds: [pageId] } });
    expect(re.status, re.raw).toBe(202);
    expect(await runPublishBatch(worker)).toBe(1);
    ({ rows } = await env.adminPool.query(`SELECT status, error FROM scheduled_posts WHERE id = $1`, [postId]));
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("#200");
    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    expect(list.body.connections.find((c: any) => c.id === pageId).status).toBe("needs_attention");
  });
});
