import { createHash } from "node:crypto";
import type { StorageAdapter } from "@deedwell/database";

/**
 * Agent voices, one distinct voice per teammate.
 *
 * - `google`: Cloud Text-to-Speech, Chirp 3 HD voices — the natural,
 *   expressive tier — spoken through the service account the API already
 *   runs as. Fast enough to keep sentence-level streaming conversational on
 *   a small container, which in-process synthesis is not. Clips come back
 *   as MP3, so they are a fraction of the size over the socket.
 * - `kokoro`: Kokoro-82M (Apache-2.0 open-source TTS) in-process via ONNX —
 *   nothing leaves the server, at the cost of a cold model load and CPU
 *   time per sentence.
 * - `off`: captions only, and the huddle says so.
 *
 * Every clip is content-addressed and cached in storage, so a repeated line
 * (greetings, confirmations) costs nothing the second time.
 */
export type VoiceProvider = "google" | "kokoro" | "off";

export function voiceProvider(env = process.env): VoiceProvider {
  const p = env.VOICE_PROVIDER ?? "kokoro";
  return p === "google" ? "google" : p === "off" ? "off" : "kokoro";
}

/** What a teammate sounds like, per engine. */
export interface VoiceSpec {
  /** Kokoro-82M voice id. */
  kokoro: string;
  /** Cloud Text-to-Speech voice name, e.g. en-US-Chirp3-HD-Kore. */
  google: string;
}
export const DEFAULT_VOICE: VoiceSpec = { kokoro: "af_heart", google: "en-US-Chirp3-HD-Kore" };


let ttsPromise: Promise<{ generate: (text: string, opts: { voice: string }) => Promise<{ toWav: () => ArrayBuffer }> }> | null = null;
let loadError: string | null = null;

async function getTts() {
  if (loadError) throw new Error(loadError);
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = await import("kokoro-js");
      const started = Date.now();
      const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "q8",
      });
      console.log(JSON.stringify({ at: "tts_model_loaded", ms: Date.now() - started, model: "Kokoro-82M q8" }));
      return tts as never;
    })().catch((err) => {
      loadError = `Voice model failed to load: ${err instanceof Error ? err.message : err}`;
      ttsPromise = null;
      throw new Error(loadError);
    });
  }
  return ttsPromise;
}

export function voiceEnabled(env = process.env): boolean {
  return voiceProvider(env) !== "off";
}

type TtsClientT = import("@google-cloud/text-to-speech").TextToSpeechClient;
let ttsClient: TtsClientT | null = null;
async function googleTts(): Promise<TtsClientT> {
  if (!ttsClient) {
    const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
    ttsClient = new TextToSpeechClient();
  }
  return ttsClient;
}

/** The language a Cloud TTS voice belongs to is the front of its name
 *  (en-GB-Chirp3-HD-Orus → en-GB), which is also what the request needs. */
export function languageOf(voiceName: string): string {
  const m = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voiceName);
  return m ? m[1]! : "en-US";
}

export async function synthesize(
  storage: StorageAdapter,
  voice: VoiceSpec,
  text: string
): Promise<Buffer> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 600);
  const provider = voiceProvider();
  if (provider === "off") throw new Error("Voices are switched off");
  const name = provider === "google" ? voice.google : voice.kokoro;
  const ext = provider === "google" ? "mp3" : "wav";
  const key = `tts/${provider}/${name}/${createHash("sha256").update(clean).digest("hex").slice(0, 24)}.${ext}`;
  try {
    return await storage.get(key); // content-addressed cache hit
  } catch {
    /* miss — synthesize */
  }
  const started = Date.now();
  let bytes: Buffer;
  if (provider === "google") {
    const client = await googleTts();
    const [res] = await client.synthesizeSpeech({
      input: { text: clean },
      voice: { languageCode: languageOf(name), name },
      audioConfig: { audioEncoding: "MP3", speakingRate: Number(process.env.GOOGLE_TTS_RATE ?? "1.0") || 1.0 },
    });
    if (!res.audioContent) throw new Error("Text-to-Speech returned no audio");
    bytes = Buffer.isBuffer(res.audioContent) ? res.audioContent : Buffer.from(res.audioContent as Uint8Array);
  } else {
    const tts = await getTts();
    const audio = await tts.generate(clean, { voice: name });
    bytes = Buffer.from(audio.toWav());
  }
  console.log(JSON.stringify({ at: "tts_generate", provider, voice: name, chars: clean.length, bytes: bytes.length, ms: Date.now() - started }));
  await storage.put(key, bytes);
  return bytes;
}
