import type { StorageAdapter } from "@deedwell/database";
import type { ImageGenerator } from "@deedwell/content-domain";
import type { SitePage, WebsiteBriefOutput } from "@deedwell/schemas";

/**
 * Photography for a site the organization has no photos for. A handful of
 * images are generated once per build in the reference design's style,
 * stored with the site, copied into every release, and offered to the page
 * designer by path. Text and logos are never drawn into them: the copy is
 * the copywriter's, and a generated logo would be a fabrication.
 */

export interface SiteImage {
  key: string;
  /** Path the page links to, e.g. "/images/hero.png". */
  path: string;
  storageKey: string;
  alt: string;
  /** What the image is for, so the designer places it sensibly. */
  purpose: string;
  forPage: string | null;
  mime: string;
}

export interface ImagePlanItem {
  key: string;
  prompt: string;
  alt: string;
  size: string;
  purpose: string;
  forPage: string | null;
}

export interface ImageContext {
  siteName: string;
  mission: string | null;
  beneficiaries: string | null;
  programs: string | null;
  serviceArea: string | null;
  referenceStyle: string | null;
}

const STYLE_RULES =
  "Editorial nonprofit photography feel, natural light, real-looking people and places, warm and dignified, " +
  "no text, no words, no letters, no logos, no watermarks, no captions, no borders.";

/** Which images this site needs, from what its pages are about. At most six. */
export function planSiteImages(args: {
  brief: WebsiteBriefOutput | null;
  pages: Array<Pick<SitePage, "slug" | "title">>;
  org: ImageContext;
}): ImagePlanItem[] {
  const { org } = args;
  const subject = [org.mission, org.beneficiaries, org.serviceArea].filter(Boolean).join(". ");
  const style = org.referenceStyle ? `Visual style to match: ${org.referenceStyle}. ` : "";
  const items: ImagePlanItem[] = [
    {
      key: "hero",
      size: "1536x1024",
      purpose: "Home page hero: the organization's work and the people it serves, wide, room for a headline beside it",
      alt: `${org.siteName}: ${org.beneficiaries ?? "the community"} taking part in ${org.programs ? "its programs" : "its work"}`,
      prompt: `${style}Wide photograph for a nonprofit website hero. ${subject}. Show the people served and the work in progress, candid and hopeful, uncluttered composition with soft depth of field. ${STYLE_RULES}`,
      forPage: "home",
    },
  ];
  const slugs = new Set(args.pages.map((p) => p.slug));
  const find = (re: RegExp) => args.pages.find((p) => re.test(p.slug) || re.test(p.title.toLowerCase()))?.slug ?? null;
  const programs = find(/program|service|what-we-do/);
  if (programs) items.push({
    key: "programs", size: "1536x1024",
    purpose: "Programs page: a program activity in progress",
    alt: `A ${org.siteName} program activity in progress`,
    prompt: `${style}Photograph of a nonprofit program activity in progress: ${org.programs ?? "community support work"}. Participants engaged, natural setting, honest and specific. ${STYLE_RULES}`,
    forPage: programs,
  });
  const impact = find(/impact|result|story|about|mission/);
  if (impact) items.push({
    key: "community", size: "1024x1024",
    purpose: "About or impact page: the community and place the organization serves",
    alt: `The community ${org.siteName} serves${org.serviceArea ? ` in ${org.serviceArea}` : ""}`,
    prompt: `${style}Photograph of the community and place a nonprofit serves${org.serviceArea ? `: ${org.serviceArea}` : ""}. People and their neighbourhood, daytime, welcoming, documentary style. ${STYLE_RULES}`,
    forPage: impact,
  });
  const involve = find(/involve|volunteer|support|join/);
  if (involve) items.push({
    key: "volunteers", size: "1024x1024",
    purpose: "Get involved page: volunteers working together",
    alt: `Volunteers working together with ${org.siteName}`,
    prompt: `${style}Photograph of volunteers working together for a nonprofit, hands-on and collaborative, diverse group, candid. ${STYLE_RULES}`,
    forPage: involve,
  });
  if (slugs.has("donate")) items.push({
    key: "donate", size: "1024x1024",
    purpose: "Donate page: what a gift makes possible",
    alt: `What a gift to ${org.siteName} makes possible`,
    prompt: `${style}Photograph showing the result of a charitable gift for this cause: ${subject}. Warm, specific, dignified, no money or cash shown. ${STYLE_RULES}`,
    forPage: "donate",
  });
  return items.slice(0, 6);
}

export function siteImageStorageKey(tenantId: string, siteId: string, key: string): string {
  return `tenants/${tenantId}/sites/${siteId}/images/${key}.png`;
}

/** Generate every planned image concurrently. A failed image is simply
 *  left out — the page designer only ever sees the ones that exist. */
export async function generateSiteImages(args: {
  generator: ImageGenerator;
  plan: ImagePlanItem[];
  storage: StorageAdapter;
  tenantId: string;
  siteId: string;
  onError?: (item: ImagePlanItem, err: unknown) => void;
}): Promise<SiteImage[]> {
  // Two at a time: image quotas are per minute and a burst of six is
  // exactly what exhausts them.
  const limit = Number(process.env.SITE_IMAGE_CONCURRENCY ?? 2);
  const settled: PromiseSettledResult<SiteImage>[] = new Array(args.plan.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, args.plan.length) }, async () => {
    while (next < args.plan.length) {
      const i = next++;
      const item = args.plan[i]!;
      try {
        const image = await args.generator.generate(item.prompt, item.size);
        const storageKey = siteImageStorageKey(args.tenantId, args.siteId, item.key);
        await args.storage.put(storageKey, image.bytes);
        settled[i] = { status: "fulfilled", value: {
          key: item.key, path: `/images/${item.key}.png`, storageKey, alt: item.alt,
          purpose: item.purpose, forPage: item.forPage, mime: image.mime,
        } };
      } catch (reason) {
        settled[i] = { status: "rejected", reason };
      }
    }
  }));
  const out: SiteImage[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(r.value);
    else args.onError?.(args.plan[i]!, r.reason);
  });
  return out;
}
