-- Generated imagery for a site: a short list of {key, path, storageKey, alt,
-- purpose, forPage, mime}, made once per build, copied into every release.
ALTER TABLE sites ADD COLUMN images jsonb NOT NULL DEFAULT '[]';
