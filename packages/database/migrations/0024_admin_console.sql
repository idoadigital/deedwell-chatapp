-- Real platform-admin user management: suspend/reactivate (blocks login)
-- and admin-issued temp passwords (forces a change on next use). Neither
-- existed before — the only prior user-status signal was is_platform_admin
-- itself (0019_public_api.sql).

ALTER TABLE users ADD COLUMN suspended_at timestamptz;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
