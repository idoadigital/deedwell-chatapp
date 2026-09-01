import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  SESSION_TTL_MS,
  verifyPassword,
} from "@deedwell/auth";
import { audit, tenantFileKey, uuidv7, withContext } from "@deedwell/database";
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
import { HttpError, SESSION_COOKIE_NAME, type AppContext } from "./app.js";

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
    return reply.status(201).send({ userId, token });
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const { rows } = await deps.appPool.query(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [input.email]
    );
    // Same error for unknown email and wrong password.
    if (!rows[0] || !(await verifyPassword(input.password, rows[0].password_hash))) {
      throw new HttpError(401, "Invalid email or password");
    }
    const token = await createSession(deps.appPool, rows[0].id);
    setSessionCookie(reply, token);
    return { userId: rows[0].id, token };
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
}

async function createSession(pool: AppContext["deps"]["appPool"], userId: string): Promise<string> {
  const { token, tokenHash } = generateSessionToken();
  await pool.query(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
    [uuidv7(), userId, tokenHash, new Date(Date.now() + SESSION_TTL_MS)]
  );
  return token;
}
