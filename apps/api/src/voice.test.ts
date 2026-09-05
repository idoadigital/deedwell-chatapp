import { describe, expect, it } from "vitest";
import { languageOf, voiceEnabled, voiceProvider } from "./tts.js";
import { sttProvider } from "./stt.js";
import { TEAMMATES } from "./teammates.js";

describe("huddle voice configuration", () => {
  it("reads the engines from the environment, defaulting to the self-hosted ones", () => {
    expect(voiceProvider({})).toBe("kokoro");
    expect(voiceProvider({ VOICE_PROVIDER: "google" })).toBe("google");
    expect(voiceProvider({ VOICE_PROVIDER: "off" })).toBe("off");
    expect(voiceEnabled({ VOICE_PROVIDER: "off" })).toBe(false);
    expect(voiceEnabled({ VOICE_PROVIDER: "google" })).toBe(true);
    expect(sttProvider({})).toBe("vosk");
    expect(sttProvider({ STT_PROVIDER: "google" })).toBe("google");
    expect(sttProvider({ STT_PROVIDER: "off" })).toBe("off");
    expect(sttProvider({ STT_PROVIDER: "nonsense" })).toBe("vosk");
  });

  it("derives the request language from the Cloud voice name", () => {
    expect(languageOf("en-US-Chirp3-HD-Kore")).toBe("en-US");
    expect(languageOf("en-GB-Chirp3-HD-Orus")).toBe("en-GB");
    expect(languageOf("weird")).toBe("en-US");
  });

  it("gives every teammate a distinct voice in both engines", () => {
    const kokoro = TEAMMATES.map((t) => t.voice);
    const google = TEAMMATES.map((t) => t.googleVoice);
    expect(new Set(kokoro).size).toBe(TEAMMATES.length);
    expect(new Set(google).size).toBe(TEAMMATES.length);
    for (const name of google) expect(name).toMatch(/^en-(US|GB)-Chirp3-HD-[A-Z][a-z]+$/);
  });
});
