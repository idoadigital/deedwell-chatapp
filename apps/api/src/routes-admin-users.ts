import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { hashPassword } from "@deedwell/auth";
import { uuidv7 } from "@deedwell/database";
import { HttpError, type AppContext } from "./app.js";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Platform-wide user management — genuinely new (no cross-org user list or
 * management action existed before this). "Delete" is deliberately a
 * deactivation (same effect as suspend), never a row DELETE: users.id is
 * referenced by NOT NULL foreign keys across every project/message/
 * artifact/audit_events row a user has ever touched, in every org — a real
 * DELETE would either violate those constraints or silently orphan
 * historical org data.
 */
export function registerAdminUsersRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/users", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT u.id, u.email, u.display_name, u.is_platform_admin, u.suspended_at,
              u.must_change_password, u.created_at,
              coalesce(
                json_agg(json_build_object('id', o.id, 'name', o.name, 'role', m.role))
                  FILTER (WHERE o.id IS NOT NULL),
                '[]'
              ) AS orgs
       FROM users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
       LEFT JOIN organizations o ON o.id = m.tenant_id
       GROUP BY u.id ORDER BY u.created_at DESC`
    );
    return { users: rows };
  });

  app.post("/v1/admin/users", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const { email, displayName, orgId, role } = req.body as {
      email?: string; displayName?: string; orgId?: string; role?: string;
    };
    if (!email?.trim() || !displayName?.trim()) throw new HttpError(400, "email and displayName are required");
    const tempPassword = generateTempPassword();
    const userId = uuidv7();
    try {
      await ctx.deps.adminPool.query(
        `INSERT INTO users (id, email, password_hash, display_name, must_change_password)
         VALUES ($1,$2,$3,$4,true)`,
        [userId, email.trim().toLowerCase(), await hashPassword(tempPassword), displayName.trim()]
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "A user with that email already exists");
      throw err;
    }
    if (orgId) {
      await ctx.deps.adminPool.query(
        `INSERT INTO organization_memberships (id, tenant_id, user_id, role) VALUES ($1,$2,$3,$4)`,
        [uuidv7(), orgId, userId, role || "member"]
      );
    }
    req.log.info({ at: "admin.user_created", userId, email, createdBy: req.userId });
    return reply.status(201).send({ userId, tempPassword });
  });

  app.patch("/v1/admin/users/:userId", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { userId } = req.params as { userId: string };
    const { displayName, email } = req.body as { displayName?: string; email?: string };
    const { rowCount } = await ctx.deps.adminPool.query(
      `UPDATE users SET
         display_name = coalesce($2, display_name),
         email = coalesce($3, email)
       WHERE id = $1`,
      [userId, displayName?.trim() || null, email?.trim().toLowerCase() || null]
    );
    if (!rowCount) throw new HttpError(404, "User not found");
    req.log.info({ at: "admin.user_updated", userId, updatedBy: req.userId });
    return { ok: true };
  });

  async function setSuspended(req: FastifyRequest, suspended: boolean) {
    const { userId } = req.params as { userId: string };
    const { rowCount } = await ctx.deps.adminPool.query(
      `UPDATE users SET suspended_at = ${suspended ? "now()" : "NULL"} WHERE id = $1`,
      [userId]
    );
    if (!rowCount) throw new HttpError(404, "User not found");
    if (suspended) {
      // Takes effect immediately, not just on the next login attempt.
      await ctx.deps.adminPool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    }
    req.log.info({ at: suspended ? "admin.user_suspended" : "admin.user_reactivated", userId, actorId: req.userId });
    return { ok: true };
  }

  app.post("/v1/admin/users/:userId/suspend", async (req) => {
    ctx.requirePlatformAdmin(req);
    return setSuspended(req, true);
  });

  app.post("/v1/admin/users/:userId/reactivate", async (req) => {
    ctx.requirePlatformAdmin(req);
    return setSuspended(req, false);
  });

  app.delete("/v1/admin/users/:userId", async (req) => {
    ctx.requirePlatformAdmin(req);
    return setSuspended(req, true);
  });

  app.post("/v1/admin/users/:userId/set-temp-password", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { userId } = req.params as { userId: string };
    const tempPassword = generateTempPassword();
    const { rowCount } = await ctx.deps.adminPool.query(
      `UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1`,
      [userId, await hashPassword(tempPassword)]
    );
    if (!rowCount) throw new HttpError(404, "User not found");
    await ctx.deps.adminPool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    req.log.info({ at: "admin.user_temp_password_set", userId, actorId: req.userId });
    return { tempPassword };
  });

  app.post("/v1/admin/users/:userId/set-platform-admin", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { userId } = req.params as { userId: string };
    const { value } = req.body as { value?: boolean };
    const { rowCount } = await ctx.deps.adminPool.query(
      `UPDATE users SET is_platform_admin = $2 WHERE id = $1`,
      [userId, Boolean(value)]
    );
    if (!rowCount) throw new HttpError(404, "User not found");
    req.log.info({ at: "admin.user_platform_admin_set", userId, value: Boolean(value), actorId: req.userId });
    return { ok: true };
  });
}
