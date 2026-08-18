import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { withContext } from "@deedwell/database";
import { saveGoogleSession } from "@deedwell/adgrants-domain";
import { startGoogleConnectFlow, type RelayInputEvent } from "@deedwell/browser-automation";
import type { AppContext } from "./app.js";

function sha(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface ConnectSession {
  id: string;
  tenantId: string;
  runId: string;
  userId: string;
}

async function redeemToken(ctx: AppContext, token: string): Promise<ConnectSession | null> {
  if (!token || token.length > 128) return null;
  const { rows } = await ctx.deps.adminPool.query(
    `UPDATE google_connect_sessions SET status = 'active'
     WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
     RETURNING id, tenant_id, run_id, user_id`,
    [sha(token)]
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, tenantId: rows[0].tenant_id, runId: rows[0].run_id, userId: rows[0].user_id };
}

/**
 * The "connect your Google account" live view — a fresh headless Chromium
 * context streamed to the browser, with the user's real mouse/keyboard
 * relayed back in. The org's user types their real Google credentials
 * directly into Google's real page, rendered pixel-for-pixel: this server
 * only ever forwards raw input events into a page it does not parse for
 * credential content. All Playwright/CDP mechanics live in
 * @deedwell/browser-automation — this file is WS plumbing only.
 */
export function registerAdGrantsConnectWs(app: FastifyInstance, ctx: AppContext): void {
  // A real headless browser is launched per connection — only wired up when
  // the automation is actually configured, same reasoning as bootstrap.ts's
  // lazy `google` service. Importing this module is always cheap (nothing
  // launches at import time); this flag check is what keeps it inert.
  if ((process.env.AD_GRANTS_AUTOMATION ?? "off") !== "on") return;

  void app.register(async (scope) => {
    await scope.register(websocket);
    scope.get("/v1/ad-grants/google-connect", { websocket: true }, async (connection, req) => {
      const socket = ((connection as unknown as { socket?: WebSocket }).socket ??
        (connection as unknown as WebSocket)) as WebSocket;
      const token = (req.query as { token?: string }).token ?? "";
      const session = await redeemToken(ctx, token);
      if (!session) {
        socket.send(JSON.stringify({ type: "error", error: "Invalid or expired connect session" }));
        socket.close();
        return;
      }

      const send = (msg: Record<string, unknown>) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      };

      const flow = await startGoogleConnectFlow({
        onFrame: (data) => send({ type: "frame", data }),
        onReady: () => send({ type: "ready" }),
        onError: (error) => send({ type: "error", error }),
        onConnected: ({ storageState }) => {
          void withContext(ctx.deps.appPool, { tenantId: session.tenantId, userId: session.userId }, async (client) => {
            await saveGoogleSession(client, {
              tenantId: session.tenantId,
              connectedBy: session.userId,
              accountHint: "Connected Google account",
              storageState,
            });
            await ctx.deps.adminPool.query(
              `UPDATE google_connect_sessions SET status = 'captured' WHERE id = $1`,
              [session.id]
            );
            await ctx.deps.engine.signal(client, session.runId, "info", { connected: true });
          }).then(
            () => {
              send({ type: "connected" });
              socket.close();
            },
            (err: unknown) => send({ type: "error", error: err instanceof Error ? err.message : "Could not save the connected session" })
          );
        },
      });

      socket.on("message", (raw) => {
        let msg: { type: string } & Partial<RelayInputEvent>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "input") flow.submitInput(msg as unknown as RelayInputEvent);
      });
      socket.on("close", () => void flow.close());
    });
  });
}
