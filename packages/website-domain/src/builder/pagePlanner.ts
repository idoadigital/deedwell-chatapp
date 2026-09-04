import type { ModelProvider } from "@deedwell/agent-runtime";
import type { SitePage, WebsiteBriefOutput } from "@deedwell/schemas";
import type { SiteImage } from "../images.js";
import { CATALOG, DEFAULT_COMPONENT, catalogForPrompt } from "./components.js";
import { COMPONENTS, PageComposition, type ComponentName, type DesignLanguage, type Section } from "./schemas.js";

/**
 * Stages 4-6 for one page: objective and CTAs, then one section per
 * copywriter block with a component chosen from the library and
 * configured (variant, background rhythm, image, motion, density). The
 * model plans; it does not write markup. Whatever it gets wrong is
 * corrected deterministically before rendering.
 */
const SYSTEM = `You are an art director composing one page of a nonprofit website from a fixed component library.
For each content block, in order, choose the component that presents it best, its variant, the section
background (alternate for rhythm; never two dark bands in a row; the hero decides its own), which of the
site's images it should use (or null), and a motion treatment. Vary components across the page: a page
should never be a run of card grids. Prefer editorial, photographic, story-led choices over dashboard-like
ones. Do not invent content: "overrides" may only shorten copy for the web, never add facts.
Respond only with JSON matching the required output schema.`;

export interface PlanArgs {
  provider: ModelProvider;
  page: SitePage;
  language: DesignLanguage;
  brief: WebsiteBriefOutput | null;
  images: SiteImage[];
  donateUrl: string | null;
  siteSlug: string;
  usedComponents: ComponentName[];
  /** A requested change to the look of this page, from the chat. */
  designInstruction?: string | null;
}

export async function planPage(args: PlanArgs): Promise<{ composition: PageComposition; corrections: string[] }> {
  let raw: unknown = null;
  const corrections: string[] = [];
  try {
    const res = await args.provider.complete({
      system: `${SYSTEM}\n\nCOMPONENT LIBRARY:\n${catalogForPrompt()}`,
      task: `Compose the "${args.page.title}" page.`,
      outputSchemaRef: "page_composition",
      dataBlocks: [
        { label: "page", content: JSON.stringify({ slug: args.page.slug, title: args.page.title, seoDescription: args.page.seoDescription, blocks: args.page.blocks.map((b, i) => ({ index: i, ...b })) }) },
        { label: "design_language", content: JSON.stringify(args.language) },
        { label: "site_images", content: JSON.stringify(args.images.map((i) => ({ key: i.key, purpose: i.purpose, forPage: i.forPage }))) },
        { label: "site", content: JSON.stringify({ donateUrl: args.donateUrl, componentsUsedOnOtherPages: args.usedComponents }) },
        ...(args.brief ? [{ label: "brief", content: JSON.stringify({ objectives: args.brief.objectives, audiences: args.brief.audiences, tone: args.brief.tone, sitemap: args.brief.sitemap }) }] : []),
        ...(args.designInstruction ? [{ label: "design_instruction", content: `The site owner asked for this change to the look of the page; honour it in your choices of component, variant, image position and background: ${args.designInstruction}` }] : []),
      ],
    });
    raw = JSON.parse(res.text);
  } catch (err) {
    corrections.push(`planner call failed (${String((err as Error).message ?? err).slice(0, 120)}); used defaults`);
  }
  return { composition: normalize(raw, args, corrections), corrections };
}

/** Make any plan safe: one section per block, valid components, alternating
 *  backgrounds, image keys that exist, and library defaults for the gaps. */
export function normalize(raw: unknown, args: Pick<PlanArgs, "page" | "images" | "donateUrl" | "language">, corrections: string[] = []): PageComposition {
  const parsed = PageComposition.safeParse(raw);
  const planned = parsed.success ? parsed.data : null;
  if (!planned && raw) corrections.push(`plan rejected: ${parsed.success ? "" : parsed.error.issues.slice(0, 2).map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  const blocks = args.page.blocks;
  const byBlock = new Map<number, Section>();
  for (const s of planned?.sections ?? []) if (!byBlock.has(s.block)) byBlock.set(s.block, s);

  const imageKeys = new Set(args.images.map((i) => i.key));
  let lastBg: Section["background"] = "default";
  let lastComponent: ComponentName | null = null;
  const sections: Section[] = blocks.map((block, i) => {
    const s = byBlock.get(i);
    let component: ComponentName = s?.component ?? DEFAULT_COMPONENT[block.kind];
    if (!COMPONENTS.includes(component) || !CATALOG[component].accepts.includes(block.kind)) {
      corrections.push(`section ${i}: ${component} cannot present a ${block.kind} block; used ${DEFAULT_COMPONENT[block.kind]}`);
      component = DEFAULT_COMPONENT[block.kind];
    }
    if (block.kind !== "hero" && component === lastComponent && component !== "EditorialTextSection") {
      corrections.push(`section ${i}: ${component} twice in a row; used ${DEFAULT_COMPONENT[block.kind]}`);
      component = component === DEFAULT_COMPONENT[block.kind] ? "ProseSection" : DEFAULT_COMPONENT[block.kind];
    }
    const variant = s?.variant && CATALOG[component].variants.includes(s.variant) ? s.variant : undefined;
    let background = s?.background ?? (i % 2 === 1 ? "muted" : "default");
    if (block.kind === "hero") background = "default";
    if ((background === "dark" || background === "primary") && (lastBg === "dark" || lastBg === "primary")) {
      corrections.push(`section ${i}: two strong bands in a row; softened`);
      background = "muted";
    }
    const wantsImage = CATALOG[component].family === "hero" || ["SplitStorySection", "ImageTextSection", "TestimonialFeature", "ProgramFeature", "FullBleedImage", "StoryGrid", "ImageStrip"].includes(component);
    const image = s?.image && imageKeys.has(s.image) ? s.image : null;
    const imagePosition = s?.imagePosition && s.imagePosition !== "none"
      ? s.imagePosition
      : wantsImage && args.images.length ? (i % 2 === 0 ? "right" : "left") : "none";
    lastBg = background;
    lastComponent = component;
    return {
      id: s?.id?.replace(/[^a-z0-9-]/gi, "").toLowerCase() || `s${i + 1}`,
      purpose: s?.purpose ?? `${block.kind} block`,
      component, variant, background, imagePosition, image, block: i,
      density: s?.density ?? "balanced",
      motion: s?.motion ?? (block.kind === "stats" ? "count" : block.kind === "hero" ? "none" : "fade-up"),
      mobile: s?.mobile ?? "stack",
      overrides: s?.overrides,
    };
  });
  // Unique ids so anchors and aria-labelledby stay valid.
  const seen = new Set<string>();
  for (const s of sections) { let id = s.id; let n = 2; while (seen.has(id)) id = `${s.id}-${n++}`; s.id = id; seen.add(id); }
  return {
    slug: args.page.slug,
    objective: planned?.objective ?? `Present ${args.page.title}`,
    primaryCta: planned?.primaryCta ?? (args.donateUrl ? { label: "Donate", href: args.donateUrl } : { label: "Get in touch", href: "/contact/" }),
    secondaryCta: planned?.secondaryCta ?? null,
    sections,
  };
}
