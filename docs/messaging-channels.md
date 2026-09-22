# WhatsApp and Telegram as interfaces into the Deedwell agent runtime

_Architecture review and design, 2026-09-22. Phase 1 deliverable of the
messaging-channels work; the later phases build exactly this._

## 1. What exists (and is reused unchanged)

| Concern | Where it lives today | How the channels use it |
|---|---|---|
| Agent orchestration | `apps/api/src/assistant.ts` → `handleUserMessage(deps, client, ids, channel, body, fileId, clientKey, …)`: inserts the user message, builds context (transcript, artifacts, tasks, memory), classifies intent (answer / clarify / create_task / search_grants / start_grant_application / build_website / update_website / create_content / provide_info / approve / reject / status), runs tools and workflows, inserts agent replies. `@Name` addressing via `mentionedTeammate()`. | Every external message is fed to `handleUserMessage` under the tenant, with `clientKey` = the provider message id (its built-in idempotency). No second router. |
| Conversations | `channels` (tenant-scoped, RLS; kinds team/project/dm; `dm:<agentKey>` keys) and `messages` (author_kind user/agent/system, `metadata` jsonb). Web reads `/channels/:id/messages`, live updates via `engine.events` → SSE (`message_created`). | One linked channel per (tenant, user, external channel): kind `dm`, `agent_key = core.executive_assistant`, new columns `source` and `external_connection_id`. Web shows it with a WhatsApp/Telegram badge; the user can continue it from the web. |
| Async follow-ups | Workflows post into channels later (approval requests, "the website is live") through `insertMessage` in assistant.ts and `postAgentMessage` in `tasks/chat.ts`; proactive agent messages via `proactive/orchestrator.ts#deliverCandidate`. | Outbound mirroring hooks these three insert points (`relayMessage`), so anything an agent says in a linked channel — synchronous or hours later — reaches the phone. |
| Approvals | `approvals` rows + `engine.signal(run, "approval", …)`; chat handles "approve"/"reject" intents against `context.pendingApprovals`; task approvals via `decideTaskFromChat`. | Approval messages carry `metadata.approvalId`; the outbound adapter renders Approve / Review / Cancel buttons (Telegram inline keyboard, WhatsApp interactive reply buttons). A button press is turned into the text "approve"/"reject" and goes through the same intent path — the existing approval model is untouched and every decision is audited with `via: "telegram"`/`"whatsapp"`. |
| Tenancy / auth | `withContext(pool, {tenantId,userId}, fn)` sets `app.tenant_id` for RLS; routes use `ctx.inOrg` + `ctx.requireRole`; cross-tenant workers use `adminPool`. Unauthenticated provider endpoints are allow-listed in `app.ts` (Stripe webhook pattern: scoped raw-body parser). | Webhooks are allow-listed under `/v1/integrations/*`, verify the provider signature, persist, and return 200. Processing runs in a worker inside `withContext` for the resolved tenant + user. |
| Connectors | `connector_connections` (open `provider`, AES-GCM sealed tokens, RLS, one live row per account), `connector_oauth_states` (hashed single-use state), registry in `packages/connectors`, platform-level credentials in `platform_integrations` (Platform Admin → Integrations). Web: `dashboard/connectors/ConnectorsPage.jsx` + `registry.jsx`. | Telegram and WhatsApp are two more providers: connections are `connector_connections` rows (`provider` telegram/whatsapp); the platform bot token / Meta app secret live in `platform_integrations`; pairing tokens reuse `connector_oauth_states`. Cards, Manage dialog and status dots reuse the existing components. |
| Files / artifacts | `files` table + `deps.storage.put(tenantFileKey(...))`, 8 MB limit, `Shared Files` project; message `metadata.fileId` renders the attachment on web. | Inbound media is downloaded from the provider, MIME/size-validated, stored through the same path, and handed to `handleUserMessage` as `fileId`. Outbound: agent messages that reference a file/artifact/image are sent as media where the channel supports it. |
| Audit / activity | `audit(client, {tenantId, actorUser, action, entityType, entityId, metadata})` (hash-chained `audit_events`), `workspace_events`, Activity UI. | Every inbound command that reaches the runtime is audited (`messaging.inbound`), and approvals decided from a phone carry `via`. Provider payloads are stored redacted in `messaging_events`, not in the audit chain. |
| Metering | `usage_ledger` (kinds model_tokens/steps; the debit trigger fires only for model_tokens). | New kind `channel_message` (never debited) records inbound/outbound counts per tenant and channel; model spend already lands as `model_tokens` with `source: "chat"`. |
| Notifications | Proactive orchestrator decides `notify` (presence, daily cap, prefs) and emails; tasks post completion messages. | When `notify` is true and the user has a connection with notifications on, the same message is pushed to the phone (categories: agent messages, task completion, approval requests, critical). |
| Workers | `main.ts` starts publish/tasks/proactive/inbox/google-ads/site-domains workers with `*_WORKER=off` knobs, SKIP LOCKED claims on `adminPool`. | `MESSAGING_WORKER` processes the inbound queue and outbound deliveries with the same pattern. |

## 2. Flow

```
WhatsApp Cloud API / Telegram Bot API
  → POST /v1/integrations/{whatsapp,telegram}/webhook        (no session; signature / secret-token verified)
  → messaging_events INSERT (direction=in, status=received)  idempotent on (channel, external_message_id)
  → 200 OK
  → messaging worker claims the event
  → resolve identity: external user → messaging_identities → Deedwell user + active connection (tenant)
      · unknown identity → pairing help, nothing else
      · user in several workspaces → /workspace picker (persisted on the identity)
  → withContext(tenant, user): ensure linked channel, download media → files, handleUserMessage(...)
  → agent replies inserted → relayMessage → messaging_events (direction=out, status=pending)
  → worker sends via the adapter, records provider message id + delivery statuses
```

`MessagingChannelAdapter` (packages/messaging): `verifyWebhook`, `parseInbound(update) → InboundMessage[]`,
`sendText`, `sendButtons`, `sendMedia`, `downloadMedia`, `testConnection`, `health`.
Implementations: `TelegramAdapter`, `WhatsAppCloudAdapter`. Adding Slack/SMS later is one more class.

## 3. Schema (migration 0050)

- `channels` + `source text` (`web|telegram|whatsapp`), `external_connection_id uuid`.
- `messaging_identities` — global (webhook resolution): `channel`, `external_user_id`, `external_chat_id`,
  `user_id`, `active_connection_id`, `display_name`, timestamps. UNIQUE(channel, external_user_id).
- `messaging_events` — tenant-scoped, RLS: `direction`, `channel`, `connection_id`, `external_message_id`,
  `conversation_channel_id`, `message_id`, `kind`, `status`, `payload` (redacted), `error`, `attempts`,
  `claimed_at`, `processed_at`, `sent_at`. UNIQUE(channel, external_message_id) WHERE direction='in'.
  It is both the inbound queue and the outbound outbox — one worker, one audit surface.
- `usage_ledger.kind` gains `channel_message`.
- Connections: `connector_connections` rows. Telegram: `provider_account_id` = chat id, sealed token = a
  per-connection random secret. WhatsApp: `provider_account_id` = phone number id, sealed token = the business
  token; `metadata` = waba id, display phone, verified name, quality, notification prefs, linked channel.
- Pairing: `connector_oauth_states` rows (provider telegram, hashed token, 15-minute expiry, single use).

## 4. Security

- Telegram: webhook set with `secret_token`; header `X-Telegram-Bot-Api-Secret-Token` must match.
  WhatsApp: `X-Hub-Signature-256` HMAC over the raw body with the app secret; GET verification with the
  verify token. Both endpoints answer 200 quickly and never run the agent inline.
- Identity: organization is never derived from a username or phone number. Telegram pairs through a signed
  single-use `/start <token>` that the logged-in user minted; WhatsApp numbers are attached by the logged-in
  admin and inbound senders are matched to the number's allow-list (`metadata.allowedSenders`, the connecting
  user's number by default) — anyone else gets a polite refusal.
- Idempotency on provider message ids at two layers (`messaging_events` unique index, `clientKey`).
- Rate limit per connection (60 messages / 10 minutes) and per identity for unpaired senders.
- Media: allow-listed MIME types, 8 MB, downloaded server-side only from the provider's own endpoints.
- Tenant isolation: all processing under `withContext`; cross-tenant reads only for identity resolution and
  outbound delivery, on `adminPool`, by connection id.
- External text/files are untrusted input: they enter the runtime exactly like a web message (same context
  builder, same tool gateway, same approvals), and nothing in the channel layer can grant scopes or reach
  another tenant. Provider metadata (names, phone numbers) is never used for authorization.
- Secrets: bot token / app secret sealed in `platform_integrations`; business tokens sealed in
  `connector_connections`; nothing reaches the browser.

## 5. Phases

1. This document.
2. `packages/messaging` (adapter contract, message model, media validation, text/button rendering), migration,
   gateway (`apps/api/src/messaging/`): resolve → conversation → runtime → relay, worker, metering, audit.
3. Telegram end to end: platform config, pairing, webhook, commands (`/help /agents /tasks /status /new /workspace`),
   inline approvals, media both ways, test message, manage/disconnect.
4. WhatsApp Cloud API: manual credentials and Embedded Signup code exchange, webhook verification, statuses,
   interactive buttons, 24-hour window handling (free-form only inside it; otherwise queue and tell the user
   on the web), template messages deliberately not sent.
5. Web: connector cards, Manage dialog (status, identity, dates, last activity, notification prefs, test,
   reconnect, disconnect, activity), chat source badges, admin visibility tab, platform-admin integration entries.
6. Security and reliability hardening; failure copy; diagnostics.
7. Tests: adapters against recorded provider payloads, gateway against a live local API (pairing, message,
   task creation, approval via button, media), and a manual run against real Telegram.

## 6. Operating it

**Turn Telegram on (once per Deedwell):** Telegram → @BotFather → `/newbot` → copy the token. Platform Admin →
Integrations → Telegram → Set up: bot username + token → Validate. Validation calls `getMe`, registers the
webhook (`/v1/integrations/telegram/webhook`, secret token generated and stored in the integration's
configuration) and confirms it. Customers then see "Connect Telegram" on Connectors.

**Turn WhatsApp on:** a Meta app with the WhatsApp product. Platform Admin → Integrations → WhatsApp → App ID +
App Secret → Validate. In the Meta app, WhatsApp → Configuration → Webhook: callback URL and verify token as shown
in the wizard, subscribe to `messages`. Optional: an Embedded Signup configuration id in the checklist enables
"Continue with Meta" for customers; without it they paste a phone number id + permanent system-user token.
Customers add their own phone as the first allowed sender; teammates are added under Manage → Who can message,
each mapped to a Deedwell user.

**Env knobs:** `MESSAGING_WORKER=off` (no inbound processing / delivery on this instance), `MESSAGING_POLL_MS`
(default 3000), `TELEGRAM_API_BASE` / `META_GRAPH_BASE` / `META_GRAPH_VERSION` (tests, staging), `API_ORIGIN`
(webhook URLs), `APP_ORIGIN` (links sent to phones).

**Watching it:** Platform Admin → Messaging (connections, volume, failures, provider health, retry button);
per workspace, Connectors → Manage → Activity. Logs: `messaging ingest failed`, `messaging inbound failed`,
`messaging send failed`, `telegram paired`, `whatsapp_webhook_rejected` / `telegram_webhook_rejected`.

**Tests:** `packages/connectors/src/messaging/messaging.test.ts` (adapters, rendering) and
`tests/integration/messaging.test.ts` (pairing, idempotency, runtime round trip, media, commands, buttons,
allow-list, signatures, statuses, 24-hour window, admin overview) — both run against in-process fake providers.
