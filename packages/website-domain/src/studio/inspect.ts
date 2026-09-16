/**
 * The inspector: renders real pages in headless Chromium and measures them.
 * Both the editor (before it plans and after it changes) and the QA agent
 * (across pages and widths) look at the site through this — never at the
 * markup alone. Everything reported here was observed in a browser.
 *
 * Playwright ships in the API image; when it is not resolvable (tests, a
 * slim image) `available` is false and callers say so instead of guessing.
 */

export interface Box { x: number; y: number; width: number; height: number }

export interface MapElement {
  selector: string;
  role: "heading" | "text" | "button" | "link" | "image";
  tag: string;
  text: string;
  fontSize: number;
  box: Box;
  marginBottom: number;
}
export interface MapSection {
  id: string;
  component: string;
  top: number;
  height: number;
  heading: { selector: string; text: string; fontSize: number } | null;
  elements: MapElement[];
}
export interface PageMap { slug: string; width: number; height: number; scrollWidth: number; sections: MapSection[]; headerHeight: number; footerTop: number }

export interface Measurement {
  selector: string;
  found: boolean;
  fontSize: number | null;
  lineHeight: number | null;
  box: Box | null;
  margin: { top: number; bottom: number } | null;
  padding: { top: number; bottom: number } | null;
  color: string | null;
  backgroundColor: string | null;
  display: string | null;
  text: string;
}

export interface LayoutChecks {
  horizontalOverflow: boolean;
  scrollWidth: number;
  overflowing: Array<{ selector: string; right: number }>;
  overlaps: Array<{ a: string; b: string }>;
  tinyText: Array<{ selector: string; fontSize: number }>;
  smallTapTargets: Array<{ selector: string; width: number; height: number }>;
  brokenImages: string[];
  missingAlt: string[];
  headings: { h1Count: number; skips: string[] };
  nav: { links: number; toggleVisible: boolean; menuWorks: "ok" | "broken" | "n/a" };
  footer: { present: boolean; hasOrgName: boolean; hasContact: boolean; hasLegal: boolean; hasNav: boolean };
  forms: { unlabeled: number; total: number };
  lowContrast: Array<{ selector: string; ratio: number }>;
  emptySections: string[];
  tallGaps: Array<{ after: string; gap: number }>;
}

export interface InspectedPage {
  slug: string;
  viewport: number;
  map: PageMap;
  checks: LayoutChecks;
  measurements: Measurement[];
  screenshot: { mime: string; base64: string } | null;
}

export interface InspectArgs {
  pages: Array<{ slug: string; html: string }>;
  /** "/images/hero.png" → bytes, so the page renders as it will be served. */
  assets?: Record<string, Buffer>;
  viewports: number[];
  /** Selectors to measure precisely on every page × viewport. */
  targets?: string[];
  /** Screenshot at these widths (full page, JPEG). */
  screenshotAt?: number[];
  /** Try the mobile menu where a toggle is visible. */
  interactions?: boolean;
  siteName?: string;
}

// Runs inside the page. Kept as a string so nothing here depends on DOM types.
const PAGE_SCRIPT = `(function(args){
  var d=document, W=innerWidth;
  function sel(el){
    if(!el||el===d.body)return 'body';
    if(el.id)return '#'+CSS.escape(el.id);
    var sec=el.closest('section[id], header, footer');
    var base=sec?(sec.id?'#'+CSS.escape(sec.id):sec.tagName.toLowerCase()):'';
    var tag=el.tagName.toLowerCase();
    var cls=[].slice.call(el.classList).filter(function(c){return !/^(is-|has-|t-)/.test(c)})[0];
    var part=tag+(cls?'.'+CSS.escape(cls):'');
    var scope=sec||d.body;
    var same=[].slice.call(scope.querySelectorAll(part));
    if(same.length>1){var i=same.indexOf(el);if(i>=0)part=part+':nth-of-type('+([].slice.call(el.parentElement.children).filter(function(c){return c.tagName===el.tagName}).indexOf(el)+1)+')';
      var withParent=(el.parentElement&&el.parentElement!==scope?sel(el.parentElement)+' > ':'')+part; return base&&withParent.indexOf(base)!==0?base+' '+withParent:withParent;}
    return base?base+' '+part:part;
  }
  function num(v){var n=parseFloat(v);return isNaN(n)?0:n}
  function box(el){var r=el.getBoundingClientRect();return {x:Math.round(r.left+scrollX),y:Math.round(r.top+scrollY),width:Math.round(r.width),height:Math.round(r.height)}}
  function text(el){return (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160)}
  function visible(el){var r=el.getBoundingClientRect();var cs=getComputedStyle(el);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'&&cs.opacity!=='0'}
  function role(el){var t=el.tagName.toLowerCase();if(/^h[1-6]$/.test(t))return 'heading';if(t==='img')return 'image';if(t==='button'||el.classList.contains('btn'))return 'button';if(t==='a')return 'link';return 'text'}
  // ---- page map
  var sections=[].slice.call(d.querySelectorAll('main section, main > article, main > div[id]'));
  var map={slug:args.slug,width:W,height:Math.round(d.documentElement.scrollHeight),scrollWidth:Math.round(d.documentElement.scrollWidth),headerHeight:0,footerTop:0,sections:[]};
  var hd=d.querySelector('header');if(hd)map.headerHeight=Math.round(hd.getBoundingClientRect().height);
  var ft=d.querySelector('footer');if(ft)map.footerTop=Math.round(ft.getBoundingClientRect().top+scrollY);
  sections.forEach(function(s){
    if(!visible(s))return;
    var b=box(s);
    var comp=[].slice.call(s.classList).find(function(c){return /^(hero|section)--/.test(c)})||[].slice.call(s.classList)[0]||s.tagName.toLowerCase();
    var els=[];
    [].slice.call(s.querySelectorAll('h1,h2,h3,p,.lead,a.btn,button,img')).forEach(function(el){
      if(els.length>=14||!visible(el))return; if(el.closest('section')!==s&&s.tagName!=='SECTION')return;
      var cs=getComputedStyle(el);
      els.push({selector:sel(el),role:role(el),tag:el.tagName.toLowerCase(),text:el.tagName==='IMG'?(el.getAttribute('alt')||''):text(el),fontSize:num(cs.fontSize),box:box(el),marginBottom:num(cs.marginBottom)});
    });
    var h=s.querySelector('h1,h2');
    map.sections.push({id:s.id||('section-'+map.sections.length),component:comp,top:b.y,height:b.height,heading:h?{selector:sel(h),text:text(h),fontSize:num(getComputedStyle(h).fontSize)}:null,elements:els});
  });
  // ---- measurements
  var measurements=(args.targets||[]).map(function(q){
    var el=null;try{el=d.querySelector(q)}catch(e){}
    if(!el)return {selector:q,found:false,fontSize:null,lineHeight:null,box:null,margin:null,padding:null,color:null,backgroundColor:null,display:null,text:''};
    var cs=getComputedStyle(el);
    return {selector:q,found:true,fontSize:num(cs.fontSize),lineHeight:num(cs.lineHeight)||null,box:box(el),margin:{top:num(cs.marginTop),bottom:num(cs.marginBottom)},padding:{top:num(cs.paddingTop),bottom:num(cs.paddingBottom)},color:cs.color,backgroundColor:cs.backgroundColor,display:cs.display,text:text(el)};
  });
  // ---- checks
  var checks={horizontalOverflow:d.documentElement.scrollWidth>W+1,scrollWidth:d.documentElement.scrollWidth,overflowing:[],overlaps:[],tinyText:[],smallTapTargets:[],brokenImages:[],missingAlt:[],headings:{h1Count:d.querySelectorAll('h1').length,skips:[]},nav:{links:0,toggleVisible:false,menuWorks:'n/a'},footer:{present:!!ft,hasOrgName:false,hasContact:false,hasLegal:false,hasNav:false},forms:{unlabeled:0,total:0},lowContrast:[],emptySections:[],tallGaps:[]};
  [].slice.call(d.querySelectorAll('main *')).forEach(function(el){
    if(checks.overflowing.length>=10||!visible(el))return; var r=el.getBoundingClientRect();
    if(r.right>W+2&&r.width<=W*1.5&&getComputedStyle(el).position!=='fixed')checks.overflowing.push({selector:sel(el),right:Math.round(r.right)});
  });
  var textEls=[].slice.call(d.querySelectorAll('main p, main li, main a, main h1, main h2, main h3, main span, footer p, footer a, footer li'));
  textEls.forEach(function(el){ if(checks.tinyText.length>=10||!visible(el)||!text(el))return; var fs=num(getComputedStyle(el).fontSize); if(fs<12)checks.tinyText.push({selector:sel(el),fontSize:fs}); });
  if(W<700){[].slice.call(d.querySelectorAll('a.btn, button, nav a')).forEach(function(el){ if(checks.smallTapTargets.length>=10||!visible(el))return; var r=el.getBoundingClientRect(); if(r.height<36||r.width<36)checks.smallTapTargets.push({selector:sel(el),width:Math.round(r.width),height:Math.round(r.height)}); });}
  [].slice.call(d.images).forEach(function(img){ var src=img.getAttribute('src')||''; if(img.complete&&img.naturalWidth===0&&!/^data:/.test(src)&&visible(img))checks.brokenImages.push(src); if(!img.hasAttribute('alt'))checks.missingAlt.push(src); });
  var last=0;[].slice.call(d.querySelectorAll('h1,h2,h3,h4,h5,h6')).forEach(function(h){ var n=+h.tagName[1]; if(last&&n>last+1)checks.headings.skips.push(h.tagName.toLowerCase()+' after h'+last); last=n; });
  var nav=d.querySelector('header nav');checks.nav.links=nav?nav.querySelectorAll('a').length:0;
  var toggle=d.querySelector('.nav-toggle');checks.nav.toggleVisible=!!(toggle&&visible(toggle));
  if(ft){var ftxt=text(ft).toLowerCase();checks.footer.hasOrgName=!!args.siteName&&ftxt.indexOf(args.siteName.toLowerCase())>=0;checks.footer.hasContact=!!ft.querySelector('a[href^="mailto:"],a[href^="tel:"],address');checks.footer.hasLegal=/©|copyright|privacy/.test(ftxt);checks.footer.hasNav=!!ft.querySelector('nav');}
  [].slice.call(d.querySelectorAll('input:not([type=hidden]),textarea,select')).forEach(function(i){checks.forms.total++;var id=i.id;var lab=id&&d.querySelector('label[for="'+CSS.escape(id)+'"]');if(!lab&&!i.getAttribute('aria-label')&&!i.closest('label'))checks.forms.unlabeled++;});
  // overlaps between sibling blocks inside sections (visible, non-nested)
  map.sections.forEach(function(s){ var el=d.getElementById(s.id); if(!el)return; var kids=[].slice.call(el.querySelectorAll('.container > *, .hero__inner > *, .split > *, .cards > *, .stats > *')).filter(visible).slice(0,12);
    for(var i=0;i<kids.length&&checks.overlaps.length<10;i++)for(var j=i+1;j<kids.length;j++){ if(kids[i].contains(kids[j])||kids[j].contains(kids[i]))continue; var a=kids[i].getBoundingClientRect(),b=kids[j].getBoundingClientRect(); var ox=Math.min(a.right,b.right)-Math.max(a.left,b.left),oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top); if(ox>12&&oy>12&&getComputedStyle(kids[i]).position==='static'&&getComputedStyle(kids[j]).position==='static')checks.overlaps.push({a:sel(kids[i]),b:sel(kids[j])}); }
    if(!text(el))checks.emptySections.push(s.id);
  });
  for(var k=1;k<map.sections.length;k++){var gap=map.sections[k].top-(map.sections[k-1].top+map.sections[k-1].height);if(gap>160)checks.tallGaps.push({after:map.sections[k-1].id,gap:Math.round(gap)});}
  // contrast: text colour vs nearest painted background
  function rgb(s){var m=/rgba?\\(([^)]+)\\)/.exec(s||'');if(!m)return null;var p=m[1].split(',').map(function(x){return parseFloat(x)});if(p.length>3&&p[3]===0)return null;return p;}
  function lum(c){var f=function(v){v=v/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2])}
  function bgOf(el){while(el&&el!==d.documentElement){var c=rgb(getComputedStyle(el).backgroundColor);if(c)return c;var bi=getComputedStyle(el).backgroundImage;if(bi&&bi!=='none')return null;el=el.parentElement}return [255,255,255]}
  textEls.forEach(function(el){ if(checks.lowContrast.length>=8||!visible(el)||!text(el))return; var fg=rgb(getComputedStyle(el).color),bg=bgOf(el); if(!fg||!bg)return; var l1=lum(fg),l2=lum(bg),ratio=(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); var fs=num(getComputedStyle(el).fontSize); var need=fs>=24?3:4.5; if(ratio<need)checks.lowContrast.push({selector:sel(el),ratio:Math.round(ratio*100)/100}); });
  return {map:map,measurements:measurements,checks:checks};
})`;

const MENU_SCRIPT = `(function(){var t=document.querySelector('.nav-toggle'),m=document.querySelector('.site-nav');if(!t||!m)return 'n/a';var r=t.getBoundingClientRect();if(!r.width)return 'n/a';t.click();var open=m.classList.contains('is-open')&&t.getAttribute('aria-expanded')==='true'&&m.getBoundingClientRect().height>0;t.click();return open?'ok':'broken';})()`;

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

export async function inspectPages(args: InspectArgs): Promise<{ available: boolean; pages: InspectedPage[]; reason?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any = null;
  try { const name = "playwright"; playwright = await import(name); } catch (err) { return { available: false, pages: [], reason: `playwright unavailable: ${String((err as Error).message ?? err).slice(0, 120)}` }; }
  if (!playwright?.chromium) return { available: false, pages: [], reason: "chromium unavailable" };
  let browser: { newContext: (o: unknown) => Promise<any>; close: () => Promise<void> };
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (err) {
    return { available: false, pages: [], reason: `chromium could not start: ${String((err as Error).message ?? err).slice(0, 160)}` };
  }
  const out: InspectedPage[] = [];
  const assets = args.assets ?? {};
  try {
    for (const vp of args.viewports) {
      const context = await browser.newContext({ viewport: { width: vp, height: vp < 700 ? 844 : vp < 1100 ? 1024 : 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      // Only the release's own images load; everything else is refused, so
      // the render never depends on the network.
      await context.route("**/*", (route: { request: () => { url: () => string }; continue: () => void; abort: () => void; fulfill: (o: unknown) => void }) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("about:")) return route.continue();
        let path = "";
        try { path = new URL(url).pathname; } catch { /* not a url */ }
        const bytes = assets[path];
        if (bytes) { const ext = path.split(".").pop() ?? "png"; return route.fulfill({ status: 200, contentType: CONTENT_TYPES[ext] ?? "application/octet-stream", body: bytes }); }
        return route.abort();
      });
      for (const p of args.pages) {
        const page = await context.newPage();
        try {
          await page.setContent(p.html, { waitUntil: "load" });
          // Reveal-on-scroll elements start invisible; the inspector sees the final layout.
          await page.addStyleTag({ content: "[data-reveal],[data-reveal='stagger']>*{opacity:1!important;transform:none!important}[data-reveal='image'] img{clip-path:none!important}" });
          await page.evaluate("document.fonts && document.fonts.ready");
          const result = await page.evaluate(`${PAGE_SCRIPT}(${JSON.stringify({ slug: p.slug, targets: args.targets ?? [], siteName: args.siteName ?? "" })})`) as { map: PageMap; measurements: Measurement[]; checks: LayoutChecks };
          if (args.interactions && result.checks.nav.toggleVisible) {
            try { result.checks.nav.menuWorks = await page.evaluate(MENU_SCRIPT) as LayoutChecks["nav"]["menuWorks"]; } catch { result.checks.nav.menuWorks = "broken"; }
          }
          let screenshot: InspectedPage["screenshot"] = null;
          if (args.screenshotAt?.includes(vp)) {
            const buf: Buffer = await page.screenshot({ fullPage: true, type: "jpeg", quality: 62 });
            screenshot = { mime: "image/jpeg", base64: buf.toString("base64") };
          }
          out.push({ slug: p.slug, viewport: vp, map: result.map, checks: result.checks, measurements: result.measurements, screenshot });
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return { available: true, pages: out };
}

/** A compact, model-readable version of a page map: what is on the page,
 *  with the selectors the planner can use. */
export function describeMap(map: PageMap): string {
  const lines = [`Page "${map.slug}" at ${map.width}px wide, ${map.height}px tall${map.scrollWidth > map.width + 1 ? ` — OVERFLOWS horizontally to ${map.scrollWidth}px` : ""}. Header ${map.headerHeight}px.`];
  for (const s of map.sections) {
    lines.push(`- section #${s.id} (${s.component}) top ${s.top}px, height ${s.height}px${s.heading ? `; heading "${s.heading.text.slice(0, 80)}" ${Math.round(s.heading.fontSize)}px via ${s.heading.selector}` : ""}`);
    for (const e of s.elements.slice(0, 10)) lines.push(`    · ${e.role} ${e.selector} ${Math.round(e.fontSize)}px ${e.box.width}×${e.box.height} "${e.text.slice(0, 60)}"`);
  }
  return lines.join("\n");
}
