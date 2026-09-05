import WebSocket from "ws";

/**
 * Streaming speech-to-text for huddles, behind one small interface so the
 * realtime session does not care which engine is listening.
 *
 * - `google`: Cloud Speech-to-Text streaming recognition (interim results
 *   on, automatic punctuation, the `latest_long` conversational model by
 *   default). Authenticated with the service account the API already runs
 *   as — nothing to host, nothing to keep warm. A stream is capped at about
 *   five minutes by the service, so this rotates streams underneath the
 *   session before that limit and the caller never notices.
 * - `vosk`: the original open-source server over a WebSocket (STT_URL).
 * - `off`: no engine; the huddle says so and takes typed turns instead.
 *
 * Frames in are 16 kHz mono PCM16, exactly what the browser worklet sends.
 */
export type SttProvider = "google" | "vosk" | "off";

export interface SttEvents {
  onPartial(text: string): void;
  onFinal(text: string): void;
  /** The engine gave up mid-session (auth, quota, network). */
  onLost?(reason: string): void;
}

export interface SttBridge {
  readonly provider: SttProvider;
  write(frame: Buffer): void;
  close(): void;
}

export function sttProvider(env = process.env): SttProvider {
  const p = env.STT_PROVIDER;
  if (p === "google" || p === "vosk" || p === "off") return p;
  return "vosk";
}

/** Opens the configured engine. Rejects when it cannot be reached, so the
 *  session can report `stt_unavailable` honestly rather than pretend. */
export async function openStt(events: SttEvents, env = process.env): Promise<SttBridge> {
  const provider = sttProvider(env);
  if (provider === "off") throw new Error("Speech-to-text is switched off");
  if (provider === "google") return openGoogle(events, env);
  return openVosk(events, env);
}

// ---- Vosk -----------------------------------------------------------------
async function openVosk(events: SttEvents, env: NodeJS.ProcessEnv): Promise<SttBridge> {
  const url = env.STT_URL ?? "ws://127.0.0.1:2700";
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
    setTimeout(() => reject(new Error("stt timeout")), 4000);
  });
  ws.send(JSON.stringify({ config: { sample_rate: 16000 } }));
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data)) as { partial?: string; text?: string };
      if (msg.partial !== undefined) events.onPartial(msg.partial);
      else if (msg.text && msg.text.trim()) events.onFinal(msg.text.trim());
    } catch { /* ignore malformed */ }
  });
  ws.on("close", () => events.onLost?.("stt closed"));
  return {
    provider: "vosk",
    write(frame) { if (ws.readyState === WebSocket.OPEN) ws.send(frame); },
    close() { ws.close(); },
  };
}

// ---- Google Cloud Speech-to-Text ------------------------------------------
type SpeechClientT = import("@google-cloud/speech").SpeechClient;
let speechClient: SpeechClientT | null = null;

async function googleSpeech(): Promise<SpeechClientT> {
  if (!speechClient) {
    const { SpeechClient } = await import("@google-cloud/speech");
    speechClient = new SpeechClient();
    await speechClient.initialize(); // resolves credentials now, not on the first frame
  }
  return speechClient;
}

/** Streams are rotated before the service's ~5 minute cap. */
const GOOGLE_STREAM_MS = 4 * 60 * 1000;
/** Persistent failures stop the session instead of looping on the API. */
const GOOGLE_MAX_ERRORS = 3;

async function openGoogle(events: SttEvents, env: NodeJS.ProcessEnv): Promise<SttBridge> {
  const client = await googleSpeech();
  const config = {
    encoding: "LINEAR16" as const,
    sampleRateHertz: 16000,
    audioChannelCount: 1,
    languageCode: env.GOOGLE_STT_LANGUAGE ?? "en-US",
    model: env.GOOGLE_STT_MODEL ?? "latest_long",
    useEnhanced: true,
    enableAutomaticPunctuation: true,
    profanityFilter: false,
  };

  let stream: ReturnType<SpeechClientT["streamingRecognize"]> | null = null;
  let closed = false;
  let errors = 0;
  let rotate: NodeJS.Timeout | null = null;
  let lastInterim = "";

  const start = () => {
    if (closed) return;
    const s = client.streamingRecognize({ config, interimResults: true });
    stream = s;
    s.on("data", (data: { results?: Array<{ isFinal?: boolean; alternatives?: Array<{ transcript?: string }> }> }) => {
      const result = data.results?.[0];
      const text = (result?.alternatives?.[0]?.transcript ?? "").trim();
      if (!text) return;
      errors = 0;
      if (result?.isFinal) { lastInterim = ""; events.onFinal(text); }
      else if (text !== lastInterim) { lastInterim = text; events.onPartial(text); }
    });
    s.on("error", (err: Error) => {
      if (closed || stream !== s) return;
      errors += 1;
      console.log(JSON.stringify({ at: "stt_google_error", error: err.message.slice(0, 200), errors }));
      if (errors >= GOOGLE_MAX_ERRORS) {
        closed = true;
        events.onLost?.(err.message.slice(0, 200));
        return;
      }
      restart();
    });
    s.on("end", () => { if (!closed && stream === s) restart(); });
    if (rotate) clearTimeout(rotate);
    rotate = setTimeout(() => {
      if (closed || stream !== s) return;
      stream = null;
      s.end();
      start();
    }, GOOGLE_STREAM_MS);
  };
  const restart = () => {
    const old = stream;
    stream = null;
    try { old?.end(); } catch { /* already gone */ }
    start();
  };
  start();

  return {
    provider: "google",
    write(frame) {
      if (closed || !stream) return;
      try { stream.write({ audioContent: frame }); } catch { /* the error handler restarts it */ }
    },
    close() {
      closed = true;
      if (rotate) clearTimeout(rotate);
      try { stream?.end(); } catch { /* fine */ }
      stream = null;
    },
  };
}
