import { describe, expect, it } from "vitest";
import { composeLogoPrompt, edgeTransparency, mockLogoPng, prepareLogoAsset } from "./logo-generator.js";
import { decodePng, encodePng, type RgbaImage } from "./png.js";
import type { LogoBrief, LogoConcept } from "@deedwell/schemas";

function canvas(width: number, height: number, fill: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
}
function disc(img: RgbaImage, cx: number, cy: number, r: number, rgb: [number, number, number]) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.data.set([...rgb, 255], (y * img.width + x) * 4);
  }
}

const brief: LogoBrief = {
  organizationName: "Rwanda Tech Sisters", tagline: null,
  description: "A nonprofit helping young women in Rwanda build technology skills.",
  objectives: ["empowerment", "trust"], audience: "Young women, partners, funders",
  personality: ["Modern", "Human"], logoType: "wordmark", visualStyle: ["Minimal"],
  colors: { mode: "existing", palette: ["#0d5527", "#dae470"], notes: null },
  symbolism: ["growth", "connection"], avoid: ["gradients", "generic hearts"],
  designerNotes: "Modern, human, not corporate.",
};
const concept: LogoConcept = { title: "Clear Voice", approach: "Typography-led", logoType: "wordmark", direction: "The name in a geometric sans, tight tracking." };

describe("PNG codec", () => {
  it("round-trips RGBA pixels", () => {
    const img = canvas(5, 3, [10, 20, 30, 40]);
    img.data.set([200, 100, 50, 255], 4 * 7);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(5); expect(back.height).toBe(3);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });
});

describe("prepareLogoAsset", () => {
  it("keeps an image that already has transparency, trimmed to its content", () => {
    const out = prepareLogoAsset(mockLogoPng("#0d5527", "x"), 2_500_000);
    expect(out.repaired).toBe(false);
    const img = decodePng(out.bytes);
    expect(img.width).toBeLessThan(256);
    expect(edgeTransparency(img)).toBeGreaterThan(0.6);
  });

  it("removes a flat opaque background and reports the repair", () => {
    const img = canvas(120, 120, [255, 255, 255, 255]);
    disc(img, 60, 60, 30, [13, 85, 39]);
    const out = prepareLogoAsset(encodePng(img), 2_500_000);
    expect(out.repaired).toBe(true);
    const back = decodePng(out.bytes);
    expect(edgeTransparency(back)).toBeGreaterThan(0.9);
    // The mark itself is still opaque.
    const centre = (Math.floor(back.height / 2) * back.width + Math.floor(back.width / 2)) * 4 + 3;
    expect(back.data[centre]).toBe(255);
  });

  it("refuses an image whose background cannot be separated", () => {
    const img = canvas(64, 64, [255, 255, 255, 255]);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if ((x + y) % 2) img.data.set([0, 0, 0, 255], (y * 64 + x) * 4);
    expect(() => prepareLogoAsset(encodePng(img), 2_500_000)).toThrow(/transparent/);
  });

  it("refuses non-PNG bytes", () => {
    expect(() => prepareLogoAsset(Buffer.from("GIF89a"), 2_500_000)).toThrow(/PNG/);
  });
});

describe("composeLogoPrompt", () => {
  it("carries the brief's type, colours and avoid list, and forbids mockups and backgrounds", () => {
    const p = composeLogoPrompt(brief, concept);
    expect(p).toMatch(/WORDMARK/);
    expect(p).toContain("#0d5527, #dae470");
    expect(p).toContain("generic hearts");
    expect(p).toMatch(/TRANSPARENT background/);
    expect(p).toMatch(/business card/);
    expect(p).toContain('"Rwanda Tech Sisters"');
  });
});
