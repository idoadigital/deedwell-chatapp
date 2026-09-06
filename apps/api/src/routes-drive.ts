import type { FastifyInstance } from "fastify";
import { encryptSecret } from "@deedwell/auth";
import { getProvider, unseal, type OAuthTokens } from "@deedwell/connectors";
import { HttpError, type AppContext } from "./app.js";

/**
 * "Open in Google Drive" for a stored file. The file is copied into the
 * Drive of the organization's connected Google account — under the
 * drive.file scope, which only ever reaches files Deedwell itself created —
 * and its Drive link is returned. A file already copied is found again by
 * the app property stamped on it, so opening twice does not make two copies.
 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export function registerDriveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.post("/v1/orgs/:orgId/files/:fileId/drive", async (req) => {
    ctx.requireRole(req, "member");
    const { fileId } = req.params as { fileId: string };
    const { file, connection } = await ctx.inOrg(req, async (client) => {
      const f = await client.query("SELECT id, filename, mime, storage_key FROM files WHERE id = $1", [fileId]);
      const c = await client.query(
        `SELECT * FROM connector_connections
          WHERE provider = 'google' AND connector_type = 'google_account' AND status = 'connected' AND $1 = ANY(scopes)
          ORDER BY created_at DESC LIMIT 1`,
        [DRIVE_SCOPE]
      );
      return { file: f.rows[0] as Record<string, any> | undefined, connection: c.rows[0] as Record<string, any> | undefined };
    });
    if (!file) throw new HttpError(404, "File not found");
    if (!connection) throw new HttpError(409, "Connect Google Drive to open files there.");

    const provider = await getProvider(deps.appPool, "google");
    if (!provider?.refresh) throw new HttpError(503, "Google connections are temporarily unavailable.");
    let tokens = unseal(connection);
    const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : 0;
    if (expiresAt && expiresAt < Date.now() + 60_000) {
      try { tokens = await provider.refresh(tokens); }
      catch (err) {
        req.log.warn({ err }, "drive: google refresh failed");
        await markNeedsAttention(ctx, req, connection.id);
        throw new HttpError(409, "The Google connection expired — reconnect Google Drive and try again.");
      }
      await persistAccessToken(ctx, req, connection.id, tokens);
    }

    const existing = await findExisting(tokens.accessToken, fileId);
    if (existing) return { url: existing.webViewLink, driveFileId: existing.id, created: false };

    const bytes = await deps.storage.get(String(file.storage_key));
    const uploaded = await upload(tokens.accessToken, {
      name: String(file.filename), mime: String(file.mime), bytes,
      appProperties: { deedwellFileId: fileId, deedwellOrgId: req.orgId! },
    }).catch(async (err) => {
      const message = String((err as Error).message ?? err);
      req.log.warn({ err }, "drive: upload failed");
      if (/\(401\)|\(403\)/.test(message)) {
        await markNeedsAttention(ctx, req, connection.id);
        throw new HttpError(409, "Google Drive no longer accepts this connection — reconnect Google Drive and try again.");
      }
      throw new HttpError(502, "Could not copy that file to Google Drive just now.");
    });
    return { url: uploaded.webViewLink, driveFileId: uploaded.id, created: true };
  });
}

async function findExisting(accessToken: string, fileId: string): Promise<{ id: string; webViewLink: string } | null> {
  const q = `appProperties has { key='deedwellFileId' and value='${fileId.replace(/[^0-9a-f-]/g, "")}' } and trashed = false`;
  const res = await fetch(`${DRIVE_API}?${new URLSearchParams({ q, fields: "files(id,webViewLink)", pageSize: "1", spaces: "drive" })}`, {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { files?: Array<{ id: string; webViewLink: string }> };
  return body.files?.[0] ?? null;
}

async function upload(accessToken: string, input: { name: string; mime: string; bytes: Buffer; appProperties: Record<string, string> }): Promise<{ id: string; webViewLink: string }> {
  const boundary = `deedwell-${Date.now().toString(36)}`;
  const meta = JSON.stringify({ name: input.name, mimeType: input.mime, appProperties: input.appProperties });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${input.mime}\r\n\r\n`),
    input.bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(`${DRIVE_UPLOAD}?${new URLSearchParams({ uploadType: "multipart", fields: "id,webViewLink" })}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}` },
    body, signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Drive upload failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const out = (await res.json()) as { id: string; webViewLink: string };
  if (!out.id || !out.webViewLink) throw new Error("Drive upload returned no link");
  return out;
}

async function persistAccessToken(ctx: AppContext, req: Parameters<AppContext["inOrg"]>[0], id: string, tokens: OAuthTokens): Promise<void> {
  const access = encryptSecret(Buffer.from(tokens.accessToken, "utf8"));
  await ctx.inOrg(req, (client) =>
    client.query(
      `UPDATE connector_connections SET encrypted_access_token = $2, access_iv = $3, access_tag = $4, key_version = $5, token_expires_at = $6 WHERE id = $1`,
      [id, access.ciphertext, access.iv, access.tag, access.keyVersion, tokens.expiresAt ?? null]
    )
  );
}

async function markNeedsAttention(ctx: AppContext, req: Parameters<AppContext["inOrg"]>[0], id: string): Promise<void> {
  await ctx.inOrg(req, (client) =>
    client.query(`UPDATE connector_connections SET status = 'needs_attention', status_detail = $2 WHERE id = $1`, [id, "Reconnect Google to keep using Google Drive."])
  ).catch(() => {});
}
