/**
 * The stylesheet for the component library. Everything references tokens
 * from tokensToCss(); nothing here is per-site. Mobile-first, three
 * breakpoints (640 / 820 / 1024), no fixed heights on text, no absolute
 * positioning except the full-bleed hero image and the mobile menu.
 */
export const BASE_STYLES = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--c-bg);color:var(--c-fg);font-family:var(--font-body);font-size:var(--fs-body);font-weight:var(--fw-body);line-height:var(--lh-body);-webkit-font-smoothing:antialiased;overflow-x:hidden}
img,svg,video{max-width:100%;height:auto;display:block}
h1,h2,h3,h4{font-family:var(--font-heading);font-weight:var(--fw-heading);letter-spacing:var(--tracking-heading);line-height:var(--lh-heading);margin:0 0 var(--s-4);color:inherit;overflow-wrap:anywhere}
h1{font-size:var(--fs-h1);line-height:var(--lh-tight)}h2{font-size:var(--fs-h2)}h3{font-size:var(--fs-h3);line-height:1.3}
.t-display{font-size:var(--fs-display);line-height:var(--lh-tight)}.t-h1{font-size:var(--fs-h1);line-height:var(--lh-tight)}.t-h2{font-size:var(--fs-h2)}.t-h3{font-size:var(--fs-h3);line-height:1.3}
p{margin:0 0 var(--s-4)}p:last-child{margin-bottom:0}
a{color:var(--c-primary);text-underline-offset:.2em;text-decoration-thickness:1px}
a:hover{color:var(--c-primary-deep)}
:focus-visible{outline:3px solid var(--c-accent);outline-offset:3px;border-radius:2px}
ul,ol{margin:0;padding:0;list-style:none}
strong{font-weight:var(--fw-strong)}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip-link{position:absolute;left:var(--s-4);top:-100px;z-index:100;padding:var(--s-3) var(--s-5);background:var(--c-primary);color:var(--c-on-primary);border-radius:var(--r-btn);text-decoration:none}
.skip-link:focus{top:var(--s-4)}
.container{width:min(100% - 2*var(--gutter),var(--w-content));margin-inline:auto}
.container--narrow{max-width:var(--w-narrow)}
.eyebrow{font-size:var(--fs-eyebrow);font-weight:600;letter-spacing:var(--eyebrow-tracking);text-transform:var(--eyebrow-case);color:var(--c-accent);margin:0 0 var(--s-3)}
.lead{font-size:var(--fs-lead);line-height:1.5;color:var(--c-fg-muted);max-width:60ch;margin:0 0 var(--s-5)}
.prose{max-width:var(--w-narrow);font-size:var(--fs-body-lg)}.prose p{margin-bottom:var(--s-5)}
.prose--columns{max-width:none;columns:2;column-gap:var(--s-8)}@media (max-width:820px){.prose--columns{columns:1}}
.actions{display:flex;flex-wrap:wrap;gap:var(--s-3);align-items:center;margin-top:var(--s-6)}

/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--s-2);min-height:48px;padding:12px 26px;border-radius:var(--r-btn);border:var(--bw) solid transparent;font:inherit;font-weight:600;font-size:1rem;line-height:1.2;text-decoration:none;cursor:pointer;text-align:center;max-width:100%;overflow-wrap:anywhere}
.btn--primary{background:var(--c-primary);color:var(--c-on-primary)}.btn--primary:hover{background:var(--c-primary-deep);color:var(--c-on-primary);box-shadow:var(--shadow-md)}
.btn--secondary{background:transparent;color:var(--c-primary);border-color:currentColor}.btn--secondary:hover{background:var(--c-primary-tint)}
.btn--ghost{background:transparent;color:inherit;text-decoration:underline;padding-inline:var(--s-2)}
.bg-dark .btn--primary,.bg-primary .btn--primary{background:var(--c-on-primary);color:var(--c-primary)}.bg-dark .btn--primary:hover,.bg-primary .btn--primary:hover{background:var(--c-surface)}
.bg-dark .btn--secondary,.bg-primary .btn--secondary{color:inherit}
.btn--amount{background:var(--c-surface);color:var(--c-fg);border-color:var(--c-border);min-width:5.5rem}.btn--amount:hover{border-color:var(--c-primary);color:var(--c-primary)}.btn--featured{border-color:var(--c-primary);box-shadow:inset 0 0 0 1px var(--c-primary)}

/* sections */
.section{padding-block:var(--section-pad)}
.section.density-airy{padding-block:calc(var(--section-pad) * 1.25)}.section.density-dense{padding-block:calc(var(--section-pad) * .7)}
.bg-muted{background:var(--c-muted)}.bg-surface{background:var(--c-surface)}.bg-accent-tint{background:var(--c-accent-tint)}
.bg-dark{background:var(--c-dark);color:var(--c-on-dark)}.bg-primary{background:var(--c-primary);color:var(--c-on-primary)}
.bg-dark .eyebrow,.bg-primary .eyebrow{color:inherit;opacity:.8}.bg-dark .lead,.bg-primary .lead{color:inherit;opacity:.9}
.bg-dark a:not(.btn),.bg-primary a:not(.btn){color:inherit}
.section__head{margin-bottom:var(--s-7)}.section__head--measure{max-width:44ch}.section__head--center{text-align:center;margin-inline:auto}.section__head--center .lead{margin-inline:auto}
.section__head h2{margin-bottom:var(--s-4)}

/* media */
.media{margin:0;overflow:hidden;border-radius:var(--r-img);background:var(--c-muted)}
.media img{width:100%;height:100%;object-fit:cover}
.media--wide{aspect-ratio:3/2}.media--portrait{aspect-ratio:4/5}.media--square{aspect-ratio:1}.media--free{aspect-ratio:auto}

/* header */
.site-header{position:sticky;top:0;z-index:50;background:var(--c-bg);border-bottom:var(--bw) solid var(--c-border)}
.site-header__inner{display:flex;align-items:center;gap:var(--s-5);min-height:var(--nav-h)}
.brand{font-family:var(--font-heading);font-weight:var(--fw-strong);font-size:1.15rem;letter-spacing:-.01em;color:inherit;text-decoration:none;margin-right:auto;line-height:1.2;max-width:60%;overflow-wrap:anywhere}
.site-nav{display:flex;align-items:center;gap:var(--s-5)}
.site-nav ul{display:flex;flex-wrap:wrap;gap:var(--s-2) var(--s-5)}
.site-nav a:not(.btn){color:inherit;text-decoration:none;font-weight:500;padding:var(--s-2) 0;border-bottom:2px solid transparent;white-space:nowrap}
.site-nav a:not(.btn):hover,.site-nav a[aria-current="page"]{border-bottom-color:var(--c-accent)}
.site-header__cta{min-height:42px;padding:9px 18px;font-size:.95rem}
.nav-toggle{display:none;width:44px;height:44px;border:var(--bw) solid var(--c-border);border-radius:var(--r-btn);background:transparent;color:inherit;cursor:pointer;position:relative}
.nav-toggle__bar,.nav-toggle__bar::before,.nav-toggle__bar::after{content:"";position:absolute;left:12px;right:12px;height:2px;background:currentColor;transition:transform .25s var(--ease),opacity .25s}
.nav-toggle__bar{top:50%;margin-top:-1px}.nav-toggle__bar::before{top:-7px}.nav-toggle__bar::after{top:7px}
.nav-toggle[aria-expanded="true"] .nav-toggle__bar{background:transparent}.nav-toggle[aria-expanded="true"] .nav-toggle__bar::before{transform:translateY(7px) rotate(45deg)}.nav-toggle[aria-expanded="true"] .nav-toggle__bar::after{transform:translateY(-7px) rotate(-45deg)}
.site-header--dark-minimal{background:var(--c-dark);color:var(--c-on-dark);border-bottom-color:transparent}
.site-header--dark-minimal .site-nav a:not(.btn):hover,.site-header--dark-minimal .site-nav a[aria-current="page"]{border-bottom-color:var(--c-on-dark)}
.site-header--floating-editorial{position:sticky;background:transparent;border:0;padding-top:var(--s-3)}
.site-header--floating-editorial .site-header__inner{background:var(--c-surface);border:var(--bw) solid var(--c-border);border-radius:var(--r-card);padding-inline:var(--s-5);box-shadow:var(--shadow-sm);min-height:calc(var(--nav-h) - 8px)}
.site-header--centered .site-header__inner{flex-direction:column;gap:var(--s-2);padding-block:var(--s-3)}.site-header--centered .brand{margin-right:0;max-width:none;text-align:center}
.site-header--transparent-over-hero.is-transparent{position:absolute;left:0;right:0;background:transparent;border-bottom-color:transparent;color:#fff}
.site-header--transparent-over-hero.is-transparent .site-nav a:not(.btn){color:#fff}
.site-header--transparent-over-hero.is-transparent .brand{color:#fff}
.site-header--transparent-over-hero.is-transparent .nav-toggle{border-color:rgba(255,255,255,.5)}
.site-header.is-scrolled{box-shadow:var(--shadow-sm)}
@media (max-width:820px){
  .nav-toggle{display:block;margin-left:auto}
  .brand{margin-right:0}
  .site-header__inner{flex-wrap:wrap}
  .site-nav{display:none;width:100%;flex-direction:column;align-items:stretch;gap:var(--s-3);padding:var(--s-4) 0 var(--s-5)}
  .site-nav.is-open{display:flex;animation:navIn .25s var(--ease)}
  .site-nav ul{flex-direction:column;gap:0}
  .site-nav a:not(.btn){display:block;padding:var(--s-3) 0;border-bottom:1px solid var(--c-border);white-space:normal}
  .site-header--transparent-over-hero.is-transparent .site-nav.is-open{background:var(--c-dark);color:var(--c-on-dark);padding-inline:var(--gutter);margin-inline:calc(-1 * var(--gutter));width:calc(100% + 2*var(--gutter))}
  .site-header--centered .site-header__inner{flex-direction:row}
}
@keyframes navIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}

/* heroes */
.hero{position:relative;padding-block:clamp(3.5rem,8vw,7.5rem)}
.hero__copy{max-width:36ch}
.hero__copy h1{margin-bottom:var(--s-5)}
.hero__inner{display:grid;gap:var(--s-7);align-items:center}
.hero--editorial.hero--image-right .hero__inner,.hero--split .hero__inner{grid-template-columns:1fr}
@media (min-width:820px){.hero--editorial.hero--image-right .hero__inner{grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr)}.hero--split .hero__inner{grid-template-columns:1fr 1fr}.hero--split.hero--image-left .hero__media{order:-1}}
.hero--image-below .hero__media{margin-top:var(--s-6)}
.hero--minimal{padding-block:clamp(3rem,6vw,5.5rem)}.hero--centered .hero__copy{margin-inline:auto;text-align:center}.hero--centered .lead,.hero--centered .actions{margin-inline:auto;justify-content:center}
.hero--story .hero__copy{max-width:30ch}.hero--story .hero__media{margin-top:var(--s-7)}
.hero--impact .hero__inner{grid-template-columns:1fr}@media (min-width:1024px){.hero--impact .hero__inner{grid-template-columns:1fr 1fr}}
.hero--impact .stats--strip{margin-top:var(--s-8)}
.hero--bleed{min-height:min(88vh,760px);display:grid;align-items:end;color:#fff;padding-block:clamp(5rem,10vw,9rem)}
.hero--bleed .hero__bg{position:absolute;inset:0;overflow:hidden}.hero--bleed .hero__bg img{width:100%;height:100%;object-fit:cover}
.hero--bleed .hero__scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.78) 0%,rgba(0,0,0,.35) 55%,rgba(0,0,0,.15) 100%)}
.hero--bleed.hero--overlay-dark .hero__scrim{background:rgba(0,0,0,.55)}
.hero--bleed .hero__inner{position:relative}.hero--bleed .lead{color:inherit;opacity:.92}.hero--bleed .eyebrow{color:inherit;opacity:.85}
.hero--bleed .btn--secondary{color:#fff;border-color:rgba(255,255,255,.7)}.hero--bleed .btn--secondary:hover{background:rgba(255,255,255,.12)}
.hero--bleed.hero--bottom-panel .hero__copy{background:var(--c-surface);color:var(--c-fg);padding:var(--s-6);border-radius:var(--r-card)}
.hero--bleed.hero--bottom-panel .lead{color:var(--c-fg-muted)}
.site-header--transparent-over-hero.is-transparent + main .hero--bleed{padding-top:calc(var(--nav-h) + clamp(3rem,8vw,7rem))}

/* patterns */
.cards{display:grid;gap:var(--s-5);grid-template-columns:1fr}
@media (min-width:640px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (min-width:1024px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}}
.card{display:flex;flex-direction:column;gap:var(--s-3);padding:var(--s-6);border-radius:var(--r-card);background:var(--c-surface);border:var(--bw) solid var(--c-border);box-shadow:var(--shadow-sm);min-width:0}
.card h3{margin-bottom:var(--s-2)}.card p{color:var(--c-fg-muted);margin:0}
.card .media{margin:calc(-1 * var(--s-6)) calc(-1 * var(--s-6)) var(--s-3);border-radius:var(--r-card) var(--r-card) 0 0}
.bg-muted .card,.bg-accent-tint .card{border-color:transparent}
.cards--outcomes .stat__value{font-size:var(--fs-h2);margin:0 0 var(--s-2)}
.stats{display:grid;gap:var(--s-6);grid-template-columns:repeat(2,minmax(0,1fr))}
@media (min-width:820px){.stats--row{grid-template-columns:repeat(4,minmax(0,1fr))}.stats--grid{grid-template-columns:repeat(3,minmax(0,1fr))}.stats--band,.stats--strip{grid-template-columns:repeat(4,minmax(0,1fr))}}
.stat{border-left:2px solid var(--c-accent);padding-left:var(--s-4);min-width:0}
.stat__value{display:block;font-family:var(--font-heading);font-weight:var(--fw-heading);font-size:var(--fs-stat);line-height:1;letter-spacing:-.02em;margin-bottom:var(--s-2);overflow-wrap:anywhere}
.stat__label{display:block;color:var(--c-fg-muted);font-size:var(--fs-small);line-height:1.4;max-width:22ch}
.bg-dark .stat,.bg-primary .stat{border-left-color:currentColor}.bg-dark .stat__label,.bg-primary .stat__label{color:inherit;opacity:.85}
.split{display:grid;gap:var(--s-7);align-items:center;grid-template-columns:1fr}
@media (min-width:820px){.split{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.split--image-right .split__media{order:2}}
.split__body .section__head{margin-bottom:var(--s-5)}
.checklist{margin-top:var(--s-5);display:grid;gap:var(--s-3)}.checklist li{padding-left:1.6em;position:relative}.checklist li::before{content:"";position:absolute;left:0;top:.45em;width:.9em;height:.9em;border-radius:50%;background:var(--c-accent)}
.imagetext--image-top .imagetext__media{margin-bottom:var(--s-7)}
.imagetext--image-side{display:grid;gap:var(--s-7);grid-template-columns:1fr}@media (min-width:820px){.imagetext--image-side{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}}
.quote{margin:0}.quote blockquote{margin:0}.quote blockquote p{font-family:var(--font-heading);font-size:var(--fs-h3);line-height:1.35;font-weight:var(--fw-heading)}
.quote--large blockquote p{font-size:var(--fs-h2);line-height:1.2}
.quote figcaption{margin-top:var(--s-5);display:flex;flex-direction:column;gap:2px;color:var(--c-fg-muted);font-size:var(--fs-small)}.quote figcaption strong{color:var(--c-fg)}
.bg-dark .quote figcaption,.bg-primary .quote figcaption,.bg-dark .quote figcaption strong{color:inherit}
.manifesto{margin:0;max-width:24ch;font-family:var(--font-heading);font-weight:var(--fw-heading);line-height:1.12;letter-spacing:var(--tracking-heading)}
.proglist{counter-reset:p;display:grid}
.proglist__item{display:grid;gap:var(--s-3);padding-block:var(--s-6);border-top:var(--bw) solid var(--c-border);min-width:0}
.proglist__item:last-child{border-bottom:var(--bw) solid var(--c-border)}
@media (min-width:820px){.proglist__item{grid-template-columns:4rem minmax(0,18rem) minmax(0,1fr);gap:var(--s-6);align-items:start}.proglist__item h3{margin:0}}
.proglist--numbered .proglist__item::before{counter-increment:p;content:"0" counter(p);font-family:var(--font-heading);font-size:var(--fs-h3);color:var(--c-accent);line-height:1.3}
.proglist--ruled .proglist__item::before{content:"";}
.proglist__item p{margin:0;color:var(--c-fg-muted)}
.feature{display:grid;gap:var(--s-7);grid-template-columns:1fr}@media (min-width:820px){.feature{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)}}
.feature__rest{margin-top:var(--s-5);display:grid;gap:var(--s-3);border-top:var(--bw) solid var(--c-border);padding-top:var(--s-5)}.feature__rest li{color:var(--c-fg-muted)}.feature__rest strong{color:var(--c-fg)}
.steps{display:grid;gap:var(--s-5);counter-reset:s}
.step{position:relative;padding-left:3.5rem;min-width:0}.step::before{counter-increment:s;content:counter(s);position:absolute;left:0;top:0;width:2.5rem;height:2.5rem;border-radius:50%;background:var(--c-primary);color:var(--c-on-primary);display:grid;place-items:center;font-weight:700}
.step h3{margin-bottom:var(--s-2)}.step p{margin:0;color:var(--c-fg-muted)}
@media (min-width:820px){.steps--horizontal{grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}.steps--horizontal .step{padding-left:0;padding-top:3.25rem}}
.testimonial{display:grid;gap:var(--s-7);align-items:center;grid-template-columns:1fr}@media (min-width:820px){.testimonial{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}}
.ways{display:grid;gap:var(--s-5);grid-template-columns:1fr}@media (min-width:820px){.ways{grid-template-columns:repeat(3,minmax(0,1fr))}}
.way{padding-top:var(--s-4);border-top:2px solid var(--c-accent)}.way p{color:var(--c-fg-muted);margin:0}
.cta-band .cta-band__inner{display:grid;gap:var(--s-5);align-items:center}
@media (min-width:820px){.cta-band .cta-band__inner{grid-template-columns:minmax(0,1fr) auto}.cta-band .actions{margin:0;justify-content:flex-end}}
.cta-band .section__head{margin:0;max-width:none}.cta-band .section__head h2{margin-bottom:var(--s-3)}.cta-band .lead{margin:0}
.donate{display:grid;gap:var(--s-7);grid-template-columns:1fr;align-items:start}@media (min-width:820px){.donate{grid-template-columns:minmax(0,3fr) minmax(0,2fr)}}
.donate__panel{padding:var(--s-6);border-radius:var(--r-card);background:var(--c-surface);border:var(--bw) solid var(--c-border);box-shadow:var(--shadow-md)}
.donate__heading{font-size:var(--fs-h3);margin-bottom:var(--s-4)}
.donate__amounts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s-3);margin-bottom:var(--s-4)}@media (min-width:640px){.donate__amounts{grid-template-columns:repeat(4,minmax(0,1fr))}}
.donate__panel .btn--primary{width:100%}
.donate__note{margin-top:var(--s-4);font-size:var(--fs-small);color:var(--c-fg-muted)}
.donate__trust{margin-top:var(--s-4);padding-top:var(--s-4);border-top:var(--bw) solid var(--c-border);display:grid;gap:var(--s-2);font-size:var(--fs-small);color:var(--c-fg-muted)}
.donate__trust li{padding-left:1.4em;position:relative}.donate__trust li::before{content:"✓";position:absolute;left:0;color:var(--c-primary);font-weight:700}
.donate__impact{display:grid;gap:var(--s-4)}.donate__impact li{display:grid;grid-template-columns:5rem minmax(0,1fr);gap:var(--s-4);align-items:baseline;padding-bottom:var(--s-4);border-bottom:var(--bw) solid var(--c-border)}
.donate__impact strong{font-family:var(--font-heading);font-size:var(--fs-h3);color:var(--c-primary)}.donate__impact span{color:var(--c-fg-muted)}
.newsletter{display:grid;gap:var(--s-5)}@media (min-width:820px){.newsletter{grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center}.newsletter .section__head{margin:0}}
.form{display:grid;gap:var(--s-4);max-width:34rem}.form--inline{display:flex;flex-wrap:wrap;gap:var(--s-3);align-items:end;max-width:none}.form--inline .field{flex:1 1 16rem}
.field{display:grid;gap:var(--s-2)}.field label{font-weight:600;font-size:var(--fs-small)}
.field input,.field textarea,.field select{font:inherit;color:inherit;background:var(--c-surface);border:var(--bw) solid var(--c-border);border-radius:var(--r-input);padding:12px 14px;min-height:48px;width:100%}
.field input:focus,.field textarea:focus{border-color:var(--c-primary);outline:0;box-shadow:0 0 0 3px var(--c-primary-tint)}
.contact{display:grid;gap:var(--s-7);grid-template-columns:1fr}@media (min-width:820px){.contact--split{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}}
.contact__details{font-style:normal;display:grid;gap:var(--s-2);align-content:start}.contact__org{font-weight:600}
.faq{display:grid;border-top:var(--bw) solid var(--c-border)}
.faq__item{border-bottom:var(--bw) solid var(--c-border)}.faq__item summary{cursor:pointer;padding:var(--s-4) 0;font-weight:600;font-size:var(--fs-body-lg);list-style:none;display:flex;justify-content:space-between;gap:var(--s-4)}
.faq__item summary::-webkit-details-marker{display:none}.faq__item summary::after{content:"+";color:var(--c-accent);font-size:1.4em;line-height:1;flex:none}.faq__item[open] summary::after{content:"–"}
.faq__answer{padding:0 0 var(--s-5);color:var(--c-fg-muted);max-width:var(--w-narrow)}
.team{display:grid;gap:var(--s-6);grid-template-columns:1fr}@media (min-width:640px){.team--grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (min-width:1024px){.team--grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.person{border-top:2px solid var(--c-accent);padding-top:var(--s-4);min-width:0}.person__name{font-size:var(--fs-h3);margin-bottom:2px}.person__role{color:var(--c-primary);font-weight:600;margin-bottom:var(--s-3);font-size:var(--fs-small)}.person p:last-child{color:var(--c-fg-muted);margin:0}
.logos{display:flex;flex-wrap:wrap;gap:var(--s-3) var(--s-6);color:var(--c-fg-muted);font-weight:600;letter-spacing:.02em}
.strip{display:grid;gap:var(--s-4);grid-template-columns:repeat(2,minmax(0,1fr))}@media (min-width:820px){.strip--3{grid-template-columns:repeat(3,minmax(0,1fr))}}
.section--bleed{padding:0}.bleed{margin:0}.bleed img{width:100%;max-height:min(70vh,640px);object-fit:cover}.bleed figcaption{padding:var(--s-4) 0;color:var(--c-fg-muted);font-size:var(--fs-small)}

/* footer */
.site-footer{background:var(--c-dark);color:var(--c-on-dark);padding-block:var(--s-9) var(--s-7);margin-top:auto}
.site-footer a{color:inherit}
.footer__grid{display:grid;gap:var(--s-7);grid-template-columns:1fr}@media (min-width:820px){.footer__grid{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr)}}
.footer__about .brand{margin:0 0 var(--s-3);font-size:1.3rem;max-width:none}.footer__about p{opacity:.85;max-width:40ch}
.footer__heading{font-size:var(--fs-eyebrow);text-transform:uppercase;letter-spacing:.12em;opacity:.7;margin-bottom:var(--s-4);font-family:var(--font-body);font-weight:600}
.footer__nav ul{display:grid;gap:var(--s-2)}.footer__nav a{text-decoration:none;opacity:.9}.footer__nav a:hover{opacity:1;text-decoration:underline}
.footer__contact address{font-style:normal;display:grid;gap:var(--s-2);opacity:.9}
.footer__legal{margin-top:var(--s-8);padding-top:var(--s-5);border-top:1px solid rgba(255,255,255,.15);display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--s-3);font-size:var(--fs-small);opacity:.85}
.footer__legal p{margin:0}
@media print{.site-header,.nav-toggle,.skip-link{display:none}.hero--bleed{min-height:0;color:inherit}.hero__scrim,.hero__bg{display:none}[data-reveal]{opacity:1;transform:none}}
`;
