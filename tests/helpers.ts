import type { FastifyInstance } from "fastify";
import { createAdminPool, migrate } from "@deedwell/database";
import { buildApp } from "../apps/api/src/app.js";
import { createDeps, type Deps } from "../apps/api/src/bootstrap.js";
import type { Pool } from "pg";

const ALL_TABLES = [
  "usage_ledger", "audit_events", "org_facts", "grant_requirements", "grant_opportunities",
  "artifact_versions", "artifacts", "tool_invocations", "approvals", "workflow_steps",
  "workflow_runs", "files", "projects", "invitations", "organization_memberships",
  "organizations", "sessions", "users",
];

export interface TestEnv {
  deps: Deps;
  app: FastifyInstance;
  adminPool: Pool;
  close(): Promise<void>;
}

export async function createTestEnv(
  depOverrides: Partial<Parameters<typeof createDeps>[0]> = {}
): Promise<TestEnv> {
  const adminPool = createAdminPool();
  await migrate(adminPool);
  await adminPool.query(`TRUNCATE ${ALL_TABLES.join(", ")} CASCADE`);
  // Retries should be instant in tests.
  const deps = await createDeps({ backoffMs: () => 0, ...depOverrides });
  const app = buildApp(deps);
  await app.ready();
  return {
    deps,
    app,
    adminPool,
    async close() {
      await app.close();
      await deps.appPool.end();
      await deps.adminPool.end();
      await adminPool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP convenience wrappers around app.inject
// ---------------------------------------------------------------------------

export async function api(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: any; raw: string }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    payload: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    /* non-JSON (e.g. markdown export) */
  }
  return { status: res.statusCode, body, raw: res.body };
}

export async function registerUser(
  app: FastifyInstance,
  email: string
): Promise<{ userId: string; token: string }> {
  const res = await api(app, "POST", "/v1/auth/register", {
    body: { email, password: "correct-horse-battery", displayName: email.split("@")[0] },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.raw}`);
  return res.body;
}

export async function createOrg(
  app: FastifyInstance,
  token: string,
  slug: string
): Promise<string> {
  const res = await api(app, "POST", "/v1/orgs", {
    token,
    body: { name: `Org ${slug}`, slug },
  });
  if (res.status !== 201) throw new Error(`org create failed: ${res.raw}`);
  return res.body.orgId;
}

export const SAMPLE_GRANT_DOC = `Community Youth Development Grant Program
Notice of Funding Opportunity — CYD-2026-014

Applicants must be a registered 501(c)(3) nonprofit organization to be eligible.
Applicants must describe the target population in a narrative statement of no more than 500 words.
The project budget must not exceed $150,000 and must include a line-item budget justification.
Applications must be submitted by the deadline of September 30, 2026.
Applicants should include letters of support from community partners.
The narrative should demonstrate measurable outcomes for youth participants.
All attachments must be submitted in PDF format.
`;

export async function uploadDoc(
  app: FastifyInstance,
  token: string,
  orgId: string,
  projectId: string,
  content: string
): Promise<string> {
  const res = await api(app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/files`, {
    token,
    body: {
      filename: "opportunity.txt",
      mime: "text/plain",
      contentBase64: Buffer.from(content, "utf8").toString("base64"),
    },
  });
  if (res.status !== 201) throw new Error(`upload failed: ${res.raw}`);
  return res.body.fileId;
}

/** Standard slice setup: user + org + project + uploaded document + started run. */
export async function startSlice(
  env: TestEnv,
  slug: string,
  doc = SAMPLE_GRANT_DOC
): Promise<{
  token: string;
  userId: string;
  orgId: string;
  projectId: string;
  fileId: string;
  runId: string;
  opportunityId: string;
}> {
  const { app } = env;
  const { userId, token } = await registerUser(app, `${slug}@example.org`);
  const orgId = await createOrg(app, token, slug);
  const project = await api(app, "POST", `/v1/orgs/${orgId}/projects`, {
    token,
    body: { name: "CYD 2026 Application", type: "grant_application" },
  });
  const projectId = project.body.projectId;
  const fileId = await uploadDoc(app, token, orgId, projectId, doc);
  const started = await api(app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/grant-slice`, {
    token,
    body: {
      fileId,
      opportunityTitle: "Community Youth Development Grant",
      funder: "Example Community Foundation",
      sectionTitle: "Statement of Need",
    },
  });
  if (started.status !== 201) throw new Error(`slice start failed: ${started.raw}`);
  return { token, userId, orgId, projectId, fileId, ...started.body };
}
