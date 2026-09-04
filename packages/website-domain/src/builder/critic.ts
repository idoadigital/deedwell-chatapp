import type { ModelDataBlock, ModelProvider } from "@deedwell/agent-runtime";
import { CriticReport, type CriticIssue, type DesignLanguage, type PageComposition, type Section } from "./schemas.js";

/**
 * Stages 10-11. The critic scores a rendered page and names defects with a
 * fix from a fixed vocabulary; it never redesigns. The repair pass applies
 * those fixes to the COMPOSITION (not the markup), and the page is rendered
 * again — so a repair is always a targeted, reversible plan change.
 */
const SYSTEM = `You are a senior design critic reviewing one page of a nonprofit website. You are given the page's
composition plan, the design language it should follow, the rendered HTML (without styles) and, when
available, screenshots at phone, tablet and desktop widths. Score each quality 1-10 and list concrete
defects: overflow, clipping, overlapping, headings wrapping badly, weak hierarchy, monotony, poor rhythm,
misplaced or repeated images, unclear calls to action, motion that hurts. For every defect choose the
single fix from the allowed vocabulary that best addresses it and name the section id. Do not redesign,
do not praise; an empty issue list is a valid answer for a strong page.
Respond only with JSON matching the required output schema.`;

export interface Screenshot { width: number; height: number; mime: string; base64: string }

export async function critiquePage(args: {
  provider: ModelProvider;
  page: { slug: string; title: string };
  composition: PageComposition;
  language: DesignLanguage;
  html: string;
  screenshots: Screenshot[];
}): Promise<CriticReport> {
  const textOnly = args.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  const blocks: ModelDataBlock[] = [
    { label: "composition", content: JSON.stringify(args.composition) },
    { label: "design_language", content: JSON.stringify(args.language) },
    { label: "rendered_html", content: textOnly.slice(0, 60_000) },
    ...args.screenshots.map((s) => ({ label: `screenshot_${s.width}x${s.height}`, content: `Rendered at ${s.width}×${s.height}.`, image: { mime: s.mime, base64: s.base64 } })),
  ];
  const res = await args.provider.complete({
    system: SYSTEM,
    task: `Review the "${args.page.title}" page.`,
    outputSchemaRef: "design_critique",
    dataBlocks: blocks,
  });
  const parsed = CriticReport.safeParse(JSON.parse(res.text));
  if (!parsed.success) throw new Error(`Critique did not match the schema: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export function lowestScore(report: CriticReport): number {
  return Math.min(...Object.values(report.scores));
}

/** Apply the critic's fixes to the plan. Returns the new composition and a
 *  log of what changed; untouched sections keep their rendering. */
export function repairComposition(composition: PageComposition, issues: CriticIssue[]): { composition: PageComposition; applied: string[] } {
  const applied: string[] = [];
  const sections = composition.sections.map((s) => ({ ...s }));
  const find = (id: string | null) => (id ? sections.find((s) => s.id === id) : undefined);
  for (const issue of issues) {
    if (issue.severity === "low" && issue.fix !== "none") continue;
    const s = find(issue.section);
    switch (issue.fix) {
      case "reduce-heading-scale": {
        // Headings step down through the renderer's length rule; shorten the
        // heading override so it triggers, and prefer a quieter hero.
        if (s) { if (s.component === "EditorialHero" || s.component === "FullBleedImageHero") { s.component = "SplitHero"; s.variant = "image-right"; } s.density = "balanced"; applied.push(`${s.id}: reduced heading presence`); }
        break;
      }
      case "shorten-copy": if (s) { s.density = "dense"; applied.push(`${s.id}: denser copy treatment`); } break;
      case "change-variant": if (s && issue.value) { s.variant = issue.value; applied.push(`${s.id}: variant → ${issue.value}`); } break;
      case "swap-image-position": if (s) { s.imagePosition = s.imagePosition === "left" ? "right" : "left"; s.variant = s.variant?.includes("image-left") ? "image-right" : s.variant?.includes("image-right") ? "image-left" : s.variant; applied.push(`${s.id}: image side swapped`); } break;
      case "change-background": if (s) { s.background = s.background === "default" ? "muted" : "default"; applied.push(`${s.id}: background changed`); } break;
      case "increase-spacing": if (s) { s.density = "airy"; applied.push(`${s.id}: airier`); } break;
      case "reduce-spacing": if (s) { s.density = "dense"; applied.push(`${s.id}: tighter`); } break;
      case "remove-motion": if (s) { s.motion = "none"; applied.push(`${s.id}: motion removed`); } break;
      case "left-align": if (s && s.variant === "centered") { s.variant = "left"; applied.push(`${s.id}: left-aligned`); } break;
      case "constrain-width": if (s) { if (s.component === "ProseSection" || s.component === "EditorialTextSection") s.variant = "measure"; applied.push(`${s.id}: width constrained`); } break;
      case "remove-section": {
        const idx = sections.findIndex((x) => x.id === issue.section);
        if (idx > 0 && sections.length > 2) { sections.splice(idx, 1); applied.push(`${issue.section}: removed`); }
        break;
      }
      case "split-section": case "none": break;
    }
  }
  return { composition: { ...composition, sections: sections as Section[] }, applied };
}
