# Wildcard site hosting on Cloudflare

Gives every generated site an address of its own:

- `https://<slug>.deedwell.org` — the published site
- `https://preview-<slug>.deedwell.org` — the preview build

Both are first-level labels under `deedwell.org`, so Cloudflare's included
Universal SSL certificate (`*.deedwell.org`) covers them. A second-level form
like `<slug>.preview.deedwell.org` would not be covered.

## Steps (Cloudflare dashboard, zone deedwell.org)

1. **Workers & Pages → Create → Worker.** Name it `deedwell-sites`, paste
   `sites-worker.js`, deploy. Under *Settings → Variables* add
   `SITES_ORIGIN = https://deedwell-sites-304514004050.us-central1.run.app`.
2. **DNS → Add record.** Type `AAAA`, name `*`, content `100::`, proxy status
   **Proxied** (orange cloud). This is the standard placeholder target for a
   Worker-served hostname; the Worker answers, the address is never used.
   Existing specific records (`deedwell.org`, `coworkers`, `www`) keep
   precedence over the wildcard.
3. **Worker → Settings → Triggers → Routes.** Add route `*.deedwell.org/*`,
   zone `deedwell.org`. If Cloudflare offers the route with a "Fail open/closed"
   setting, choose fail closed.
4. **API config.** On the `deedwell-app` Cloud Run service set
   `SITES_BASE_DOMAIN=deedwell.org`. The dashboard then links previews to
   `preview-<slug>.deedwell.org` instead of the path form.

## Check

    curl -sI https://preview-<some-slug>.deedwell.org/ | head -3

A `200` with `content-security-policy` in the headers means the Worker reached
the router. A Google-branded 404 means the Host header was passed through
unchanged (the Worker is not on the route). `DNS_PROBE_FINISHED_NXDOMAIN` means
the wildcard record is missing.
