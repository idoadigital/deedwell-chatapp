/**
 * The markup contract every generated site is built on.
 *
 * The designer decides how these patterns LOOK (it writes the CSS from the
 * reference image); page writers decide which patterns a page uses and in what
 * order. Nobody invents markup. That is what keeps ten pages reading as one
 * site, keeps the accessibility and Ad Grants rules checkable, and lets the
 * shell (head, header, footer, skip link) be assembled deterministically.
 */
export const SECTION_CONTRACT = `
MARKUP CONTRACT — use exactly these class names and structures.

Layout
  .container            centred content column (max-width ~1140px, side padding)
  .container--narrow    ~760px reading column
  .btn                  button-shaped link; variants .btn--primary .btn--secondary .btn--ghost
  .skip-link            visually hidden until focused; first element in <body>
  .visually-hidden      screen-reader-only text

Header (one per page, shared)
  <header class="site-header"><div class="container site-header__inner">
    <a class="brand" href="/">{site name}</a>
    <nav class="site-nav" aria-label="Main"><ul>
      <li><a href="/about/">About</a></li> … AT MOST FIVE <li>
    </ul></nav>
    <a class="btn btn--primary site-header__cta" href="{donate or contact}">Donate</a>
  </div></header>
  On screens under 720px the nav may be a <details class="site-nav__menu"><summary>Menu</summary>…</details>.

Sections (inside <main id="main">; each is a <section> with one h2 except the hero's h1)
  <section class="hero [hero--image|hero--band|hero--split]">
    <div class="container hero__inner">
      <div class="hero__copy">
        <p class="eyebrow">…</p>            optional
        <h1 class="hero__title">…</h1>
        <p class="hero__lead">…</p>
        <div class="hero__actions"><a class="btn btn--primary" href="…">…</a><a class="btn btn--secondary" href="…">…</a></div>
      </div>
      <figure class="hero__media"><img src="/images/{key}.png" alt="…"></figure>   optional
    </div>
  </section>
  <section class="section [section--band|section--accent]"><div class="container">
    <div class="section__head"><p class="eyebrow">…</p><h2 class="section__title">…</h2><p class="section__intro">…</p></div>
    …one of the patterns below…
  </div></section>

  Patterns
  .prose                       <div class="prose"><p>…</p></div>
  .cards                       <div class="cards"><article class="card"><h3>…</h3><p>…</p><a class="card__link" href="…">…</a></article>…</div>
  .stats                       <ul class="stats"><li class="stat"><span class="stat__value">…</span><span class="stat__label">…</span></li>…</ul>
  .split                       <div class="split [split--reverse]"><figure class="split__media"><img src="/images/{key}.png" alt="…"></figure><div class="split__body"><h3>…</h3><p>…</p><ul class="checklist"><li>…</li></ul></div></div>
  .quote                       <figure class="quote"><blockquote><p>…</p></blockquote><figcaption>…</figcaption></figure>
  .steps                       <ol class="steps"><li class="step"><h3>…</h3><p>…</p></li>…</ol>
  .faq                         <div class="faq"><details class="faq__item"><summary>…</summary><div class="faq__answer"><p>…</p></div></details>…</div>
  .team                        <ul class="team"><li class="person"><h3 class="person__name">…</h3><p class="person__role">…</p><p>…</p></li>…</ul>
  .logos                       <ul class="logos"><li>…</li>…</ul>
  .cta-band                    <section class="cta-band"><div class="container cta-band__inner"><h2>…</h2><p>…</p><a class="btn btn--primary" href="…">…</a></div></section>
  .donate (the donation module) <div class="donate">
                                 <div class="donate__panel">
                                   <h3 class="donate__heading">Choose an amount</h3>
                                   <div class="donate__amounts"><a class="btn btn--amount" href="{donateUrl}">$25</a><a class="btn btn--amount" href="{donateUrl}">$50</a><a class="btn btn--amount btn--featured" href="{donateUrl}">$100</a><a class="btn btn--amount" href="{donateUrl}">$250</a></div>
                                   <a class="btn btn--primary donate__give" href="{donateUrl}">Give securely</a>
                                   <p class="donate__note">Monthly giving available on the secure donation page.</p>
                                   <ul class="donate__trust"><li>Secure, encrypted donation page</li><li>{legal name} is a registered {status}</li><li>EIN {ein}</li></ul>
                                 </div>
                                 <ul class="donate__impact"><li><strong>$25</strong> …what it provides…</li>…</ul>
                               </div>
                               Without a donateUrl, the panel becomes <form class="form donate__form" method="post" action="{form action}"> asking for name, email and intended amount, with a note that the team will follow up — never a fake payment form.
  .contact                     <div class="contact"><address class="contact__details">…email, phone, address as <a href="mailto:"> <a href="tel:"> text…</address><form class="form" method="post" action="{form action}">…</form></div>
  form fields                  <div class="field"><label for="{id}">…</label><input id="{id}" name="…" type="…" required></div>; textarea likewise; <button class="btn btn--primary" type="submit">…</button>; include <input type="hidden" name="website" value="">

Footer (one per page, shared)
  <footer class="site-footer"><div class="container">
    <div class="footer__grid">
      <div class="footer__about"><p class="brand">{site name}</p><p>{one-line mission}</p></div>
      <nav class="footer__nav" aria-label="Footer"><h2 class="footer__heading">Pages</h2><ul><li><a href="…">…</a></li> … EVERY page</ul></nav>
      <div class="footer__contact"><h2 class="footer__heading">Contact</h2><address>…</address></div>
    </div>
    <div class="footer__legal"><p>{legal name} is a registered {status}. EIN {ein}.</p><p>© {year} {legal name}. <a href="/privacy-policy/">Privacy policy</a></p></div>
  </div></footer>
`.trim();

/** Class names the design system's CSS must style; used to validate it. */
export const REQUIRED_STYLE_HOOKS = [
  ".container", ".btn", ".btn--primary", ".skip-link", ".site-header", ".site-nav", ".hero", ".hero__title",
  ".section", ".section__title", ".cards", ".card", ".stats", ".stat__value", ".split", ".quote", ".steps",
  ".faq", ".team", ".cta-band", ".donate", ".donate__amounts", ".contact", ".field", ".site-footer", ".footer__legal",
];
