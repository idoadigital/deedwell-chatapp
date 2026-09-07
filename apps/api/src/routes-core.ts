import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  SESSION_TTL_MS,
  verifyPassword,
} from "@deedwell/auth";
import { audit, tenantFileKey, uuidv7, withContext, invalidateMissionProfile } from "@deedwell/database";
import {
  AddMemberInput,
  CreateOrgInput,
  CreateProjectInput,
  LoginInput,
  ProvideInfoInput,
  RegisterInput,
  ResolveFactConflictInput,
  UploadFileInput,
} from "@deedwell/schemas";
import { extractDocumentText, extractFactsFromDocument, writeOrgFact } from "@deedwell/grant-domain";
import { emailOps, emailUser, enqueueEmail, orgNameOf, userRecipient } from "@deedwell/email";
import { HttpError, SESSION_COOKIE_NAME, type AppContext } from "./app.js";
import { requireTokens } from "./billing-gate.js";
import { proactiveNotificationItems } from "./routes-proactive.js";
import { taskNotificationItems } from "./tasks/store.js";

const MAX_FILE_BYTES = 8_000_000;

/**
 * Plants the session as a cookie shared across every *.deedwell.org origin —
 * this is what makes a login on deedwell.org carry over automatically to
 * coworkers.deedwell.org. Only set when SESSION_COOKIE_DOMAIN is configured
 * (real deployments); local dev has no real shared domain, so it's a no-op
 * there and the existing header-based token flow is unaffected either way.
 */
function setSessionCookie(reply: import("fastify").FastifyReply, token: string): void {
  const domain = process.env.SESSION_COOKIE_DOMAIN;
  if (!domain) return;
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    domain, path: "/", httpOnly: true, secure: true, sameSite: "lax",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

function clearSessionCookie(reply: import("fastify").FastifyReply): void {
  const domain = process.env.SESSION_COOKIE_DOMAIN;
  if (!domain) return;
  reply.clearCookie(SESSION_COOKIE_NAME, { domain, path: "/" });
}

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  // ---- auth ---------------------------------------------------------------

  app.post("/v1/auth/register", async (req, reply) => {
    const input = RegisterInput.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const userId = uuidv7();
    try {
      await deps.appPool.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1,$2,$3,$4)",
        [userId, input.email, passwordHash, input.displayName]
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new HttpError(409, "An account with this email already exists");
      }
      throw err;
    }
    const token = await createSession(deps.appPool, userId);
    setSessionCookie(reply, token);
    // Welcome mail + a heads-up to the team; neither can fail the signup.
    try {
      await enqueueEmail(deps.appPool, { kind: "welcome", payload: { displayName: input.displayName }, to: input.email, userId });
      await emailOps(deps.appPool, { title: "New signup", rows: [["Name", input.displayName], ["Email", input.email], ["User ID", userId]], tone: "ok" }, { dedupe: `ops:signup:${userId}` });
    } catch (err) {
      req.log.warn({ at: "email.enqueue_failed", err: String(err) });
    }
    return reply.status(201).send({ userId, token });
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const { rows } = await deps.appPool.query(
      "SELECT id, password_hash, suspended_at, must_change_password FROM users WHERE email = $1",
      [input.email]
    );
    // Same error for unknown email and wrong password.
    if (!rows[0] || !(await verifyPassword(input.password, rows[0].password_hash))) {
      throw new HttpError(401, "Invalid email or password");
    }
    if (rows[0].suspended_at) throw new HttpError(403, "This account has been suspended");
    const token = await createSession(deps.appPool, rows[0].id);
    setSessionCookie(reply, token);
    return { userId: rows[0].id, token, mustChangePassword: rows[0].must_change_password };
  });

  // ---- password reset ---------------------------------------------------
  // Both routes sit under /v1/auth/ (no session). The response never reveals
  // whether an account exists; the token is a 256-bit secret of which only
  // the hash is stored, single use, valid for RESET_TTL_MINUTES.
  const RESET_TTL_MINUTES = 60;
  app.post("/v1/auth/forgot-password", async (req) => {
    const { email } = req.body as { email?: string };
    if (typeof email !== "string" || !email.includes("@")) throw new HttpError(400, "An email address is required");
    const { rows } = await deps.appPool.query(
      "SELECT id, email, display_name, suspended_at FROM users WHERE email = $1", [email.trim()]
    );
    const user = rows[0];
    if (user && !user.suspended_at) {
      // At most three live links per hour per account — enough for a fumbled
      // inbox, not enough to be a mail cannon.
      const recent = await deps.appPool.query(
        "SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND created_at > now() - interval '1 hour'", [user.id]
      );
      if (Number(recent.rows[0]?.n ?? 0) < 3) {
        const { token, tokenHash } = generateSessionToken();
        await deps.appPool.query(
          "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
          [uuidv7(), user.id, tokenHash, new Date(Date.now() + RESET_TTL_MINUTES * 60_000)]
        );
        const origin = (process.env.APP_ORIGIN ?? "https://deedwell.org").replace(/\/+$/, "");
        await enqueueEmail(deps.appPool, {
          kind: "password_reset", to: user.email, userId: user.id,
          payload: { displayName: user.display_name, resetUrl: `${origin}/reset-password?token=${encodeURIComponent(token)}`, expiresMinutes: RESET_TTL_MINUTES },
        });
      }
      req.log.info({ at: "auth.password_reset_requested", userId: user.id });
    }
    return { ok: true };
  });

  app.post("/v1/auth/reset-password", async (req, reply) => {
    const { token, password } = req.body as { token?: string; password?: string };
    if (typeof token !== "string" || !token) throw new HttpError(400, "The reset link is missing its token");
    if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "A new password of at least 8 characters is required");
    const { rows } = await deps.appPool.query(
      `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.display_name, u.suspended_at
         FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
      [hashSessionToken(token)]
    );
    const row = rows[0];
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now() || row.suspended_at) {
      throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");
    }
    await deps.appPool.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [row.id]);
    await deps.appPool.query(
      "UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1",
      [row.user_id, await hashPassword(password)]
    );
    await deps.appPool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [row.user_id]);
    await enqueueEmail(deps.appPool, {
      kind: "password_changed", to: row.email, userId: row.user_id,
      payload: { displayName: row.display_name, sessionsRevoked: true },
    });
    req.log.info({ at: "auth.password_reset_completed", userId: row.user_id });
    const session = await createSession(deps.appPool, row.user_id);
    setSessionCookie(reply, session);
    return { userId: row.user_id, token: session };
  });

  // Deliberately NOT under /v1/auth/ — that whole prefix is exempted from
  // session resolution in app.ts's preHandler (so login/register can run
  // before any session exists), which would leave req.userId unset here.
  // A temp password from an admin still logs in via /v1/auth/login above;
  // this route is what forces the change afterward, gated by that session.
  app.post("/v1/me/change-password", async (req) => {
    if (!req.userId) throw new HttpError(401, "Authentication required");
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      throw new HttpError(400, "A new password of at least 8 characters is required");
    }
    const { rows } = await deps.appPool.query("SELECT password_hash FROM users WHERE id = $1", [req.userId]);
    if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
      throw new HttpError(401, "Current password is incorrect");
    }
    await deps.appPool.query(
      "UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1",
      [req.userId, await hashPassword(newPassword)]
    );
    const me = await userRecipient(deps.appPool, req.userId);
    if (me) {
      await enqueueEmail(deps.appPool, { kind: "password_changed", to: me.email, userId: me.userId, payload: { displayName: me.displayName, sessionsRevoked: false } })
        .catch((err) => req.log.warn({ at: "email.enqueue_failed", err: String(err) }));
    }
    return { ok: true };
  });

  /* The only profile field a person owns here. Email is the login identity and
   * changing it would need a re-verification flow this platform does not have,
   * so it is deliberately not editable — the settings page says as much rather
   * than offering an input that quietly does nothing. */
  app.patch("/v1/me", async (req) => {
    if (!req.userId) throw new HttpError(401, "Authentication required");
    const { displayName } = req.body as { displayName?: unknown };
    if (typeof displayName !== "string") throw new HttpError(400, "A display name is required");
    const name = displayName.trim();
    if (name.length < 1 || name.length > 120) {
      throw new HttpError(400, "Your name must be between 1 and 120 characters");
    }
    await deps.appPool.query("UPDATE users SET display_name = $2 WHERE id = $1", [req.userId, name]);
    return { ok: true, displayName: name };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const header = req.headers.authorization;
    const altToken = req.headers["x-deedwell-token"];
    const token = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : typeof altToken === "string" ? altToken : req.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await deps.appPool.query(
        "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
        [hashSessionToken(token)]
      );
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ---- me & orgs ----------------------------------------------------------

  app.get("/v1/me", async (req) => {
    const [user, orgs] = await Promise.all([
      deps.appPool.query("SELECT email, display_name, is_platform_admin FROM users WHERE id = $1", [req.userId]),
      withContext(deps.appPool, { tenantId: null, userId: req.userId }, (client) =>
        client.query(
          `SELECT o.id, o.slug, o.name, m.role
           FROM organizations o
           JOIN organization_memberships m ON m.tenant_id = o.id
           WHERE m.user_id = $1 ORDER BY o.name`,
          [req.userId]
        )
      ),
    ]);
    return {
      userId: req.userId,
      email: user.rows[0].email,
      displayName: user.rows[0].display_name,
      isPlatformAdmin: user.rows[0].is_platform_admin,
      organizations: orgs.rows,
    };
  });

  app.post("/v1/orgs", async (req, reply) => {
    const input = CreateOrgInput.parse(req.body);
    const orgId = uuidv7();
    await withContext(deps.appPool, { tenantId: orgId, userId: req.userId }, async (client) => {
      try {
        await client.query(
          "INSERT INTO organizations (id, slug, name, created_by) VALUES ($1,$2,$3,$4)",
          [orgId, input.slug, input.name, req.userId]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(409, "This organization slug is already taken");
        }
        throw err;
      }
      await client.query(
        "INSERT INTO organization_memberships (id, tenant_id, user_id, role) VALUES ($1,$2,$3,'owner')",
        [uuidv7(), orgId, req.userId]
      );
      await audit(client, {
        tenantId: orgId, actorUser: req.userId, action: "org.created",
        entityType: "organization", entityId: orgId, metadata: { slug: input.slug },
      });
      const owner = req.userId ? await userRecipient(client, req.userId) : null;
      if (owner) {
        await enqueueEmail(client, {
          kind: "workspace_created", to: owner.email, tenantId: orgId, userId: owner.userId,
          payload: { displayName: owner.displayName, orgName: input.name, orgSlug: input.slug },
        });
        await emailOps(client, {
          title: `New workspace: ${input.name}`, tone: "ok",
          rows: [["Workspace", input.name], ["Slug", input.slug], ["Owner", `${owner.displayName} <${owner.email}>`], ["Org ID", orgId]],
        }, { tenantId: orgId, dedupe: `ops:org:${orgId}` });
      }
    });
    return reply.status(201).send({ orgId });
  });

  app.post("/v1/orgs/:orgId/members", async (req, reply) => {
    ctx.requireRole(req, "admin");
    const input = AddMemberInput.parse(req.body);
    if (input.role === "owner") throw new HttpError(403, "Ownership cannot be granted this way");
    const result = await ctx.inOrg(req, async (client) => {
      const user = await client.query("SELECT id FROM users WHERE email = $1", [input.email]);
      if (!user.rows[0]) throw new HttpError(404, "No account exists for that email");
      await client.query(
        `INSERT INTO organization_memberships (id, tenant_id, user_id, role) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [uuidv7(), req.orgId, user.rows[0].id, input.role]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "member.added",
        entityType: "user", entityId: user.rows[0].id, metadata: { role: input.role },
      });
      const orgName = await orgNameOf(client, req.orgId!);
      const adder = req.userId ? await userRecipient(client, req.userId) : null;
      const added = await userRecipient(client, user.rows[0].id);
      if (added) {
        await enqueueEmail(client, {
          kind: "added_to_workspace", to: added.email, tenantId: req.orgId!, userId: added.userId,
          payload: { displayName: added.displayName, orgName, role: input.role, addedBy: adder?.displayName ?? null },
        });
      }
      return { userId: user.rows[0].id };
    });
    return reply.status(201).send(result);
  });

  // ---- organization facts (evidence ledger seed) --------------------------

  app.get("/v1/orgs/:orgId/facts", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query("SELECT fact_key, value, status, updated_at FROM org_facts ORDER BY fact_key")
    );
    return { facts: rows };
  });

  app.post("/v1/orgs/:orgId/facts", async (req, reply) => {
    ctx.requireRole(req, "member");
    invalidateMissionProfile(req.orgId!);
    const input = ProvideInfoInput.parse(req.body);
    const conflicts: string[] = [];
    await ctx.inOrg(req, async (client) => {
      for (const fact of input.facts) {
        const value = Array.isArray(fact.value)
          ? fact.value.join(", ")
          : typeof fact.value === "boolean"
            ? fact.value ? "yes" : "no"
            : fact.value;
        const { conflict } = await writeOrgFact(client, {
          tenantId: req.orgId!, factKey: fact.key, value, status: "user_certified",
          certifiedBy: req.userId,
        });
        if (conflict) conflicts.push(fact.key);
      }
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "facts.certified",
        entityType: "org_facts", metadata: { keys: input.facts.map((f) => f.key), conflicts },
      });
    });
    return reply.status(201).send({ ok: true, conflicts });
  });

  // ---- projects & files ---------------------------------------------------

  app.post("/v1/orgs/:orgId/projects", async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = CreateProjectInput.parse(req.body);
    const projectId = uuidv7();
    await ctx.inOrg(req, async (client) => {
      await client.query(
        "INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,$3,$4,$5)",
        [projectId, req.orgId, input.name, input.type, req.userId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "project.created",
        entityType: "project", entityId: projectId, metadata: { type: input.type },
      });
    });
    return reply.status(201).send({ projectId });
  });

  // ---- usage summary (Settings -> Usage) -----------------------------------

  app.get("/v1/orgs/:orgId/usage/summary", async (req) => {
    ctx.requireRole(req, "member");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT coalesce(metadata->>'source', 'workflow') AS source, kind,
                sum(quantity) FILTER (WHERE created_at >= date_trunc('month', now())) AS this_month,
                sum(quantity) AS all_time
         FROM usage_ledger WHERE tenant_id = $1
         GROUP BY coalesce(metadata->>'source', 'workflow'), kind`,
        [req.orgId]
      )
    );
    const totals = { thisMonth: { modelTokens: 0, steps: 0 }, allTime: { modelTokens: 0, steps: 0 } };
    const bySource = { chat: { thisMonth: 0, allTime: 0 }, workflow: { thisMonth: 0, allTime: 0 } };
    for (const row of rows) {
      const thisMonth = Number(row.this_month ?? 0);
      const allTime = Number(row.all_time ?? 0);
      if (row.kind === "model_tokens") {
        totals.thisMonth.modelTokens += thisMonth;
        totals.allTime.modelTokens += allTime;
        const source = row.source === "chat" ? "chat" : "workflow";
        bySource[source].thisMonth += thisMonth;
        bySource[source].allTime += allTime;
      } else if (row.kind === "steps") {
        totals.thisMonth.steps += thisMonth;
        totals.allTime.steps += allTime;
      }
    }
    return { totals, bySource };
  });

  app.get("/v1/orgs/:orgId/projects", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query("SELECT id, name, type, status, created_at FROM projects ORDER BY created_at DESC")
    );
    return { projects: rows };
  });

  app.post("/v1/orgs/:orgId/projects/:projectId/files", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { projectId } = req.params as { projectId: string };
    const input = UploadFileInput.parse(req.body);
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.length === 0) throw new HttpError(400, "File is empty");
    if (content.length > MAX_FILE_BYTES) throw new HttpError(413, "File exceeds the 8 MB limit");

    const fileId = uuidv7();
    const storageKey = tenantFileKey(req.orgId!, fileId, input.filename);
    const result = await ctx.inOrg(req, async (client) => {
      const project = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      await deps.storage.put(storageKey, content);
      await client.query(
        `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [fileId, req.orgId, projectId, input.filename, input.mime, content.length,
         createHash("sha256").update(content).digest("hex"), storageKey, req.userId]
      );
      // The file also lives in the org's evidence library from day one — this
      // just records that its first use was here, not a separate concept.
      await client.query(
        `INSERT INTO file_links (id, tenant_id, file_id, project_id, linked_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv7(), req.orgId, fileId, projectId, req.userId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "file.uploaded",
        entityType: "file", entityId: fileId,
        metadata: { filename: input.filename, bytes: content.length },
      });
      return { fileId };
    });
    return reply.status(201).send(result);
  });

  // ---- evidence library: files reusable across every application ----------

  app.post("/v1/orgs/:orgId/files", async (req, reply) => {
    ctx.requireRole(req, "member");
    invalidateMissionProfile(req.orgId!);
    const input = UploadFileInput.parse(req.body);
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.length === 0) throw new HttpError(400, "File is empty");
    if (content.length > MAX_FILE_BYTES) throw new HttpError(413, "File exceeds the 8 MB limit");

    const fileId = uuidv7();
    const storageKey = tenantFileKey(req.orgId!, fileId, input.filename);
    const result = await ctx.inOrg(req, async (client) => {
      await deps.storage.put(storageKey, content);
      await client.query(
        `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
        [fileId, req.orgId, input.filename, input.mime, content.length,
         createHash("sha256").update(content).digest("hex"), storageKey, req.userId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "file.uploaded_to_library",
        entityType: "file", entityId: fileId,
        metadata: { filename: input.filename, bytes: content.length },
      });
      return { fileId };
    });
    return reply.status(201).send(result);
  });

  // Org-wide reference material, unambiguously "not tied to any one
  // application" (project_id IS NULL) — the Knowledge page's list. Distinct
  // from /files/library below, which answers a different question ("what
  // could I link to *this* project") and is driven by a projectId query.
  app.get("/v1/orgs/:orgId/knowledge", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT id, filename, mime, size_bytes, created_at FROM files
         WHERE project_id IS NULL ORDER BY created_at DESC`
      )
    );
    return { files: rows };
  });

  app.get("/v1/orgs/:orgId/files/library", async (req) => {
    ctx.requireRole(req, "viewer");
    const { projectId } = req.query as { projectId?: string };
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT f.id, f.filename, f.mime, f.size_bytes, f.created_at
         FROM files f
         WHERE NOT EXISTS (
           SELECT 1 FROM file_links fl WHERE fl.file_id = f.id AND fl.project_id = $1
         )
         ORDER BY f.created_at DESC`,
        [projectId ?? null]
      )
    );
    return { files: rows };
  });

  app.post("/v1/orgs/:orgId/projects/:projectId/files/:fileId/link", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { projectId, fileId } = req.params as { projectId: string; fileId: string };
    await ctx.inOrg(req, async (client) => {
      const [project, file] = await Promise.all([
        client.query("SELECT id FROM projects WHERE id = $1", [projectId]),
        client.query("SELECT id FROM files WHERE id = $1", [fileId]),
      ]);
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      if (!file.rows[0]) throw new HttpError(404, "File not found");
      await client.query(
        `INSERT INTO file_links (id, tenant_id, file_id, project_id, linked_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (file_id, project_id) DO NOTHING`,
        [uuidv7(), req.orgId, fileId, projectId, req.userId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "file.linked",
        entityType: "file", entityId: fileId, metadata: { projectId },
      });
    });
    return reply.status(201).send({ ok: true });
  });

  // ---- evidence: fact extraction with provenance, conflict resolution -----

  app.post("/v1/orgs/:orgId/files/:fileId/extract-facts", async (req, reply) => {
    ctx.requireRole(req, "member");
    await requireTokens(ctx, req);
    const { fileId } = req.params as { fileId: string };
    const file = await ctx.inOrg(req, (client) =>
      client.query("SELECT filename, storage_key FROM files WHERE id = $1", [fileId])
    );
    if (!file.rows[0]) throw new HttpError(404, "File not found");
    const raw = await deps.storage.get(file.rows[0].storage_key);
    const { text } = await extractDocumentText(raw, String(file.rows[0].filename));
    if (!text.trim()) throw new HttpError(422, "Could not extract any text from this document");

    const extraction = await extractFactsFromDocument(deps.provider, text);
    const written: string[] = [];
    const conflicts: string[] = [];
    await ctx.inOrg(req, async (client) => {
      for (const fact of extraction.facts) {
        const { conflict } = await writeOrgFact(client, {
          tenantId: req.orgId!, factKey: fact.key, value: fact.value, status: "verified",
          sourceFileId: fileId, sourceLocation: String(fact.sourceLocation.line),
          sourceQuote: fact.sourceLocation.quote, extractedByAgent: "grant.fact_extractor",
        });
        if (conflict) conflicts.push(fact.key); else written.push(fact.key);
      }
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "facts.extracted",
        entityType: "file", entityId: fileId,
        metadata: { written, conflicts, documentSummary: extraction.documentSummary },
      });
    });
    return reply.status(201).send({ written, conflicts, documentSummary: extraction.documentSummary });
  });

  app.get("/v1/orgs/:orgId/fact-conflicts", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT id, fact_key, current_value, current_status, proposed_value, proposed_status,
                proposed_source_quote, created_at
         FROM org_fact_conflicts WHERE status = 'open' ORDER BY created_at DESC`
      )
    );
    return { conflicts: rows };
  });

  app.post("/v1/orgs/:orgId/fact-conflicts/:conflictId/resolve", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { conflictId } = req.params as { conflictId: string };
    const input = ResolveFactConflictInput.parse(req.body);
    await ctx.inOrg(req, async (client) => {
      const found = await client.query(
        "SELECT * FROM org_fact_conflicts WHERE id = $1 AND status = 'open'", [conflictId]
      );
      const row = found.rows[0];
      if (!row) throw new HttpError(404, "Open conflict not found");

      const resolvedValue = input.resolution === "use_proposed" ? row.proposed_value : row.current_value;
      if (input.resolution === "use_proposed") {
        await writeOrgFact(client, {
          tenantId: req.orgId!, factKey: row.fact_key, value: row.proposed_value,
          status: row.proposed_status, sourceFileId: row.proposed_source_file_id,
          sourceQuote: row.proposed_source_quote,
          extractedByAgent: row.proposed_status === "verified" ? "grant.fact_extractor" : null,
          certifiedBy: row.proposed_status === "user_certified" ? req.userId : null,
          force: true,
        });
      }
      await client.query(
        `UPDATE org_fact_conflicts
         SET status = 'resolved', resolved_value = $2, resolved_by = $3, resolved_at = now()
         WHERE id = $1`,
        [conflictId, resolvedValue, req.userId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "facts.conflict_resolved",
        entityType: "org_fact_conflicts", entityId: conflictId, metadata: { resolution: input.resolution },
      });
    });
    return reply.status(200).send({ ok: true });
  });

  // ---- notifications: live-computed, no persisted table ---------------------
  // Always reflects current truth (a resolved item just disappears) rather
  // than a notification log that could drift out of sync with real state.

  app.get("/v1/orgs/:orgId/notifications", async (req) => {
    ctx.requireRole(req, "viewer");
    const items = await ctx.inOrg(req, async (client) => {
      const waiting = await client.query(
        `SELECT r.id AS run_id, r.project_id, p.name AS project_name, r.status,
                r.current_step, r.state->'waiting' AS waiting, r.updated_at
         FROM workflow_runs r JOIN projects p ON p.id = r.project_id
         WHERE p.tenant_id = $1 AND r.status IN ('waiting_for_info','waiting_approval')
         ORDER BY r.updated_at DESC LIMIT 20`,
        [req.orgId]
      );
      const approvals = await client.query(
        `SELECT a.id, a.kind, a.run_id, r.project_id, p.name AS project_name, a.created_at
         FROM approvals a JOIN workflow_runs r ON r.id = a.run_id JOIN projects p ON p.id = r.project_id
         WHERE p.tenant_id = $1 AND a.status = 'pending' ORDER BY a.created_at DESC LIMIT 20`,
        [req.orgId]
      );
      const href = (projectName: string) => (projectName === "Google Ad Grant" ? "/dashboard/ad-grants" : null);
      // Proactive agent messages join the same list, each linking to its message.
      const proactive = await proactiveNotificationItems(client, req.orgId!, req.userId!).catch(() => []);
      const tasks = await taskNotificationItems(client, req.orgId!).catch(() => []);
      return [
        ...proactive,
        ...tasks,
        ...waiting.rows.map((r) => ({
          id: `run:${r.run_id}`, kind: "waiting_info", projectName: r.project_name,
          title: `${r.project_name} needs your input`,
          detail: r.current_step ? r.current_step.replace(/_/g, " ") : null,
          href: href(r.project_name), createdAt: r.updated_at,
        })),
        ...approvals.rows.map((a) => ({
          id: `approval:${a.id}`, kind: "waiting_approval", projectName: a.project_name,
          title: `${a.project_name} has something awaiting your approval`,
          detail: a.kind.replace(/_/g, " "), href: href(a.project_name), createdAt: a.created_at,
        })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });
    return { items };
  });

  // ---- Co-Workers unread indicator ------------------------------------------
  // One "last seen" heartbeat per membership, not per-channel read state —
  // enough signal for a dashboard badge, not a full unread inbox.

  app.post("/v1/orgs/:orgId/coworkers-seen", async (req) => {
    ctx.requireRole(req, "viewer");
    await ctx.inOrg(req, (client) =>
      client.query(
        `UPDATE organization_memberships SET coworkers_last_seen_at = now() WHERE tenant_id = $1 AND user_id = $2`,
        [req.orgId, req.userId]
      )
    );
    return { ok: true };
  });

  app.get("/v1/orgs/:orgId/coworkers-unread", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT count(*)::int AS count FROM messages m JOIN channels c ON c.id = m.channel_id
         WHERE c.tenant_id = $1 AND m.author_kind != 'system'
           AND (m.author_user IS NULL OR m.author_user != $2)
           AND m.created_at > coalesce(
             (SELECT coworkers_last_seen_at FROM organization_memberships WHERE tenant_id = $1 AND user_id = $2),
             '-infinity'
           )`,
        [req.orgId, req.userId]
      )
    );
    return { count: rows[0]?.count ?? 0 };
  });

  // ---- admin<->org support messages (org-facing side) ------------------------

  app.get("/v1/orgs/:orgId/support/messages", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT m.id, m.author_kind, m.author_user_id, m.body, m.created_at
         FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
         WHERE t.tenant_id = $1 ORDER BY m.created_at ASC`,
        [req.orgId]
      )
    );
    return { messages: rows };
  });

  app.post("/v1/orgs/:orgId/support/messages", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { body } = req.body as { body?: string };
    if (!body?.trim()) throw new HttpError(400, "Message body is required");
    const id = await ctx.inOrg(req, async (client) => {
      const existing = await client.query(`SELECT id FROM support_threads WHERE tenant_id = $1`, [req.orgId]);
      const threadId = existing.rows[0]?.id ?? uuidv7();
      if (!existing.rows[0]) {
        await client.query(`INSERT INTO support_threads (id, tenant_id) VALUES ($1,$2)`, [threadId, req.orgId]);
      }
      const messageId = uuidv7();
      await client.query(
        `INSERT INTO support_messages (id, tenant_id, thread_id, author_kind, author_user_id, body)
         VALUES ($1,$2,$3,'org_user',$4,$5)`,
        [messageId, req.orgId, threadId, req.userId, body.trim()]
      );
      const orgName = await orgNameOf(client, req.orgId!);
      const author = req.userId ? await userRecipient(client, req.userId) : null;
      if (author) {
        await enqueueEmail(client, {
          kind: "support_received", to: author.email, tenantId: req.orgId!, userId: author.userId,
          payload: { displayName: author.displayName, orgName, body: body.trim() },
        });
      }
      await emailOps(client, {
        title: `Support request from ${orgName}`, tone: "warn", body: body.trim().slice(0, 2000),
        rows: [["Workspace", orgName], ["From", author ? `${author.displayName} <${author.email}>` : "unknown"], ["Org ID", req.orgId!]],
      }, { tenantId: req.orgId! });
      return messageId;
    });
    return reply.status(201).send({ id });
  });

  app.post("/v1/orgs/:orgId/support/seen", async (req) => {
    ctx.requireRole(req, "viewer");
    await ctx.inOrg(req, (client) =>
      client.query(
        `UPDATE organization_memberships SET support_last_seen_at = now() WHERE tenant_id = $1 AND user_id = $2`,
        [req.orgId, req.userId]
      )
    );
    return { ok: true };
  });
}

async function createSession(pool: AppContext["deps"]["appPool"], userId: string): Promise<string> {
  const { token, tokenHash } = generateSessionToken();
  await pool.query(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
    [uuidv7(), userId, tokenHash, new Date(Date.now() + SESSION_TTL_MS)]
  );
  return token;
}
