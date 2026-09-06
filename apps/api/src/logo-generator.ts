import type { ModelProvider } from "@deedwell/agent-runtime";
import type { ImageGenerator } from "@deedwell/content-domain";
import { LogoBrief, LogoBriefOutput, LogoConceptsOutput, type LogoConcept, type LogoType } from "@deedwell/schemas";
import { decodePng, downscale, encodePng, isPng, type RgbaImage } from "./png.js";

/**
 * Brand Style's logo generator: a designer's process in three model stages.
 *
 *   request + what the account knows  →  brief (the user edits it)
 *   approved brief                     →  five distinct concepts
 *   each concept                       →  one image, verified transparent
 *
 * Nothing the user typed reaches the image model directly; the brief is the
 * contract, and the image prompt is composed from it here, deterministically.
 */

export interface LogoOrgContext {
  name: string;
  facts: Array<{ key: string; value: string }>;
}

export const LOGO_TYPE_LABELS: Record<LogoType, string> = {
  wordmark: "Wordmark",
  lettermark: "Lettermark / Monogram",
  emblem: "Emblem",
  symbol_wordmark: "Symbol + Wordmark",
  combination: "Combination Mark",
  ai_choice: "AI Choose For Me",
};

const LOGO_TYPE_FOR_IMAGE: Record<Exclude<LogoType, "ai_choice">, string> = {
  wordmark: "a WORDMARK: typography-only, built around the organization's name set in a distinctive, carefully chosen typeface; no separate symbol",
  lettermark: "a LETTERMARK / MONOGRAM: the organization's initials as one distinctive, self-contained mark, with the full name optionally set small beneath",
  emblem: "an EMBLEM: the name (or initials) integrated inside one contained graphic form — a badge, seal or shield-like shape — that reads as a single unit",
  symbol_wordmark: "a SYMBOL + WORDMARK: one distinct abstract or figurative symbol locked up with the organization's name set in a clean typeface",
  combination: "a COMBINATION MARK: a symbol and the name arranged so that each also works on its own, in one balanced lockup",
};

/** Ordered facts that describe the organization, as one block the model
 *  treats as data. The logo pointer and any prior generation metadata are
 *  skipped: they are not facts about the organization. */
export function orgContextBlock(org: LogoOrgContext): string {
  const skip = new Set(["brand_logo_file_id", "brand_logo_meta"]);
  const lines = [`Organization: ${org.name}`];
  for (const f of org.facts) if (!skip.has(f.key) && f.value.trim()) lines.push(`${f.key}: ${f.value.trim().slice(0, 600)}`);
  return lines.join("\n");
}

const BRIEF_SYSTEM = `
You are a senior brand designer who works with nonprofits. A staff member has described, in their own words, the logo they imagine. Turn that request — together with everything the account already knows about the organization — into a professional logo design brief.

Do not rewrite their paragraph. Interpret it like a designer would: extract what the logo must communicate, who it must work for, the personality it should carry, the visual language, the colour direction, the symbolism worth exploring, and what to steer clear of. Then write two or three sentences of creative direction that a designer could act on.

Rules:
- organizationName comes from the context (legal_name), never invented. tagline only if the context or the request gives one.
- description: two or three sentences about the organization and its work, from the context. Never invent programs, places, numbers or outcomes.
- logoType: only pick a specific type when the request clearly asks for one (they say "wordmark", "just our initials", "a badge", "a symbol with our name"…). Otherwise "ai_choice".
- colors: if the context has brand_primary_color / brand_accent_color, mode "existing" with those hex values first. Otherwise mode "suggested" with 2-3 hex colours that fit the organization and the request, and a short note on why. Never propose a gradient.
- personality, visualStyle: short capitalised adjectives ("Modern", "Human", "Geometric"). 3-6 of each.
- symbolism: 3-6 themes worth exploring — abstract where possible (growth, connection, opportunity) rather than literal charity imagery.
- avoid: include whatever the request rules out, plus the usual nonprofit clichés unless the request wants them: hands in circles, generic hearts, people holding hands, swooshes, globes without a reason, mascots, childish type, overly detailed illustration.
- designerNotes: the creative strategy, specific to this organization, in plain professional prose.
`.trim();

export async function buildLogoBrief(opts: { model: ModelProvider; org: LogoOrgContext; request: string }): Promise<LogoBrief> {
  const res = await opts.model.complete({
    system: BRIEF_SYSTEM,
    task: "Write the logo design brief for this organization from the staff member's request and the organization context.",
    outputSchemaRef: "logo_brief",
    dataBlocks: [
      { label: "organization context", content: orgContextBlock(opts.org) },
      { label: "logo request", content: opts.request },
    ],
  });
  return LogoBriefOutput.parse(JSON.parse(res.text));
}

const CONCEPTS_SYSTEM = `
You are the creative director on a nonprofit identity project. The brief has been approved. Before any image is drawn, derive distinct creative directions from it — the way a studio would present five genuinely different routes, not one idea recoloured.

Rules:
- Exactly the number of concepts asked for. Each must take a clearly different approach: for example typography-led, abstract symbol, geometric construction, human/organic form, minimal emblem, monogram. Name the approach.
- Respect the brief's logoType. If it is a specific type, EVERY concept is that type and the variety comes from typography, form, proportion and idea — five strong wordmarks are five wordmarks. If it is "ai_choice", choose the strongest type per concept and vary across concepts.
- The direction is concrete art direction for an image model: the exact forms of the mark, how the name is set (typeface character, weight, case), the lockup and proportions, which colours from the palette go where. Two to four sentences. State the exact text that appears — the organization's name spelled exactly, and nothing else unless the brief's tagline is meant to appear.
- Explore the brief's symbolism abstractly. Honour the avoid list absolutely.
- Clarity, distinctiveness, scalability, flat colour, recognisable silhouette. No gradients, no 3D, no illustration scenes.
- When a list of earlier concepts is given, propose only new directions that differ from all of them.
`.trim();

export async function planLogoConcepts(opts: { model: ModelProvider; brief: LogoBrief; count?: number; avoid?: string[] }): Promise<LogoConcept[]> {
  const count = Math.min(6, Math.max(3, opts.count ?? 5));
  const res = await opts.model.complete({
    system: CONCEPTS_SYSTEM,
    task: `Derive ${count} distinct logo concepts from the approved brief.${opts.avoid?.length ? " Earlier concepts are listed; every new one must take a different direction." : ""}`,
    outputSchemaRef: "logo_concepts",
    dataBlocks: [
      { label: "approved brief", content: JSON.stringify(opts.brief, null, 2) },
      ...(opts.avoid?.length ? [{ label: "earlier concepts", content: opts.avoid.map((c, i) => `${i + 1}. ${c}`).join("\n") }] : []),
    ],
  });
  const { concepts } = LogoConceptsOutput.parse(JSON.parse(res.text));
  // The type is the user's decision, whatever the model returned.
  const fixed = opts.brief.logoType === "ai_choice" ? null : opts.brief.logoType;
  return concepts.slice(0, count).map((c) => ({ ...c, logoType: fixed ?? c.logoType }));
}

/** The image prompt, composed from the approved brief and one concept. The
 *  technical block is constant: it is what keeps the output a logo asset
 *  rather than a picture of one. */
export function composeLogoPrompt(brief: LogoBrief, concept: LogoConcept): string {
  const type = LOGO_TYPE_FOR_IMAGE[concept.logoType];
  const palette = brief.colors.palette.join(", ");
  const parts = [
    `Professional logo identity for "${brief.organizationName}", a nonprofit. ${brief.description}`,
    `The logo is ${type}.`,
    `Concept — ${concept.title} (${concept.approach}): ${concept.direction}`,
    `It must communicate: ${brief.objectives.join(", ")}. Personality: ${brief.personality.join(", ")}. Visual style: ${brief.visualStyle.join(", ")}.`,
    `Colours: use only ${palette}${brief.colors.notes ? ` (${brief.colors.notes})` : ""}. Flat, solid colour — no gradients, no shading.`,
    brief.symbolism.length ? `Symbolic themes, treated abstractly: ${brief.symbolism.join(", ")}.` : "",
    `Avoid entirely: ${[...brief.avoid, "generic charity imagery", "clip-art", "stock icon look"].join(", ")}.`,
    concept.logoType === "lettermark"
      ? `Text: the initials of "${brief.organizationName}" only.`
      : `Text: the name "${brief.organizationName}" spelled exactly, in a modern, well-set typeface; no other words${brief.tagline ? ` unless it is the tagline "${brief.tagline}"` : ""}.`,
    "Design principles: clarity, trust, simplicity, distinctiveness, accessibility, a recognisable silhouette that scales from a favicon to a banner.",
    "OUTPUT: only the logo artwork, as flat vector-style graphics, centred with generous empty margin, on a fully TRANSPARENT background (alpha channel). No background of any kind — not white, not black, not coloured, not a checkerboard, no canvas, no frame, no drop shadow, no 3D, no texture. Not a mockup: no paper, wall, business card, shirt, signage, screen, presentation board or photograph. A single logo, not a sheet of variations.",
  ];
  return parts.filter(Boolean).join("\n");
}

// ---- transparency -----------------------------------------------------------

export const LOGO_IMAGE_SIZE = "1024x1024";
const ALPHA_EDGE = 250;
const KNOCKOUT_TOLERANCE = 40;

export interface PreparedLogo { bytes: Buffer; mime: "image/png"; width: number; height: number; repaired: boolean }

/** Turns a generated image into a logo asset with real transparency, or
 *  throws. An image that arrives with alpha is trimmed and kept; one that
 *  arrives on a flat background has that background removed (edge-connected
 *  pixels close to the edge colour) and is then checked again — a busy or
 *  multi-colour background does not pass. */
export function prepareLogoAsset(bytes: Buffer, maxBytes: number): PreparedLogo {
  if (!isPng(bytes)) throw new Error("The image model returned something other than a PNG.");
  let img = decodePng(bytes);
  let repaired = false;
  if (edgeTransparency(img) < 0.6) {
    knockOutBackground(img);
    repaired = true;
    if (edgeTransparency(img) < 0.6) throw new Error("The generated image has no transparent background.");
  }
  img = trimToContent(img);
  if (img.width < 16 || img.height < 16) throw new Error("The generated logo is empty.");
  let out = encodePng(img);
  for (const side of [768, 512, 384]) {
    if (out.length <= maxBytes) break;
    img = downscale(img, side);
    out = encodePng(img);
  }
  if (out.length > maxBytes) throw new Error("The generated logo is too large to store.");
  return { bytes: out, mime: "image/png", width: img.width, height: img.height, repaired };
}

/** Share of the outermost ring of pixels that is transparent. */
export function edgeTransparency(img: RgbaImage): number {
  const { width, height, data } = img;
  let clear = 0, n = 0;
  const look = (x: number, y: number) => { n++; if (data[(y * width + x) * 4 + 3]! < ALPHA_EDGE) clear++; };
  for (let x = 0; x < width; x++) { look(x, 0); look(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { look(0, y); look(width - 1, y); }
  return n ? clear / n : 0;
}

/** Flood-fills from every edge pixel through pixels near the edge's own
 *  colour, making them transparent, with a one-pixel feather at the boundary. */
function knockOutBackground(img: RgbaImage): void {
  const { width, height, data } = img;
  const [br, bg, bb] = edgeColour(img);
  const dist = (o: number) => Math.max(Math.abs(data[o]! - br), Math.abs(data[o + 1]! - bg), Math.abs(data[o + 2]! - bb));
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (seen[i]) return;
    if (dist(i * 4) > KNOCKOUT_TOLERANCE) return;
    seen[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width, y = (i - x) / width;
    data[i * 4 + 3] = 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  // Feather: an opaque pixel next to the cleared region that is still close
  // to the background colour was anti-aliasing against it.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (seen[i]) continue;
    const near = (x > 0 && seen[i - 1]) || (x < width - 1 && seen[i + 1]) || (y > 0 && seen[i - width]) || (y < height - 1 && seen[i + width]);
    if (!near) continue;
    const d = dist(i * 4);
    if (d < KNOCKOUT_TOLERANCE * 2.5) data[i * 4 + 3] = Math.min(data[i * 4 + 3]!, Math.round(255 * Math.min(1, d / (KNOCKOUT_TOLERANCE * 2.5))));
  }
}

function edgeColour(img: RgbaImage): [number, number, number] {
  const { width, height, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x: number, y: number) => { const o = (y * width + x) * 4; r += data[o]!; g += data[o + 1]!; b += data[o + 2]!; n++; };
  const step = Math.max(1, Math.floor(Math.min(width, height) / 64));
  for (let x = 0; x < width; x += step) { add(x, 0); add(x, height - 1); }
  for (let y = 0; y < height; y += step) { add(0, y); add(width - 1, y); }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Crops to the opaque content plus a margin, so every candidate presents at
 *  the same scale whatever the model left around it. */
function trimToContent(img: RgbaImage): RgbaImage {
  const { width, height, data } = img;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3]! > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return { width: 0, height: 0, data: new Uint8Array(0) };
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.06);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w === width && h === height) return img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/** One concept → one verified transparent PNG. */
export async function renderLogoConcept(opts: { images: ImageGenerator; brief: LogoBrief; concept: LogoConcept; maxBytes: number }): Promise<PreparedLogo & { prompt: string }> {
  const prompt = composeLogoPrompt(opts.brief, opts.concept);
  // The mock image generator draws a 1×1 pixel, which is not a logo; in mock
  // mode draw a real (if plain) transparent mark so the whole flow, including
  // the transparency check, runs without a model.
  const generated = opts.images.model === "mock"
    ? { bytes: mockLogoPng(opts.brief.colors.palette[0] ?? "#0d5527", opts.concept.title), mime: "image/png" }
    : await opts.images.generate(prompt, LOGO_IMAGE_SIZE, { transparent: true });
  return { ...prepareLogoAsset(generated.bytes, opts.maxBytes), prompt };
}

/** A 256×256 PNG: a solid disc in the brief's first colour on transparency,
 *  its size varying with the concept so candidates are distinguishable. */
export function mockLogoPng(hex: string, seed: string): Buffer {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const [r, g, b] = hexToRgb(hex);
  const radius = 60 + (seed.length % 5) * 12;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - size / 2, dy = y - size / 2;
    if (dx * dx + dy * dy <= radius * radius) { const o = (y * size + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; }
  }
  return encodePng({ width: size, height: size, data });
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
