import type { ModelProvider } from "@deedwell/agent-runtime";
import { ContentStrategyOutput } from "@deedwell/schemas";
import { DESIGN_GUIDELINES } from "./guidelines.js";
import {
  CONTENT_KIND_LABELS, CONTENT_KIND_SPEC, type ContentKind, type ContentStrategy,
} from "./types.js";

/** Everything the account already knows about this nonprofit, flattened into
 *  one block. Passing the knowledge base is the whole point of doing strategy
 *  before design: without it the model writes generic charity filler. */
export interface OrgContext {
  name: string;
  mission?: string | null;
  facts?: Array<{ key: string; value: string }>;
  knowledge?: Array<{ title: string; excerpt: string }>;
}

function contextBlock(org: OrgContext): string {
  const lines = [`Organization: ${org.name}`];
  if (org.mission) lines.push(`Mission: ${org.mission}`);
  for (const f of org.facts ?? []) lines.push(`${f.key}: ${f.value}`);
  for (const k of org.knowledge ?? []) lines.push(`From "${k.title}": ${k.excerpt}`);
  return lines.join("\n");
}

const SYSTEM = `
You are a senior art director and campaign strategist who works exclusively with nonprofits.

Work in two moves:

1. STRATEGY. Decide who this is actually talking to, the single message it must land, the
   tone that fits this organization's voice, and a restrained colour direction. Ground every
   choice in the organization context you are given — if it names their programs,
   beneficiaries or region, use them. Never invent statistics, dollar amounts, dates or
   outcomes that are not in the context.

2. DESIGN BRIEFS. Produce between 4 and 6 distinct designs serving that strategy. They must
   be genuinely different approaches, not one idea recoloured. Each brief is a complete,
   self-contained image prompt that already obeys the guidelines below, and must state the
   exact words to appear in the image, in quotes.

3. SOCIAL CAPTIONS. For every design, write the caption that will be posted with it
   ("postText"): a first line that stops the scroll, one or two short sentences that make the
   point in this organization's voice, a clear call to action, then 3 to 8 specific hashtags on
   the last line. 300 to 900 characters. Plain text, no markdown. It must match what the image
   says and, like the image, must not invent statistics, dates, dollar amounts or outcomes.

DESIGN GUIDELINES — every prompt must obey these:
${DESIGN_GUIDELINES}
`.trim();

/** Step one of the pipeline: turn a one-line request plus the account's
 *  knowledge base into a strategy and 4-6 concrete design briefs. No image is
 *  drawn until this validates, so a bad brief fails cheaply. */
export async function buildStrategy(opts: {
  model: ModelProvider;
  kind: ContentKind;
  prompt: string;
  org: OrgContext;
  /** Captions of designs this campaign already has. When the staff ask for
   *  more, the new briefs must be different approaches, not repeats. */
  avoid?: string[];
  /** Brand Style has a logo: briefs must leave it room and never draw one. */
  hasLogo?: boolean;
}): Promise<ContentStrategy> {
  const spec = CONTENT_KIND_SPEC[opts.kind];
  const logoNote = opts.hasLogo
    ? " The organization's real logo will be placed on every design by the image model: each prompt must reserve a clean, uncluttered corner for it and must not describe, invent or draw any logo or emblem."
    : "";
  const more = opts.avoid?.length
    ? ` The campaign already has ${opts.avoid.length} designs (listed in "designs already made"); propose only NEW designs that take clearly different approaches from those, keeping the same strategy.`
    : "";
  const res = await opts.model.complete({
    system: SYSTEM,
    task: `Plan a ${CONTENT_KIND_LABELS[opts.kind]} campaign. Every design is ${spec.surface} in ${spec.aspect} format.${more}${logoNote}`,
    outputSchemaRef: "content_strategy",
    dataBlocks: [
      { label: "organization context", content: contextBlock(opts.org) },
      { label: "staff request", content: opts.prompt },
      ...(opts.avoid?.length
        ? [{ label: "designs already made", content: opts.avoid.map((c, i) => `${i + 1}. ${c}`).join("\n") }]
        : []),
    ],
  });
  // Providers return JSON text; the schema is the contract, not a suggestion.
  return ContentStrategyOutput.parse(JSON.parse(res.text)) as ContentStrategy;
}
