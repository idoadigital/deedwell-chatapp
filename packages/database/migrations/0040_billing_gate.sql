-- Billing gate.
--
-- 1. Model usage debits the org's prepaid balance wherever it is recorded.
--    Every model call already lands one usage_ledger row (chat, grants,
--    websites, ad grants); a trigger turns that row into the debit, so no
--    domain package needs to know billing exists and nothing can forget.
--    SECURITY DEFINER because the debit must land even though the caller's
--    RLS context is the tenant's (which it always is when usage is written).
-- 2. organizations.billing_exempt — platform admins and testers bypass
--    payment entirely.
-- 3. workflow_runs may park as 'waiting_payment' when a run's org has run
--    out mid-flight; a top-up (or exemption) re-enqueues them.

ALTER TABLE organizations ADD COLUMN billing_exempt boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION debit_model_tokens() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.kind = 'model_tokens' AND NEW.quantity > 0 THEN
    INSERT INTO billing_accounts (id, tenant_id, token_balance)
      VALUES (gen_random_uuid(), NEW.tenant_id, -NEW.quantity)
      ON CONFLICT (tenant_id) DO UPDATE
        SET token_balance = billing_accounts.token_balance + EXCLUDED.token_balance;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER usage_ledger_debit AFTER INSERT ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION debit_model_tokens();

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_status_check
  CHECK (status IN ('pending','running','waiting_for_info','waiting_approval','waiting_payment',
                    'suspended_budget','failed','completed','cancelled'));
