-- Model-designed pages. The website builder no longer renders every page from
-- one hand-written template: a design step writes each page's HTML from the
-- reference design and the approved copy, and the release uses it. The hash
-- ties a rendering to the copy it was made from, so an edited page falls back
-- to the template until it is designed again rather than shipping stale HTML.
ALTER TABLE site_pages ADD COLUMN rendered_html text;
ALTER TABLE site_pages ADD COLUMN rendered_hash text;
