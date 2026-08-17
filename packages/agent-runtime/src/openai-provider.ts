import type { ModelProvider, ModelRequest, ModelResponse } from "./index.js";

/**
 * Real OpenAI adapter behind the ModelProvider seam (ADR-0003). Uses the
 * plain HTTPS Chat Completions API with JSON-mode output; runAgentTask's zod
 * validation + bounded retries handle any schema drift.
 *
 * Requires OPENAI_API_KEY. Model via OPENAI_MODEL (default gpt-4o-mini).
 */
export class OpenAiProvider implements ModelProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OpenAiProvider requires OPENAI_API_KEY (or MODEL_PROVIDER=mock)");
    }
    this.apiKey = key;
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const requestId = Math.random().toString(36).slice(2, 10);
    const started = Date.now();
    const user = [
      `TASK: ${request.task}`,
      ``,
      `Respond with ONLY a single JSON object conforming to the "${request.outputSchemaRef}" output contract described in your instructions. No prose, no markdown fences.`,
      ``,
      ...request.dataBlocks.map(
        (b) =>
          `<<<DOCUMENT label="${b.label}">>>\n${b.content}\n<<<END DOCUMENT>>>`
      ),
    ].join("\n");

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system + "\n\n" + SCHEMA_HINTS[request.outputSchemaRef] },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
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
    const tokens = payload.usage?.total_tokens ?? Math.ceil(text.length / 4);
    console.log(JSON.stringify({
      at: "model_request", requestId, provider: "openai", model: this.model,
      schema: request.outputSchemaRef, ms: Date.now() - started, tokens, ok: true,
    }));
    return { text, tokensEstimated: tokens };
  }
}

/** Compact output-shape descriptions appended to the system prompt per schema.
 *  Shared with the Gemini adapter — the contract is the seam's, not the vendor's. */
export const SCHEMA_HINTS: Record<ModelRequest["outputSchemaRef"], string> = {
  requirements_extraction: `Output JSON shape: {"requirements":[{"text":string,"kind":"eligibility"|"narrative"|"budget"|"attachment"|"formatting"|"deadline"|"other","mandatory":boolean,"sourceLocation":{"line":number,"quote":string},"wordLimit":number|null}],"documentSummary":string}. Line numbers are 1-based lines of the document block.`,
  section_draft: `Output JSON shape: {"title":string,"body":string,"claims":[{"text":string,"factKey":string|null,"support":"verified"|"user_certified"|"estimate"|"assumption"|"unsupported","flagged":boolean}],"wordCount":number}. Every material claim must appear in claims with the org_facts key it rests on, or factKey null + support "unsupported" + flagged true.`,
  section_plan: `Output JSON shape: {"sections":[{"title":string,"objective":string,"wordLimit":number|null,"requirementLines":number[]}],"activities":string[]} (max 12 sections, max 20 activities).`,
  budget: `Output JSON shape: {"currency":"USD","items":[{"category":"personnel"|"direct"|"indirect"|"equipment"|"travel"|"other","description":string,"activity":string,"quantity":number,"unitCost":number}],"narrative":string}. Every item's activity must be one of the provided activities.`,
  logic_model: `Output JSON shape: {"problem":string,"inputs":string[],"activities":string[],"outputs":string[],"outcomes":string[],"impact":string,"indicators":[{"outcome":string,"indicator":string,"baseline":string,"target":string,"source":string,"frequency":string}]}.`,
  review_panel: `Output JSON shape: {"reviews":[{"reviewer":"program"|"financial"|"compliance"|"skeptic","criterion":string,"score":number(0-5),"maxScore":5,"strengths":string,"weaknesses":string,"fatalFlaw":boolean}],"revisionRecommendations":string[]} with at least 4 reviews.`,
  website_brief: `Output JSON shape: {"objectives":string[],"audiences":string[],"tone":string,"sitemap":[{"slug":string(lowercase-kebab),"title":string,"purpose":string}],"theme":{"palette":"forest"|"ocean"|"slate"|"sunrise","headingFont":"serif"|"sans"}}.`,
  site_content: `Output JSON shape: {"pages":[{"slug":string,"title":string,"seoDescription":string,"blocks":[hero|text|programs|stats|cta|form|contact blocks]}],"placeholders":string[]}. Block shapes: {"kind":"hero","heading","tagline","ctaText":string|null,"ctaHref":string|null} | {"kind":"text","heading":string|null,"body"} | {"kind":"programs","heading","items":[{"name","description"}]} | {"kind":"stats","items":[{"label","value"}]} | {"kind":"cta","heading","buttonText","href"} | {"kind":"form","formKey":lowercase-kebab,"heading","fields":[{"key":snake_case,"label","type":"text"|"email"|"textarea","required":boolean}]} | {"kind":"contact","email":string|null,"phone":string|null,"address":string|null}.`,
  site_patch: `Output JSON shape: {"applied":boolean,"reason":string|null,"changeSummary":string,"pages":[same page shape as the input pages block]}. Return the COMPLETE updated page set. If the request cannot be translated faithfully, set applied=false with a reason and return the pages unchanged.`,
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
