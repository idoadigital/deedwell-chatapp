/** The non-negotiable house style. Every image prompt inherits this verbatim,
 *  because the difference between "AI slop" and something a nonprofit will
 *  actually publish is almost entirely restraint: one idea per design, real
 *  typographic hierarchy, generous margins, and no clip-art.
 *
 *  Written as instructions to the image model, not as prose about design. */
export const DESIGN_GUIDELINES = `
COMPOSITION
- One idea per design. A single focal subject, a single headline, at most one supporting line.
- Generous margins. Keep all text and key subject matter inside the middle 80% of the frame.
- Strong typographic hierarchy: one large headline, one much smaller supporting line. Never more than two type sizes.
- Deliberate asymmetry or clean centring — never a cluttered centre-aligned stack of equal-weight elements.

TYPOGRAPHY
- Editorial serif for headlines OR a clean geometric sans — never both in one design.
- Real, correctly spelled, grammatical English. No lorem ipsum, no invented words, no garbled letterforms.
- Text must be legible at thumbnail size.

COLOUR
- A restrained palette: one dominant ground, one accent, one neutral. Warm naturals, deep greens, soft creams.
- High contrast between text and its background. Never place light text on a busy photo without a scrim.

IMAGERY
- Documentary-style photography of real people in real settings, or clean botanical / textural elements.
- Never: stock-photo handshakes, cheesy smiling boardrooms, glowing "AI" motifs, 3D-rendered mascots,
  lens flare, drop shadows on text, gradient rainbows, or clip-art icons.

FORBIDDEN
- No logos of real organizations, no Google/Meta/Instagram branding, no fake charity names implying a real entity.
- No watermarks, no signatures, no UI chrome, no borders framing the whole image.
- No text that makes a factual claim about money raised, people served, or outcomes.
`.trim();
