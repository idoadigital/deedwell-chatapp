import { sttProvider } from "./stt.js";

/**
 * One-shot transcription of a short recorded clip (the logo generator's
 * microphone), on the same Google Speech-to-Text the huddles stream to. Only
 * the Google engine can take a finished clip; Vosk is a live socket.
 */
const ENCODINGS: Record<string, { encoding: string; sampleRateHertz?: number }> = {
  "audio/webm": { encoding: "WEBM_OPUS", sampleRateHertz: 48000 },
  "audio/ogg": { encoding: "OGG_OPUS", sampleRateHertz: 48000 },
  "audio/wav": { encoding: "LINEAR16" },
  "audio/mp4": { encoding: "MP3" },
  "audio/mpeg": { encoding: "MP3" },
};

export async function transcribeClip(bytes: Buffer, mime: string, env = process.env): Promise<string> {
  if (sttProvider(env) !== "google") throw new Error("Speech-to-text is not available for recorded clips");
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const enc = ENCODINGS[base];
  if (!enc) throw new Error(`Unsupported audio type ${base}`);
  const { SpeechClient } = await import("@google-cloud/speech");
  const client = new SpeechClient();
  const [res] = await client.recognize({
    config: {
      ...enc,
      languageCode: env.GOOGLE_STT_LANGUAGE ?? "en-US",
      model: env.GOOGLE_STT_MODEL ?? "latest_long",
      enableAutomaticPunctuation: true,
      audioChannelCount: 1,
    } as never,
    audio: { content: bytes.toString("base64") },
  });
  return (res.results ?? [])
    .map((r) => r.alternatives?.[0]?.transcript ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}
