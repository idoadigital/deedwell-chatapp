import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";
import { uuidv7 } from "@deedwell/database";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Every document in Artifacts downloads as a PDF, and images can be sent to
 *  Google Drive once a Google account with the Drive scope is connected. */
describe("Artifacts: PDF export and Google Drive", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let userId: string;
  let artifactId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "artifacts@example.org"));
    orgId = await createOrg(env.app, token, "artifacts-org");
    // A grant section as the workflow would have written it.
    const projectId = uuidv7();
    artifactId = uuidv7();
    await env.adminPool.query(
      `INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,'Literacy grant','grant_application',$3)`,
      [projectId, orgId, userId]
    );
    await env.adminPool.query(
      `INSERT INTO artifacts (id, tenant_id, project_id, type, title, current_version) VALUES ($1,$2,$3,'grant_section','Statement of need',2)`,
      [artifactId, orgId, projectId]
    );
    for (const v of [1, 2]) {
      await env.adminPool.query(
        `INSERT INTO artifact_versions (id, tenant_id, artifact_id, version, content, created_by_kind, created_by_agent, change_summary)
         VALUES ($1,$2,$3,$4,$5,'agent','grant.writer','draft')`,
        [uuidv7(), orgId, artifactId, v, JSON.stringify({ body: `## Need (v${v})\n\nFamilies need books.`, claims: [{ text: "Families need books", support: "assumption", flagged: true }], wordCount: 3 })]
      );
    }
  });
  afterAll(async () => { await env.close(); });

  it("renders any artifact as a PDF on demand, current version by default", async () => {
    const res = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/artifacts/${artifactId}/export?format=pdf`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain('filename="statement-of-need.pdf"');
    expect(Buffer.from(res.rawPayload).subarray(0, 5).toString()).toBe("%PDF-");
    const older = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/artifacts/${artifactId}/export?format=pdf&version=1`, headers: { authorization: `Bearer ${token}` } });
    expect(older.statusCode).toBe(200);
    const missing = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/artifacts/${uuidv7()}/export?format=pdf`, headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(404);
  });

  it("still only serves markdown and docx where the run produced them", async () => {
    const md = await api(env.app, "GET", `/v1/orgs/${orgId}/artifacts/${artifactId}/export`, { token });
    expect(md.status).toBe(404);
    const docx = await api(env.app, "GET", `/v1/orgs/${orgId}/artifacts/${artifactId}/export?format=docx`, { token });
    expect(docx.status).toBe(404);
  });

  it("asks for a Google Drive connection before copying a file there", async () => {
    const up = await api(env.app, "POST", `/v1/orgs/${orgId}/files`, { token, body: { filename: "design.png", mime: "image/png", contentBase64: PNG } });
    const fileId = up.body.fileId;
    const r = await api(env.app, "POST", `/v1/orgs/${orgId}/files/${fileId}/drive`, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Connect Google Drive/);
    const nope = await api(env.app, "POST", `/v1/orgs/${orgId}/files/${uuidv7()}/drive`, { token });
    expect(nope.status).toBe(404);
  });

  it("lets the connect flow ask for the Drive scope as a feature", async () => {
    // Without platform Google credentials the provider is unconfigured (503);
    // the point is that the feature list is accepted, not rejected as input.
    const r = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/google/authorize`, { token, body: { features: ["drive"] } });
    expect([200, 503]).toContain(r.status);
    if (r.status === 200) expect(r.body.authorizeUrl).toContain(encodeURIComponent("auth/drive.file"));
  });
});
