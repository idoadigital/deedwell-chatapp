# Proactive agent messaging

How Deedwell teammates reach out on their own, and why they mostly don't.

## What it extends

Nothing in the reactive chat changed. The proactive layer sits beside it and
reuses four things that already existed:

| Existing piece | Reused for |
|---|---|
| `insertMessage` (`apps/api/src/assistant.ts`) — the single write path for agent replies | Delivering an approved proactive message. It is an ordinary `messages` row with `metadata.proactive = true`. |
| The engine event bus + `GET /v1/orgs/:orgId/events` (SSE) | Announcing the message (`message_created`) so both chat clients refresh as usual, plus a `notification_created` event. |
| `run_updated` milestone events (`waiting_for_info`, `waiting_approval`, `completed`, `failed`) | Deriving goal/intent state and follow-up candidates — the same events the milestone bridge already listens to. |
| `platform_settings` (keyed JSON) and Platform Admin | The tunable policy (`key = proactive_messaging`) and its admin tab. |

Scheduling uses the pattern the publish worker uses: rows in Postgres, a
`setTimeout` ticker per API instance, `FOR UPDATE SKIP LOCKED` claims. No
Pub/Sub, Cloud Tasks or new services.

## Flow

```
agent work / workflow milestone / content campaign finishing
        │
        ▼
proposeProactiveMessage()  or  the engine bridge         (proactive/candidates.ts)
        │   → user_goals / user_intents kept current
        │   → a proactive_candidates row, status "candidate", due later or now
        ▼
runProactiveTick()  (proactive/orchestrator.ts, every PROACTIVE_POLL_MS)
        │   claims what is due, then per candidate:
        │   1. still relevant? (goal/intent/run state)        → else CANCEL
        │   2. user active in the last N minutes?             → SEND LATER
        │   3. same subject raised recently / by another agent → SUPPRESS
        │   4. score (policy.ts) below threshold               → SUPPRESS
        │   5. non-critical: daily cap, spacing, agent cooldown, quiet hours → SEND LATER
        │   6. other due candidates for the same user           → COMBINE into this message
        │   7. compose as the owning teammate (compose.ts; the model may veto)
        ▼
insertMessage → message_created → chat clients, unread badge, notification item
        │
        ▼
user replies in chat → the ordinary assistant path; the candidate becomes "responded"
```

## Lifecycle

`candidate → evaluating → scheduled → delivered → read → responded`, with
`suppressed`, `cancelled` and `expired` as exits. Every transition is written
to `proactive_log` with its reason, and `GET /v1/admin/proactive/stats`
aggregates them (proposed, delivered, suppressed by reason, per agent, time
to response).

Cancellation is automatic: a run leaving a waiting state, a goal completing,
or the user acting on the subject cancels every open candidate for it.

## Data

`user_goals`, `user_intents`, `proactive_candidates`, `proactive_log`,
`channel_reads`, and three membership columns (`last_active_at`, `presence`,
`proactive_prefs`). Migration `0039_proactive_messaging.sql`. Note that the
goal/intent `run_id` columns are deliberately **not** foreign keys: a
reference would key-share-lock the run row and make the engine's
`SKIP LOCKED` claim skip it while the bridge is writing.

## Presence and notifications

The dashboard posts a heartbeat (`POST /v1/orgs/:orgId/presence`) while the
tab is visible. Presence is derived on read: active within 3 minutes,
idle within 15, otherwise offline. It never decides whether a message is
sent — only whether a notification item is raised alongside it
(`notified`), which also respects `maxDailyPushNotifications` and the
user's `proactive_prefs.notifications`.

Per-channel unread comes from `channel_reads`
(`GET /v1/orgs/:orgId/channels/unread`, `POST …/channels/:id/read`). The
notification bell merges proactive items into the existing live-computed
list, each deep-linking to `/dashboard/chat?channel=…&message=…`.

## Configuration

Defaults live in `proactive/policy.ts` (`ProactivePolicy`) and are
overridden by `platform_settings.proactive_messaging`, editable at Platform
Admin → Proactive Messaging. `PROACTIVE_WORKER=off` disables the ticker on an
instance; `PROACTIVE_POLL_MS` sets its interval (default 60 s).

## Agents

The only capability an agent has is `proposeProactiveMessage(deps, tenantId, input)`
(also `POST /v1/orgs/:orgId/proactive/propose` for out-of-process agents).
Proposals for a subject already queued are merged, not duplicated. Delivery
is the orchestrator's decision alone.
