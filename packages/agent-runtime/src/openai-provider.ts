import type { ModelProvider, ModelRequest, ModelResponse } from "./index.js";

/**
 * Real OpenAI adapter behind the ModelProvider seam (ADR-0003). Uses the
 * plain HTTPS Chat Completions API with JSON-mode output; runAgentTask's zod
 * validation + bounded retries handle any schema drift.
 *
 * Requires OPENAI_API_KEY. Model via OPENAI_MODEL (default gpt-4o-mini).
 */
export type ApiKeySource = string | (() => Promise<string | null>);

/** Newest general model on the account, from what the API actually lists:
 *  the highest plain "gpt-N[.M]" id, never a mini/nano/dated variant. */
export async function newestOpenAiModel(apiKey: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OpenAI model list failed (${res.status})`);
  const { data } = (await res.json()) as { data: Array<{ id: string }> };
  const ranked = data
    .map((m) => m.id.match(/^gpt-(\d+)(?:\.(\d+))?$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ id: m[0], major: Number(m[1]), minor: Number(m[2] ?? 0) }))
    .sort((a, b) => b.major - a.major || b.minor - a.minor);
  const pick = ranked[0]?.id ?? (data.some((m) => m.id === "gpt-4.1") ? "gpt-4.1" : "gpt-4o");
  console.log(JSON.stringify({ at: "openai_model_selected", model: pick, candidates: ranked.slice(0, 5).map((r) => r.id) }));
  return pick;
}

export class OpenAiProvider implements ModelProvider {
  readonly name = "openai";
  private readonly keySource: ApiKeySource;
  private readonly modelSetting: string;
  private resolvedModel: string | null = null;
  private readonly baseUrl: string;

  /** `apiKey` may be a value or an async source (a key kept by Platform
   *  Admin, say); `model` "auto" picks the account's newest general model. */
  constructor(opts: { apiKey?: ApiKeySource; model?: string; baseUrl?: string } = {}) {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OpenAiProvider requires OPENAI_API_KEY (or MODEL_PROVIDER=mock)");
    }
    this.keySource = key;
    this.modelSetting = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  }

  private async apiKey(): Promise<string> {
    const key = typeof this.keySource === "string" ? this.keySource : await this.keySource();
    if (!key) throw new Error("No OpenAI API key is configured — add one in Platform Admin → Developer.");
    return key;
  }

  private async model(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;
    this.resolvedModel = this.modelSetting === "auto"
      ? await newestOpenAiModel(await this.apiKey(), this.baseUrl)
      : this.modelSetting;
    return this.resolvedModel;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const requestId = Math.random().toString(36).slice(2, 10);
    const started = Date.now();
    const html = request.responseFormat === "html";
    const user = [
      `TASK: ${request.task}`,
      ``,
      html
        ? `Respond with ONLY the complete HTML document described in your instructions, starting with <!doctype html>. No prose, no markdown fences.`
        : `Respond with ONLY a single JSON object conforming to the "${request.outputSchemaRef}" output contract described in your instructions. No prose, no markdown fences.`,
      ``,
      ...request.dataBlocks.map(
        (b) =>
          `<<<DOCUMENT label="${b.label}">>>\n${b.content}${b.image ? "\n(An image for this document is attached.)" : ""}\n<<<END DOCUMENT>>>`
      ),
    ].join("\n");
    const images = request.dataBlocks.filter((b) => b.image);
    const userContent = images.length
      ? [
          { type: "text", text: user },
          ...images.map((b) => ({ type: "image_url", image_url: { url: `data:${b.image!.mime};base64,${b.image!.base64}` } })),
        ]
      : user;

    const model = await this.model();
    // Reasoning models (gpt-5 and o-series) take no temperature and budget
    // output with max_completion_tokens, which also covers their thinking.
    const reasoning = /^(gpt-5|o\d)/.test(model);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.apiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        ...(reasoning ? {} : { temperature: html ? 0.4 : 0.2 }),
        ...(html ? { max_completion_tokens: reasoning ? 60_000 : 16_000 } : {}),
        ...(html ? {} : { response_format: { type: "json_object" } }),
        messages: [
          { role: "system", content: request.system + "\n\n" + SCHEMA_HINTS[request.outputSchemaRef] },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(html ? 480_000 : 90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const payload = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { total_tokens?: number };
    };
    const text = payload.choices[0]?.message?.content ?? "";
    const cleaned = html ? text.trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "") : text;
    const tokens = payload.usage?.total_tokens ?? Math.ceil(text.length / 4);
    console.log(JSON.stringify({
      at: "model_request", requestId, provider: "openai", model,
      schema: request.outputSchemaRef, ms: Date.now() - started, tokens, ok: true,
    }));
    return { text: cleaned, tokensEstimated: tokens };
  }
}

/** Compact output-shape descriptions appended to the system prompt per schema.
 *  Shared with the Gemini adapter — the contract is the seam's, not the vendor's. */
export const SCHEMA_HINTS: Record<ModelRequest["outputSchemaRef"], string> = {
  design_language: `Output JSON shape: {"style":"editorial-modern"|"editorial-classic"|"warm-community"|"bold-expressive"|"minimal-corporate"|"civic-institutional"|"playful-friendly","mood":string,"density":"spacious"|"balanced"|"compact","rhythm":"alternating-bands"|"continuous"|"image-led"|"text-led","contentWidth":"1100"|"1200"|"1320"|"1440","sectionSpacing":"generous"|"standard"|"tight","whitespace":string,"background":"light"|"warm-light"|"dark"|"alternating"|"tinted-bands","typography":{"headingStyle":"serif-editorial"|"serif-classic"|"sans-geometric"|"sans-humanist"|"sans-grotesque"|"display-condensed","bodyStyle":"serif"|"sans","headingScale":"restrained"|"controlled"|"large"|"dramatic","bodyScale":"compact"|"comfortable"|"generous","weightContrast":"low"|"medium"|"high","letterCase":"sentence"|"title"|"uppercase-eyebrows"},"radius":"none"|"small"|"medium"|"large"|"pill","cards":"none"|"minimal"|"bordered"|"elevated"|"filled","buttons":"square"|"rounded"|"pill"|"underline","navigation":"transparent-over-hero"|"light-minimal"|"dark-minimal"|"floating-editorial"|"centered","imageTreatment":"full-bleed-editorial"|"large-contained"|"rounded-contained"|"duotone-overlay"|"sparse","grid":"strict-12"|"asymmetric"|"single-column-editorial"|"mixed","alignment":"left"|"centered"|"mixed","transitions":"hard-bands"|"soft-tints"|"none","fullWidthImagery":boolean,"overlays":boolean,"gradients":"none"|"subtle"|"prominent","contrast":"light-dominant"|"dark-dominant"|"mixed","layoutCharacter":"editorial"|"corporate"|"expressive","symmetry":"symmetric"|"asymmetric"|"mixed","decorative":string[],"motionStyle":"none"|"subtle"|"subtle-cinematic"|"lively","motionOpportunities":string[],"palette":{"primary":"#rrggbb","secondary"?:"#rrggbb","accent"?:"#rrggbb","background"?:"#rrggbb","notes"?:string}}. Describe the design LANGUAGE of the image, never its content.`,
  design_tokens: `Output JSON shape: {"typography":{"headingFamily":"serif-editorial"|"serif-classic"|"sans-geometric"|"sans-humanist"|"sans-grotesque"|"display-condensed","bodyFamily":"serif"|"sans","scale":"restrained"|"controlled"|"large"|"dramatic","bodySize":"compact"|"comfortable"|"generous","headingWeight":"500"|"600"|"700"|"800","bodyWeight":"400"|"450","headingLetterSpacing":"tight"|"normal"|"wide","eyebrowCase":"uppercase"|"normal"},"spacing":{"density":"spacious"|"balanced"|"compact","sectionPadding":"generous"|"standard"|"tight"},"colors":{"primary":"#rrggbb","secondary":"#rrggbb","accent":"#rrggbb","background":"#rrggbb","surface":"#rrggbb","muted":"#rrggbb","foreground":"#rrggbb","foregroundMuted":"#rrggbb","border":"#rrggbb","onPrimary":"#rrggbb","onAccent":"#rrggbb","dark":"#rrggbb","onDark":"#rrggbb"},"layout":{"contentWidth":"1100"|"1200"|"1320"|"1440","narrowWidth":"680"|"760"|"820","gutter":"16"|"20"|"24","grid":"strict-12"|"asymmetric"|"single-column-editorial"|"mixed","alignment":"left"|"centered"|"mixed"},"components":{"buttonRadius":"0"|"4"|"8"|"12"|"999","inputRadius":"0"|"4"|"8"|"12","cardRadius":"0"|"8"|"12"|"16"|"24","imageRadius":"0"|"8"|"12"|"16"|"24","borderWidth":"1"|"2","shadow":"none"|"soft"|"medium","cardStyle":"none"|"minimal"|"bordered"|"elevated"|"filled","buttonStyle":"square"|"rounded"|"pill"|"underline","navHeight":"64"|"72"|"80"|"88","iconSize":"20"|"24"|"28"},"header":"transparent-over-hero"|"light-minimal"|"dark-minimal"|"floating-editorial"|"centered","imageTreatment":"full-bleed-editorial"|"large-contained"|"rounded-contained"|"duotone-overlay"|"sparse","motion":"none"|"subtle"|"subtle-cinematic"|"lively","backgroundRhythm":"light"|"warm-light"|"dark"|"alternating"|"tinted-bands"}. Every colour a real hex; foreground on background and onPrimary on primary must clear 4.5:1 contrast.`,
  page_composition: `Output JSON shape: {"slug":string,"objective":string,"primaryCta":{"label":string,"href":string}|null,"secondaryCta":{"label":string,"href":string}|null,"sections":[{"id":string,"purpose":string,"component":<one of the catalog names>,"variant"?:string,"background":"default"|"muted"|"surface"|"dark"|"primary"|"accent-tint","imagePosition":"none"|"left"|"right"|"background"|"top"|"full","image":string|null,"block":number,"density":"airy"|"balanced"|"dense","motion":"none"|"fade-up"|"stagger"|"image-reveal"|"count"|"parallax","mobile":"stack"|"carousel-free"|"collapse","overrides"?:{"eyebrow"?:string,"heading"?:string,"body"?:string}}]}. One section per content block, in order, "block" = the block's index. Choose components from the catalog only.`,
  design_critique: `Output JSON shape: {"scores":{"visualHierarchy":1-10,"typography":1-10,"spacing":1-10,"alignment":1-10,"consistency":1-10,"readability":1-10,"imageComposition":1-10,"ctaClarity":1-10,"brandConsistency":1-10,"animationQuality":1-10,"responsiveQuality":1-10,"accessibility":1-10,"overallPolish":1-10},"issues":[{"section":string|null,"problem":string,"severity":"low"|"medium"|"high","fix":"reduce-heading-scale"|"shorten-copy"|"change-variant"|"swap-image-position"|"change-background"|"increase-spacing"|"reduce-spacing"|"remove-motion"|"split-section"|"remove-section"|"left-align"|"constrain-width"|"none","value"?:string}]}. Identify defects; do not redesign.`,
  site_html: `Output: one complete, standalone HTML5 document for the single page named in page_plan — <!doctype html>, <html lang="en">, <head> with <meta charset="utf-8">, <meta name="viewport">, <title>, <meta name="description">, and exactly ONE <style> element holding all CSS; then <body> with a skip link, one <header> containing a <nav> that links to EVERY page listed in "site_nav" using the exact hrefs given, one <main> with exactly one <h1>, and one <footer>. No <script>, no <link>, no external fonts, stylesheets, images or iframes; visuals come from CSS (gradients, shapes, borders) and inline <svg>. No <img> unless its src is a data: URI. Any form: method="post", the exact action given in "site_forms", a hidden input named "website" left empty, and every input/textarea has an id with a matching <label for>. Output the HTML only.`,
  requirements_extraction: `Output JSON shape: {"requirements":[{"text":string,"kind":"eligibility"|"narrative"|"budget"|"attachment"|"formatting"|"deadline"|"other","mandatory":boolean,"sourceLocation":{"line":number,"quote":string},"wordLimit":number|null}],"documentSummary":string}. Line numbers are 1-based lines of the document block.`,
  fact_extraction: `Output JSON shape: {"facts":[{"key":snake_case string,"value":string,"sourceLocation":{"line":number,"quote":string}}],"documentSummary":string}. Every fact MUST quote the exact sentence it came from and its 1-based line number. Extract only facts the document states outright — never infer, estimate, or round a number. If nothing in the document supports a fact worth recording, return an empty facts array rather than guessing.`,
  section_draft: `Output JSON shape: {"title":string,"body":string,"claims":[{"text":string,"factKey":string|null,"support":"verified"|"user_certified"|"estimate"|"assumption"|"unsupported","flagged":boolean}],"wordCount":number}. Every material claim must appear in claims with the org_facts key it rests on, or factKey null + support "unsupported" + flagged true.`,
  section_plan: `Output JSON shape: {"sections":[{"title":string,"objective":string,"wordLimit":number|null,"requirementLines":number[]}],"activities":string[]} (max 12 sections, max 20 activities).`,
  budget: `Output JSON shape: {"currency":"USD","items":[{"category":"personnel"|"direct"|"indirect"|"equipment"|"travel"|"other","description":string,"activity":string,"quantity":number,"unitCost":number}],"narrative":string}. Every item's activity must be one of the provided activities.`,
  logic_model: `Output JSON shape: {"problem":string,"inputs":string[],"activities":string[],"outputs":string[],"outcomes":string[],"impact":string,"indicators":[{"outcome":string,"indicator":string,"baseline":string,"target":string,"source":string,"frequency":string}]}.`,
  review_panel: `Output JSON shape: {"reviews":[{"reviewer":"program"|"financial"|"compliance"|"skeptic","criterion":string,"score":number(0-5),"maxScore":5,"strengths":string,"weaknesses":string,"fatalFlaw":boolean}],"revisionRecommendations":string[]} with at least 4 reviews.`,
  website_brief: `Output JSON shape: {"objectives":string[],"audiences":string[],"tone":string,"sitemap":[{"slug":string(lowercase-kebab),"title":string,"purpose":string}],"theme":{"palette":"forest"|"ocean"|"slate"|"sunrise"|"plum"|"meadow"|"harvest"|"midnight","headingFont":"serif"|"sans","design"?:{"accent"?:"#rrggbb","heroStyle"?:"left"|"centered"|"split"|"banner","corners"?:"sharp"|"soft"|"round","density"?:"airy"|"balanced"|"compact","typeScale"?:"quiet"|"balanced"|"bold","buttonStyle"?:"pill"|"rounded"|"square","bodyFont"?:"sans"|"serif","navStyle"?:"plain"|"bar"}}}. Pick the palette matching the requested visual direction and any brand colours given; "midnight" is the dark option. Fill "design" only from a supplied design_reference image, otherwise omit it.`,
  site_content: `Output JSON shape: {"pages":[{"slug":string,"title":string,"seoDescription":string,"blocks":[...]}],"placeholders":string[]}. Block shapes: {"kind":"hero","heading","tagline","ctaText":string|null,"ctaHref":string|null,"eyebrow":string|null,"secondaryText":string|null,"secondaryHref":string|null} | {"kind":"text","heading":string|null,"body"} | {"kind":"split","heading","body","highlights":string[],"ctaText":string|null,"ctaHref":string|null} | {"kind":"programs","heading","items":[{"name","description"}]} | {"kind":"stats","items":[{"label","value"}]} | {"kind":"quote","quote","attribution":string|null,"role":string|null} | {"kind":"steps","heading","intro":string|null,"items":[{"title","body"}]} | {"kind":"faq","heading","items":[{"q","a"}]} | {"kind":"team","heading","members":[{"name","role","bio":string|null}]} | {"kind":"logos","heading","names":string[]} | {"kind":"cta","heading","buttonText","href"} | {"kind":"donate","heading","body":string|null,"href","tiers":[{"amount","effect"}],"buttonText"} | {"kind":"form","formKey":lowercase-kebab,"heading","fields":[{"key":snake_case,"label","type":"text"|"email"|"textarea","required":boolean}]} | {"kind":"contact","email":string|null,"phone":string|null,"address":string|null}. COMPOSITION: vary the block kinds — a page built only from "text" and "programs" renders as a wall of identical boxes. A strong page alternates: lead with "hero" (homepage) and follow with 4-7 blocks of DIFFERENT kinds. Use "stats" for verifiable numbers, "quote" for a beneficiary or partner voice, "steps" for a process, "split" when prose needs supporting facts beside it, "faq" for the questions funders actually ask, "logos" to name funders and partners, "donate" only when a real donation URL exists. Never invent a figure, quote, person or funder — omit the block instead. The renderer handles all colour, spacing and section rhythm; choose blocks for meaning, not appearance.`,
  site_page: `Output JSON shape: {"page":{"slug":string(lowercase-kebab),"title":string,"seoDescription":string,"blocks":[...]},"placeholders":string[]}. Write ONLY the single page named in the page_plan block. Block shapes: {"kind":"hero","heading","tagline","ctaText":string|null,"ctaHref":string|null,"eyebrow":string|null,"secondaryText":string|null,"secondaryHref":string|null} | {"kind":"text","heading":string|null,"body"} | {"kind":"split","heading","body","highlights":string[],"ctaText":string|null,"ctaHref":string|null} | {"kind":"programs","heading","items":[{"name","description"}]} | {"kind":"stats","items":[{"label","value"}]} | {"kind":"quote","quote","attribution":string|null,"role":string|null} | {"kind":"steps","heading","intro":string|null,"items":[{"title","body"}]} | {"kind":"faq","heading","items":[{"q","a"}]} | {"kind":"team","heading","members":[{"name","role","bio":string|null}]} | {"kind":"logos","heading","names":string[]} | {"kind":"cta","heading","buttonText","href"} | {"kind":"donate","heading","body":string|null,"href","tiers":[{"amount","effect"}],"buttonText"} | {"kind":"form","formKey":lowercase-kebab,"heading","fields":[{"key":snake_case,"label","type":"text"|"email"|"textarea","required":boolean}]} | {"kind":"contact","email":string|null,"phone":string|null,"address":string|null}. COMPOSITION: vary the block kinds — a page built only from "text" and "programs" renders as a wall of identical boxes. A strong page alternates: lead with "hero" (homepage) and follow with 4-7 blocks of DIFFERENT kinds. Use "stats" for verifiable numbers, "quote" for a beneficiary or partner voice, "steps" for a process, "split" when prose needs supporting facts beside it, "faq" for the questions funders actually ask, "logos" to name funders and partners, "donate" only when a real donation URL exists. Never invent a figure, quote, person or funder — omit the block instead. The renderer handles all colour, spacing and section rhythm; choose blocks for meaning, not appearance. Where a fact you need is absent, emit a visible "[Placeholder: ...]" string and list it in placeholders rather than inventing it.`,
  site_patch: `Output JSON shape: {"applied":boolean,"reason":string|null,"changeSummary":string,"pages":[same page shape as the input pages block]}. Return the COMPLETE updated page set. If the request cannot be translated faithfully, set applied=false with a reason and return the pages unchanged.`,
  ad_grants_campaign_plan: `Output JSON shape: {"campaignName":string,"dailyBudgetUsd":number(<=329),"adGroups":[{"name":string,"keywords":string[](>=3, specific not generic),"headlines":string[](>=3, each <=30 chars),"descriptions":string[](>=2, each <=90 chars),"finalUrl":string}](>=2 ad groups),"sitelinks":[{"text":string(<=25 chars),"url":string}](>=2),"geoTargets":string[],"notes":string}. Every keyword, headline, and description must be grounded in the supplied org_facts — never invent programs, outcomes, or claims.`,
  content_strategy: `Output JSON shape: {"audience":string,"message":string,"tone":string,"palette":string,"designs":[{"caption":string,"prompt":string}]} with BETWEEN 4 AND 6 designs. Each design's prompt is a complete, self-contained image-generation prompt that already obeys the design guidelines in your instructions, and must state the exact words to appear in the image in quotes. Ground every choice in the organization context — never invent statistics, dollar amounts, dates, or outcomes that are not in it.`,
  intent: `Output JSON shape — exactly ONE of:
{"action":"search_grants","keyword":string}
{"action":"start_grant_application","resultIndex":number(1-based index into lastSearchResults)}
{"action":"build_website","siteName":string|null}
{"action":"update_website","instruction":string}
{"action":"provide_info","facts":[{"key":snake_case string,"value":string}]}
{"action":"approve","note":string|null}
{"action":"reject","note":string|null}
{"action":"status"}
{"action":"answer","text":string}
{"action":"clarify","question":string}
Pick the single best action for the user's message given the workspace context. Use "answer" for questions you can answer from context, "clarify" when you genuinely cannot tell what the user wants.`,
};
