-- Campaign requests run the whole pipeline on their own once handed to the
-- account manager: plan → build (copy, keywords, extensions, images) → one
-- final approval by the customer or a Deedwell administrator → publish.
--
--   needs_admin        The account manager asked the Deedwell team a question.
--   awaiting_approval  Everything is built; the customer or an administrator
--                      approves the campaign as the last step.
--   publishing         Approved; the publish job is on its way to Google Ads.

ALTER TABLE google_ads_campaign_requests DROP CONSTRAINT google_ads_campaign_requests_status_check;
ALTER TABLE google_ads_campaign_requests ADD CONSTRAINT google_ads_campaign_requests_status_check
  CHECK (status IN ('submitted','in_review','needs_info','needs_admin','in_progress','planned','building','awaiting_approval','publishing','live','completed','declined','cancelled'));

ALTER TABLE google_ads_campaign_requests
  ADD COLUMN approved_by   uuid REFERENCES users(id),
  ADD COLUMN approved_at   timestamptz,
  -- 'customer' when the organization approved from its dashboard, 'admin'
  -- when a Deedwell administrator did.
  ADD COLUMN approved_as   text CHECK (approved_as IN ('customer','admin'));
