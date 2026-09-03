import type { ModelProvider } from "@deedwell/agent-runtime";
import type { ImageGenerator } from "./images.js";
import { buildStrategy, type OrgContext } from "./strategy.js";
import { CONTENT_KIND_SPEC, type ContentKind, type ContentStrategy } from "./types.js";

export interface RenderedDesign {
  position: number;
  caption: string;
  prompt: string;
  bytes: Buffer;
  mime: string;
}

export interface CampaignResult {
  strategy: ContentStrategy;
  designs: RenderedDesign[];
}

/**
 * Strategy first, then images — never the other way round. The briefs are all
 * generated concurrently because they are independent and each one is slow;
 * a single failed design does not sink the campaign, it is simply dropped,
 * and only an empty result is an error. That matters because these cost money
 * per image: partial output is worth keeping.
 */
export async function generateCampaign(opts: {
  model: ModelProvider;
  images: ImageGenerator;
  kind: ContentKind;
  prompt: string;
  org: OrgContext;
  onProgress?: (done: number, total: number) => void;
}): Promise<CampaignResult> {
  const strategy = await buildStrategy({
    model: opts.model,
    kind: opts.kind,
    prompt: opts.prompt,
    org: opts.org,
  });

  const size = CONTENT_KIND_SPEC[opts.kind].size;
  let done = 0;
  const settled = await Promise.allSettled(
    strategy.designs.map(async (brief, i): Promise<RenderedDesign> => {
      const image = await opts.images.generate(brief.prompt, size);
      done += 1;
      opts.onProgress?.(done, strategy.designs.length);
      return {
        position: i,
        caption: brief.caption,
        prompt: brief.prompt,
        bytes: image.bytes,
        mime: image.mime,
      };
    })
  );

  const designs = settled
    .filter((r): r is PromiseFulfilledResult<RenderedDesign> => r.status === "fulfilled")
    .map((r) => r.value);

  if (designs.length === 0) {
    const first = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    throw new Error(first ? String(first.reason?.message ?? first.reason) : "No designs were generated");
  }
  return { strategy, designs };
}
