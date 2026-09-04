import type { SitePage } from "@deedwell/schemas";

/**
 * Placeholder markers must never reach a release. The copywriter is told to
 * leave out anything it lacks a fact for and report the gap instead; this is
 * the deterministic backstop for the times a model does not comply.
 */
export const PLACEHOLDER_RE = /\[\s*placeholder\b[^\]]*\]|\[\s*(?:insert|add|your|tbd)\b[^\]]*\]|\bTBD\b|\bTODO\b|lorem ipsum/i;

const walk = (value: unknown, out: string[]): void => {
  if (typeof value === "string") {
    const m = value.match(PLACEHOLDER_RE);
    if (m) out.push(m[0].trim());
  } else if (Array.isArray(value)) value.forEach((v) => walk(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => walk(v, out));
};

/** Every marker found anywhere in the page's blocks, in document order. */
export function findPlaceholders(page: SitePage): string[] {
  const out: string[] = [];
  walk(page.blocks, out);
  return out;
}

/**
 * Drop every block that still carries a marker. A page cannot be empty, so if
 * nothing survives it becomes one honest text block built from the plan —
 * the page exists, says what it is for, and invents nothing.
 */
export function stripPlaceholderBlocks(
  page: SitePage,
  plan: { title: string; purpose?: string }
): { page: SitePage; removed: number } {
  const kept = page.blocks.filter((block) => {
    const found: string[] = [];
    walk(block, found);
    return found.length === 0;
  });
  const removed = page.blocks.length - kept.length;
  if (kept.length) return { page: { ...page, blocks: kept }, removed };
  return {
    page: {
      ...page,
      blocks: [{
        kind: "text",
        heading: plan.title,
        body: plan.purpose?.trim() || `Information about ${plan.title.toLowerCase()} will be published here.`,
      }],
    },
    removed,
  };
}
