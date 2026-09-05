/**
 * The stylesheet, expressed entirely in tokens from theme.ts.
 *
 * Design intent, since a stylesheet doesn't explain itself:
 *
 * - **Rhythm over uniformity.** The old output was one 960px column of
 *   identical white cards, which is what "generic" actually looks like. Here
 *   sections are full-bleed and alternate tone (plain / tinted band / accent),
 *   so scrolling has a beat.
 * - **One dominant element per screen.** The hero uses a display size far
 *   above anything else; stats use another. Everything else stays quiet.
 * - **Measure.** Prose is capped near 64ch. Long lines are the single most
 *   common readability failure on nonprofit sites.
 * - **Depth, not decoration.** Elevation comes from two shadow tokens and a
 *   hairline, never from borders-everywhere.
 * - **No JavaScript.** The FAQ uses <details>, which is why it can exist at
 *   all under a `default-src 'none'` CSP.
 */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:var(--font-body);font-size:var(--fs-body);line-height:1.65;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
h1,h2,h3,h4{font-family:var(--font-head);color:var(--ink);margin:0 0 var(--s4);font-weight:var(--head-weight,700)}
h1{font-size:var(--fs-h1);line-height:1.1;letter-spacing:-0.022em}
h2{font-size:var(--fs-h2);line-height:1.15;letter-spacing:-0.018em}
h3{font-size:var(--fs-h3);line-height:1.3;letter-spacing:-0.008em}
p{margin:0 0 var(--s4);max-width:var(--measure)}
a{color:var(--accent);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
img{max-width:100%;height:auto;display:block}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:2px}
::selection{background:var(--accent);color:var(--accent-ink)}

/* ---- layout ------------------------------------------------------------ */
.wrap{width:100%;max-width:var(--wrap);margin-inline:auto;padding-inline:clamp(1.15rem,5vw,2.5rem)}
.wrap-narrow{max-width:var(--wrap-narrow)}
section.band{padding-block:var(--s8)}
section.band.tone-band{background:var(--band)}
section.band.tone-accent{background:var(--accent);color:var(--accent-ink)}
section.band.tone-accent h2,section.band.tone-accent h3{color:var(--accent-ink)}
section.band.tone-deep{
  background:linear-gradient(140deg,var(--accent) 0%,var(--accent-deep) 100%);
  color:var(--accent-ink);
}
section.band.tone-deep h2{color:var(--accent-ink)}
.eyebrow{
  font-size:var(--fs-eyebrow);font-weight:700;letter-spacing:.13em;text-transform:uppercase;
  color:var(--accent);margin:0 0 var(--s3);display:flex;align-items:center;gap:var(--s3);
}
.eyebrow::after{content:"";flex:0 0 32px;height:1px;background:currentColor;opacity:.45}
.tone-accent .eyebrow,.tone-deep .eyebrow{color:var(--accent-ink);opacity:.85}
.lead{font-size:var(--fs-lead);color:var(--ink-soft);line-height:1.55;max-width:58ch}
.tone-accent .lead,.tone-deep .lead{color:var(--accent-ink);opacity:.92}
.section-head{margin-bottom:var(--s6);max-width:58ch}
/* Heading left, content right — fills a wide screen instead of stranding half
   of it, and the heading stays in view while long content scrolls past. */
.section-split{display:grid;gap:var(--s6)}
@media (min-width:58rem){
  .section-split{grid-template-columns:minmax(0,20rem) minmax(0,1fr);gap:var(--s8)}
  .section-split > .section-head{position:sticky;top:96px;align-self:start;margin-bottom:0}
}
.section-head p{color:var(--ink-soft);margin-bottom:0}

/* ---- skip link + header ------------------------------------------------ */
.skip{
  position:absolute;left:-9999px;top:0;z-index:100;
  background:var(--accent);color:var(--accent-ink);padding:12px 20px;border-radius:0 0 var(--r-sm) 0;
  font-weight:600;text-decoration:none;
}
.skip:focus{left:0}
header.site{
  position:sticky;top:0;z-index:50;
  background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:saturate(180%) blur(12px);
  -webkit-backdrop-filter:saturate(180%) blur(12px);
  border-bottom:1px solid var(--line);
}
@supports not (backdrop-filter:blur(1px)){header.site{background:var(--bg)}}
.nav{display:flex;align-items:center;gap:var(--s5);min-height:68px;flex-wrap:wrap;padding-block:var(--s3)}
.brand{
  font-family:var(--font-head);font-weight:700;font-size:1.08rem;letter-spacing:-0.01em;
  color:var(--ink);text-decoration:none;margin-right:auto;line-height:1.2;
}
.brand:hover{color:var(--accent)}
.nav-links{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s5);align-items:center}
.nav-links a{
  color:var(--ink-soft);text-decoration:none;font-size:0.95rem;font-weight:500;
  padding:6px 0;position:relative;
}
.nav-links a:hover{color:var(--ink)}
.nav-links a[aria-current="page"]{color:var(--ink);font-weight:600}
.nav-links a[aria-current="page"]::after{
  content:"";position:absolute;left:0;right:0;bottom:0;height:2px;
  background:var(--accent);border-radius:2px;
}
.nav-cta{
  background:var(--accent);color:var(--accent-ink) !important;
  padding:9px 18px !important;border-radius:var(--r-button,var(--r-pill));font-weight:600;
  box-shadow:var(--shadow-sm);
}
.nav-cta:hover{background:var(--accent-deep)}

/* ---- buttons ----------------------------------------------------------- */
.button{
  display:inline-flex;align-items:center;gap:var(--s2);
  background:var(--accent);color:var(--accent-ink);
  padding:14px 28px;border-radius:var(--r-button,var(--r-pill));
  text-decoration:none;font-weight:600;font-size:1rem;line-height:1;
  box-shadow:var(--shadow-sm);border:1px solid transparent;
  transition:transform .15s ease,box-shadow .15s ease,background .15s ease;
}
.button:hover{background:var(--accent-deep);transform:translateY(-1px);box-shadow:var(--shadow-md)}
.button:active{transform:translateY(0)}
.button.ghost{
  background:transparent;color:var(--accent);border-color:var(--line);box-shadow:none;
}
.button.ghost:hover{background:var(--accent-soft);border-color:var(--accent);transform:none}
.tone-deep .button,.tone-accent .button{background:var(--surface);color:var(--accent)}
.tone-deep .button:hover,.tone-accent .button:hover{background:var(--surface);opacity:.92}
.tone-deep .button.ghost,.tone-accent .button.ghost{
  background:transparent;color:var(--accent-ink);border-color:currentColor;
}
.actions{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center;margin-top:var(--s6)}

/* ---- hero -------------------------------------------------------------- */
.hero{position:relative;overflow:hidden;padding-block:var(--hero-pad,clamp(3.5rem,10vw,7.5rem));background:var(--band)}
.hero::before{
  /* Soft off-centre wash — gives the hero depth without an image, which
     matters because most nonprofits have no usable hero photograph. */
  content:"";position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(70ch 48ch at 78% -10%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%),
    radial-gradient(50ch 40ch at 8% 108%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 68%);
}
.hero > .wrap{position:relative}
.hero h1{font-size:var(--fs-display);letter-spacing:-0.035em;line-height:1.02;margin-bottom:var(--s5);max-width:17ch}
.hero .lead{font-size:var(--fs-lead);max-width:54ch}
.hero-rule{width:64px;height:4px;background:var(--accent);border-radius:2px;margin-bottom:var(--s5)}

/* ---- design variants (from the reference design, via body classes) ---- */
body.hero-centered .hero .wrap{text-align:center}
body.hero-centered .hero h1,body.hero-centered .hero .lead{margin-inline:auto}
body.hero-centered .hero-rule{margin-inline:auto}
body.hero-centered .hero .actions{justify-content:center}
body.hero-centered .hero .eyebrow{justify-content:center}
body.hero-banner .hero{background:linear-gradient(135deg,var(--accent) 0%,var(--accent-deep) 100%);color:var(--accent-ink)}
body.hero-banner .hero::before{display:none}
body.hero-banner .hero h1,body.hero-banner .hero .lead{color:var(--accent-ink)}
body.hero-banner .hero .lead{opacity:.92}
body.hero-banner .hero .eyebrow{color:var(--accent-ink);opacity:.85}
body.hero-banner .hero-rule{background:var(--accent-ink);opacity:.7}
body.hero-banner .hero .button{background:var(--surface);color:var(--accent)}
body.hero-banner .hero .button.ghost{background:transparent;color:var(--accent-ink);border-color:currentColor}
body.hero-split .hero .wrap{display:grid;gap:var(--s6);align-items:center}
@media (min-width:880px){body.hero-split .hero .wrap{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:var(--s8)}}
.hero-panel{display:none}
body.hero-split .hero-panel{
  display:block;min-height:18rem;border-radius:var(--r-lg);
  background:
    radial-gradient(60% 55% at 30% 30%,color-mix(in srgb,var(--accent) 55%,white) 0%,transparent 70%),
    linear-gradient(160deg,var(--accent) 0%,var(--accent-deep) 100%);
  box-shadow:var(--shadow-lg);
}
body.nav-bar header.site{background:var(--accent);border-bottom:0;backdrop-filter:none}
body.nav-bar .brand,body.nav-bar .nav-links a{color:var(--accent-ink)}
body.nav-bar .brand:hover,body.nav-bar .nav-links a:hover{color:var(--accent-ink);opacity:.85}
body.nav-bar .nav-links a[aria-current="page"]::after{background:var(--accent-ink)}
body.nav-bar .nav-cta{background:var(--surface);color:var(--accent) !important}
body.nav-bar .nav-cta:hover{background:var(--surface);opacity:.9}
body.buttons-square .card{border-radius:var(--r-md)}

/* ---- prose ------------------------------------------------------------- */
.prose{max-width:var(--measure)}
.prose p:last-child{margin-bottom:0}

/* ---- cards / programs -------------------------------------------------- */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:var(--s5)}
.card{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:var(--s6);position:relative;
  transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;
}
.card:hover{transform:translateY(-3px);box-shadow:var(--shadow-md);border-color:transparent}
.card .num{
  font-family:var(--font-head);font-size:0.82rem;font-weight:700;letter-spacing:.1em;
  color:var(--accent);display:block;margin-bottom:var(--s3);
}
.card h3{margin-bottom:var(--s3)}
.card p{color:var(--ink-soft);margin-bottom:0;font-size:0.98rem}

/* ---- stats ------------------------------------------------------------- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:var(--s6)}
.stat{text-align:left}
.stat .v{
  font-family:var(--font-head);font-size:var(--fs-stat);font-weight:700;
  line-height:1;letter-spacing:-0.03em;display:block;margin-bottom:var(--s2);
}
.stat .l{font-size:0.95rem;opacity:.88;line-height:1.4;max-width:24ch}
.tone-accent .stat .v,.tone-deep .stat .v{color:var(--accent-ink)}

/* ---- split ------------------------------------------------------------- */
.split{display:grid;grid-template-columns:1fr;gap:var(--s7);align-items:start}
@media (min-width:56rem){.split{grid-template-columns:1.15fr .85fr;gap:var(--s8)}}
.split-panel{
  background:var(--accent-soft);border-radius:var(--r-lg);padding:var(--s6);
  border:1px solid color-mix(in srgb,var(--accent) 18%,transparent);
}
.split-panel ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--s4)}
.split-panel li{
  display:flex;gap:var(--s3);align-items:flex-start;
  color:var(--accent-soft-ink);font-weight:500;line-height:1.45;
}
.split-panel li::before{
  content:"";flex:0 0 8px;height:8px;margin-top:.55em;border-radius:50%;background:var(--accent);
}

/* ---- quote ------------------------------------------------------------- */
.quote{max-width:52ch;margin-inline:auto;text-align:center}
.quote blockquote{
  margin:0 0 var(--s5);font-family:var(--font-head);
  font-size:clamp(1.35rem,1.05rem + 1.35vw,2.05rem);line-height:1.32;letter-spacing:-0.015em;
}
.quote blockquote::before{content:"\\201C"}
.quote blockquote::after{content:"\\201D"}
.quote .who{font-weight:600;font-size:0.98rem}
.quote .role{color:var(--ink-soft);font-size:0.92rem}

/* ---- steps ------------------------------------------------------------- */
.steps{display:grid;gap:0;counter-reset:step;max-width:var(--measure);align-content:start}
.step{position:relative;padding:0 0 var(--s6) var(--s7);counter-increment:step}
.step:last-child{padding-bottom:0}
.step::before{
  content:counter(step);position:absolute;left:0;top:0;
  width:2.2rem;height:2.2rem;border-radius:50%;
  background:var(--accent);color:var(--accent-ink);
  display:grid;place-items:center;font-weight:700;font-size:0.95rem;
  font-family:var(--font-head);
}
.step::after{
  content:"";position:absolute;left:1.1rem;top:2.6rem;bottom:.4rem;width:2px;
  background:var(--line);
}
.step:last-child::after{display:none}
.step h3{margin-bottom:var(--s2)}
.step p{color:var(--ink-soft);margin-bottom:0}

/* ---- faq (details = no JS, works under a strict CSP) ------------------- */
.faq{display:grid;gap:var(--s3);align-content:start}
.faq details{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);
  padding:var(--s4) var(--s5);
}
.faq summary{
  cursor:pointer;font-weight:600;list-style:none;display:flex;
  justify-content:space-between;align-items:center;gap:var(--s4);
}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-size:1.4rem;line-height:1;color:var(--accent);flex:0 0 auto}
.faq details[open] summary::after{content:"\\2212"}
.faq details[open] summary{margin-bottom:var(--s3)}
.faq p{color:var(--ink-soft);margin-bottom:0}

/* ---- brand logo (header + footer) ------------------------------------- */
.brand { display: inline-flex; align-items: center; }
.brand__logo { display: block; height: 40px; width: auto; max-width: 200px; object-fit: contain; }
.foot-brand .brand__logo { height: 32px; }

/* ---- team / logos ------------------------------------------------------ */
.team{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));gap:var(--s5)}
.member{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--s5)}
.member .name{font-family:var(--font-head);font-weight:700;font-size:1.05rem}
.member .role{color:var(--accent);font-size:0.88rem;font-weight:600;margin-bottom:var(--s3)}
.member p{font-size:0.94rem;color:var(--ink-soft);margin-bottom:0}
.logos{display:flex;flex-wrap:wrap;gap:var(--s3)}
.logos span{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-pill);
  padding:10px 20px;font-weight:600;font-size:0.94rem;color:var(--ink-soft);
}

/* ---- donate ------------------------------------------------------------ */
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr));gap:var(--s4);margin:var(--s6) 0}
.tier{
  background:color-mix(in srgb,var(--surface) 16%,transparent);
  border:1px solid color-mix(in srgb,currentColor 28%,transparent);
  border-radius:var(--r-md);padding:var(--s5);
}
.tier .amt{font-family:var(--font-head);font-size:1.6rem;font-weight:700;display:block;margin-bottom:var(--s2)}
.tier .eff{font-size:0.92rem;opacity:.9;line-height:1.4}

/* ---- contact ----------------------------------------------------------- */
.contact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:var(--s5)}
.contact-item{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--s5)}
.contact-item .k{
  font-size:var(--fs-eyebrow);text-transform:uppercase;letter-spacing:.12em;
  font-weight:700;color:var(--accent);margin-bottom:var(--s2);
}
.contact-item .v{font-size:1.02rem;line-height:1.5}
.contact-item a{text-decoration:none;font-weight:500}
.contact-item a:hover{text-decoration:underline}

/* ---- form -------------------------------------------------------------- */
form.dw{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:var(--s6);max-width:36rem;
}
form.dw .field{margin-bottom:var(--s4)}
form.dw label{display:block;font-weight:600;margin-bottom:var(--s2);font-size:0.94rem}
form.dw input,form.dw textarea{
  width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-sm);
  font:inherit;color:var(--ink);background:var(--bg);
}
form.dw input:focus,form.dw textarea:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
form.dw button{margin-top:var(--s3);border:0;cursor:pointer;font:inherit}
.req{color:var(--accent);font-weight:700}
.hp{position:absolute!important;left:-9999px!important}

/* ---- footer ------------------------------------------------------------ */
footer.site{background:var(--band);border-top:1px solid var(--line);padding-block:var(--s7) var(--s6);margin-top:var(--s6)}
.foot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:var(--s6);margin-bottom:var(--s6)}
.foot-grid h2{font-size:0.82rem;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-soft);margin-bottom:var(--s3)}
.foot-brand{font-family:var(--font-head);font-weight:700;font-size:1.1rem;margin-bottom:var(--s3)}
.foot-grid ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--s2)}
.foot-grid a{color:var(--ink-soft);text-decoration:none;font-size:0.95rem}
.foot-grid a:hover{color:var(--accent);text-decoration:underline}
.foot-grid p{font-size:0.95rem;color:var(--ink-soft);margin-bottom:var(--s2)}
.foot-legal{
  border-top:1px solid var(--line);padding-top:var(--s5);
  display:flex;flex-wrap:wrap;gap:var(--s3);justify-content:space-between;
  font-size:var(--fs-small);color:var(--ink-soft);
}

/* ---- motion + print ---------------------------------------------------- */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
  .card:hover,.button:hover{transform:none}
}
@media print{
  header.site,.skip,.nav-cta{display:none}
  body{background:#fff;color:#000;font-size:11pt}
  section.band{padding-block:1rem;background:#fff!important;color:#000!important}
  .button{border:1px solid #000;color:#000!important;background:#fff!important}
  a[href^="http"]::after{content:" (" attr(href) ")";font-size:9pt;word-break:break-all}
}
`.trim();
