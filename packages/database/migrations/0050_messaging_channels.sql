-- WhatsApp and Telegram as interfaces into the agent runtime.
--
-- Connections themselves are connector_connections rows (provider 'telegram'
-- / 'whatsapp'); pairing tokens are connector_oauth_states rows. What is new:
--
--   channels.source / external_connection_id
--       The conversation a phone talks into is an ordinary dm channel, marked
--       with where it started so the web shows a WhatsApp/Telegram badge and
--       the relay knows to mirror agent replies to the phone.
--
--   messaging_identities
--       Who an external sender is, resolved BEFORE any tenant context exists
--       (the webhook has no session). Global on purpose: one Telegram user
--       may belong to several organizations, and the active one is chosen
--       explicitly (/workspace), never inferred from a phone number.
--
--   messaging_events
--       Inbound queue, outbound outbox and audit surface in one: every
--       provider message in, every message out, with the provider id as the
--       idempotency key. Tenant-scoped and RLS-protected; the worker reads it
--       on the admin pool by connection id.

ALTER TABLE channels
  ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web','telegram','whatsapp')),
  ADD COLUMN external_connection_id uuid REFERENCES connector_connections(id) ON DELETE SET NULL;
CREATE INDEX channels_external_connection_idx ON channels (external_connection_id) WHERE external_connection_id IS NOT NULL;
GRANT UPDATE (source, external_connection_id) ON channels TO deedwell_app;

CREATE TABLE messaging_identities (
  id                    uuid PRIMARY KEY,
  channel               text NOT NULL CHECK (channel IN ('telegram','whatsapp')),
  external_user_id      text NOT NULL,
  external_chat_id      text,
  display_name          text,
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  active_connection_id  uuid REFERENCES connector_connections(id) ON DELETE SET NULL,
  -- Rolling window for rate limiting unpaired/abusive senders.
  window_started_at     timestamptz,
  window_count          integer NOT NULL DEFAULT 0,
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_user_id)
);
CREATE INDEX messaging_identities_user_idx ON messaging_identities (user_id);
CREATE TRIGGER messaging_identities_updated BEFORE UPDATE ON messaging_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- No tenant_id, therefore no RLS: only the webhook resolver and the worker
-- touch it, on the admin pool. The app role may read it for the Manage view.
GRANT SELECT ON messaging_identities TO deedwell_app;

CREATE TABLE messaging_events (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES organizations(id),
  connection_id           uuid REFERENCES connector_connections(id) ON DELETE SET NULL,
  channel                 text NOT NULL CHECK (channel IN ('telegram','whatsapp')),
  direction               text NOT NULL CHECK (direction IN ('in','out')),
  kind                    text NOT NULL,          -- text|image|document|audio|video|button|command|status|system
  external_message_id     text,
  external_user_id        text,
  external_chat_id        text,
  conversation_channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  message_id              uuid,                   -- messages.id this event produced (in) or mirrors (out)
  user_id                 uuid REFERENCES users(id) ON DELETE SET NULL,
  status                  text NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received','processing','processed','skipped','failed',
                                            'pending','sending','sent','delivered','read')),
  payload                 jsonb NOT NULL DEFAULT '{}',   -- redacted provider payload (in) / what to send (out)
  result                  jsonb NOT NULL DEFAULT '{}',   -- agent run ids, tool runs, provider ids
  error                   text,
  attempts                integer NOT NULL DEFAULT 0,
  claimed_at              timestamptz,
  processed_at            timestamptz,
  sent_at                 timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
-- A provider may deliver the same webhook twice: the second insert is a no-op.
CREATE UNIQUE INDEX messaging_events_inbound_idx ON messaging_events (channel, external_message_id) WHERE direction = 'in';
CREATE INDEX messaging_events_queue_idx ON messaging_events (direction, status, created_at);
CREATE INDEX messaging_events_tenant_idx ON messaging_events (tenant_id, created_at DESC);
CREATE INDEX messaging_events_connection_idx ON messaging_events (connection_id, created_at DESC);
CREATE INDEX messaging_events_external_out_idx ON messaging_events (channel, external_message_id) WHERE direction = 'out';
ALTER TABLE messaging_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY messaging_events_tenant ON messaging_events
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE TRIGGER messaging_events_updated BEFORE UPDATE ON messaging_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON messaging_events TO deedwell_app;

-- Metering: one row per message in or out. Never debited (the balance trigger
-- only acts on model_tokens); it exists so channel usage can be priced later.
ALTER TABLE usage_ledger DROP CONSTRAINT usage_ledger_kind_check;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_kind_check
  CHECK (kind IN ('model_tokens','steps','channel_message'));
