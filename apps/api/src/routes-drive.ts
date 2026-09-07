import type { FastifyInstance } from "fastify";
import { encryptSecret } from "@deedwell/auth";
import { GoogleConnectionError, GOOGLE_SCOPE } from "@deedwell/connectors";
import { emailOrgAdmins, orgNameOf } from "@deedwell/email";
import { HttpError, type AppContext } from "./app.js";
import { artifactTypeLabel, renderArtifactPdf } from "./artifact-pdf.js";

/**
 * "Open in Google Drive" for a stored file. The file is copied into the
 * Drive of the organization's connected Google account — under the
 * drive.file scope, which only ever reaches files Deedwell itself created —
 * and its Drive link is returned. A file already copied is found again by
 * the app property stamped on it, so opening twice does not make two copies.
 */
export const DRIVE_SCOPE = GOOGLE_SCOPE.driveFile;
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export function registerDriveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  /** A stored file (an image from Content Studio, an upload) → Drive. */
  app.post("/v1/orgs/:orgId/files/:fileId/drive", async (req) => {
    ctx.requireRole(req, "member");
    const { fileId } = req.params as { fileId: string };
    const file = await ctx.inOrg(req, async (client) =>
      (await client.query("SELECT id, filename, mime, storage_key FROM files WHERE id = $1", [fileId])).rows[0] as Record<string, any> | undefined
    );
    if (!file) throw new HttpError(404, "File not found");
    return copyToDrive(ctx, req, {
      key: { deedwellFileId: fileId },
      name: String(file.filename), mime: String(file.mime),
      bytes: () => deps.storage.get(String(file.storage_key)),
    });
  });

  /** A written document (any artifact) → Drive, as the same PDF the export
   *  route renders. One Drive file per artifact version: opening v3 twice
   *  finds the first copy, opening v4 makes a new one. */
  app.post("/v1/orgs/:orgId/artifacts/:artifactId/drive", async (req) => {
    ctx.requireRole(req, "member");
    const { artifactId } = req.params as { artifactId: string };
    const { version } = (req.body ?? {}) as { version?: unknown };
    const wanted = typeof version === "number" && Number.isInteger(version) ? version : null;
    const found = await ctx.inOrg(req, async (client) =>
      (await client.query(
        `SELECT a.type, a.title, av.version, av.content, av.created_at, o.name AS org_name,
                av.content->>'pdfStorageKey' AS pdf_key
           FROM artifacts a
           JOIN artifact_versions av ON av.artifact_id = a.id AND av.version = COALESCE($2::int, a.current_version)
           JOIN organizations o ON o.id = a.tenant_id
          WHERE a.id = $1`,
        [artifactId, wanted]
      )).rows[0] as Record<string, any> | undefined
    );
    if (!found) throw new HttpError(404, "Artifact not found");
    const title = String(found.title || artifactTypeLabel(found.type));
    const name = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || "Document"}.pdf`;
    return copyToDrive(ctx, req, {
      key: { deedwellArtifactId: artifactId, deedwellVersion: String(found.version) },
      name, mime: "application/pdf",
      bytes: () => found.pdf_key
        ? deps.storage.get(String(found.pdf_key))
        : renderArtifactPdf({
          title, type: String(found.type), orgName: String(found.org_name ?? ""),
          createdAt: found.created_at, version: found.version, content: found.content,
        }),
    });
  });
}

/** The org's Google connection with Drive access, tokens refreshed if due —
 *  all through the central GoogleConnectionService. 409 (with a message the
 *  dashboard turns into a Connect button) when there is none, it lacks the
 *  Drive scope, or it has expired: the same contract as before. */
async function driveAccess(ctx: AppContext, req: Parameters<AppContext["inOrg"]>[0]): Promise<{ accessToken: string; connectionId: string }> {
  try {
    const access = await ctx.inOrg(req, (client) =>
      ctx.deps.googleConnections.require(client, req.orgId!, { scopes: [DRIVE_SCOPE], actorUserId: req.userId ?? null, feature: "drive" })
    );
    return { accessToken: access.accessToken, connectionId: access.connectionId };
  } catch (err) {
    if (err instanceof GoogleConnectionError) {
      if (err.code === "not_connected" || err.code === "missing_scopes") throw new HttpError(409, "Connect Google Drive to open files there.");
      if (err.code === "expired") throw new HttpError(409, "The Google connection expired — reconnect Google Drive and try again.");
      throw new HttpError(503, err.message);
    }
    throw err;
  }
}

/** Finds the Drive copy stamped with `key`, or uploads one. */
async function copyToDrive(
  ctx: AppContext, req: Parameters<AppContext["inOrg"]>[0],
  input: { key: Record<string, string>; name: string; mime: string; bytes: () => Promise<Buffer> }
): Promise<{ url: string; driveFileId: string; created: boolean }> {
  const { accessToken, connectionId } = await driveAccess(ctx, req);
  const existing = await findExisting(accessToken, input.key);
  if (existing) return { url: existing.webViewLink, driveFileId: existing.id, created: false };
  const bytes = await input.bytes();
  const uploaded = await upload(accessToken, {
    name: input.name, mime: input.mime, bytes,
    appProperties: { ...input.key, deedwellOrgId: req.orgId! },
  }).catch(async (err) => {
    const message = String((err as Error).message ?? err);
    req.log.warn({ err }, "drive: upload failed");
    if (/\(401\)|\(403\)/.test(message)) {
      await ctx.inOrg(req, (client) =>
        ctx.deps.googleConnections.markNeedsAttention(client, req.orgId!, connectionId, "Reconnect Google to keep using Google Drive.", req.userId ?? null)
      ).catch(() => undefined);
      throw new HttpError(409, "Google Drive no longer accepts this connection — reconnect Google Drive and try again.");
    }
    throw new HttpError(502, "Could not copy that file to Google Drive just now.");
  });
  return { url: uploaded.webViewLink, driveFileId: uploaded.id, created: true };
}

async function findExisting(accessToken: string, key: Record<string, string>): Promise<{ id: string; webViewLink: string } | null> {
  const clauses = Object.entries(key).map(([k, v]) => `appProperties has { key='${k.replace(/[^A-Za-z]/g, "")}' and value='${v.replace(/[^0-9A-Za-z-]/g, "")}' }`);
  const q = `${clauses.join(" and ")} and trashed = false`;
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
