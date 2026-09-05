import { describe, expect, it } from "vitest";
import { speakableChunks } from "./rtc.js";

describe("speakableChunks", () => {
  it("splits a long first sentence at its first clause so audio starts sooner", () => {
    const chunks = speakableChunks("Sure, I can pull the three foundations that funded youth programs in Texas last year, and then we can compare them. Want me to start?");
    expect(chunks[0]).toBe("Sure,");
    expect(chunks[1]).toMatch(/^I can pull/);
    expect(chunks[chunks.length - 1]).toBe("Want me to start?");
  });
  it("leaves short sentences alone", () => {
    expect(speakableChunks("Okay. On it.")).toEqual(["Okay.", "On it."]);
  });
  it("does not split a sentence with no clause boundary", () => {
    expect(speakableChunks("That is the whole point of the matching requirement in this program.")).toHaveLength(1);
  });
  it("does not split when what follows the comma is too short to be worth it", () => {
    expect(speakableChunks("We can absolutely do that for the board meeting next week, okay?")).toHaveLength(1);
  });
});
