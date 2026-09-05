import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** Realtime huddle session: ephemeral tokens, orchestrated speaker, events. */

let env: TestEnv;
let token: string;
let orgId: string;
let huddleId: string;
let port: number;

const openSession = (rtcToken: string) =>
  new Promise<{ ws: WebSocket; events: any[]; next: (type: string, ms?: number) => Promise<any> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/rtc?token=${rtcToken}`);
    const events: any[] = [];
    const waiters: Array<{ type: string; fn: (e: any) => void }> = [];
    ws.on("message", (d, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(d));
      events.push(msg);
      const idx = waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) waiters.splice(idx, 1)[0]!.fn(msg);
    });
    ws.on("open", () =>
      resolve({
        ws, events,
        next: (type, ms = 8000) =>
          new Promise((res, rej) => {
            const hit = events.find((e) => e.type === type);
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
            waiters.push({ type, fn: (e) => { clearTimeout(t); res(e); } });
          }),
      })
    );
    ws.on("error", reject);
  });

beforeAll(async () => {
  env = await createTestEnv();
  await env.app.listen({ port: 0, host: "127.0.0.1" });
  port = (env.app.server.address() as { port: number }).port;
  ({ token } = await registerUser(env.app, "rtc@example.org"));
  orgId = await createOrg(env.app, token, "rtc-org");
  const channels = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
  const mayaDm = channels.body.channels.find((c: any) => c.key === "dm:core.executive_assistant").id;
  const started = await api(env.app, "POST", `/v1/orgs/${orgId}/huddles`, { token, body: { channelId: mayaDm } });
  huddleId = started.body.huddleId;
});
afterAll(async () => {
  await env.close();
});

describe("realtime huddle session", () => {
  it("issues ephemeral tokens and rejects invalid ones", async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/v1/rtc?token=nope`);
    const firstMsg = await new Promise<any>((res) => bad.on("message", (d) => res(JSON.parse(String(d)))));
    expect(firstMsg.error).toContain("Invalid or expired");
  });

  it("orchestrates one active speaker end to end over the socket", async () => {
    const sess = await api(env.app, "POST", `/v1/orgs/${orgId}/huddles/${huddleId}/rtc-session`, {
      token, body: {},
    });
    expect(sess.status).toBe(201);
    const { ws, next } = await openSession(sess.body.token);
    const startedEvt = await next("session_started");
    expect(startedEvt.stt).toBe(false); // hermetic tests: STT engine unreachable — honest flag
    await next("stt_unavailable");

    ws.send(JSON.stringify({ type: "text", body: "hello team" }));
    const speaker = await next("speaker_change", 15000);
    expect(speaker.speaker).toBe("core.executive_assistant");
    const captionEvt = await next("caption", 15000);
    expect(captionEvt.body.length).toBeGreaterThan(0);
    await next("transcript_final");

    ws.send(JSON.stringify({ type: "interrupt" }));
    ws.close();
    await new Promise((r) => setTimeout(r, 300));

    const { rows: segs } = await env.adminPool.query(
      "SELECT speaker_kind, body FROM transcript_segments WHERE huddle_id = $1 ORDER BY seq", [huddleId]
    );
    expect(segs.some((s) => s.speaker_kind === "user" && s.body === "hello team")).toBe(true);
    expect(segs.some((s) => s.speaker_kind === "agent")).toBe(true);
    const { rows: evts } = await env.adminPool.query(
      "SELECT type FROM huddle_events WHERE huddle_id = $1", [huddleId]
    );
    const types = evts.map((e) => e.type);
    for (const expected of ["session_started", "transcript_final", "speaker_change", "session_ended"]) {
      expect(types).toContain(expected);
    }
  });

  it("introduces and adds a teammate who is not on the call before they speak", async () => {
    const sess = await api(env.app, "POST", `/v1/orgs/${orgId}/huddles/${huddleId}/rtc-session`, { token, body: {} });
    const { ws, events, next } = await openSession(sess.body.token);
    const started = await next("session_started");
    // A Maya DM huddle starts with just Maya.
    expect(started.participants).toEqual(["core.executive_assistant"]);
    expect(started.participants).not.toContain("grant.budget_specialist");

    ws.send(JSON.stringify({ type: "text", body: "Michael, how much should we budget for the outreach staff?" }));
    const joined = await next("participant_joined", 15000);
    expect(joined.agent).toBe("grant.budget_specialist");
    expect(joined.name).toBe("Michael");
    expect(joined.invitedBy).toBe("core.executive_assistant");
    // The host introduced them out loud first…
    const intro = events.find((e) => e.type === "caption" && e.speaker === "core.executive_assistant" && /Michael/.test(e.body));
    expect(intro).toBeTruthy();
    expect(events.indexOf(intro) < events.indexOf(joined)).toBe(true);
    // …and only then does Michael take the floor.
    const michael = events.find((e) => e.type === "speaker_change" && e.speaker === "grant.budget_specialist");
    if (michael) expect(events.indexOf(joined) < events.indexOf(michael)).toBe(true);
    ws.close();
    await new Promise((r) => setTimeout(r, 400));

    // Rejoining the same huddle remembers who was brought in (which also
    // proves the join was persisted, since resume reads it back).
    const channels = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const mayaDm = channels.body.channels.find((c: any) => c.key === "dm:core.executive_assistant").id;
    const resumed = await api(env.app, "POST", `/v1/orgs/${orgId}/huddles`, { token, body: { channelId: mayaDm } });
    expect(resumed.body.resumed).toBe(true);
    expect(resumed.body.participants).toContain("grant.budget_specialist");
  });

  it("tokens are single-use", async () => {
    const sess = await api(env.app, "POST", `/v1/orgs/${orgId}/huddles/${huddleId}/rtc-session`, {
      token, body: {},
    });
    const first = await openSession(sess.body.token);
    await first.next("session_started");
    const reuse = new WebSocket(`ws://127.0.0.1:${port}/v1/rtc?token=${sess.body.token}`);
    const rejected = await new Promise<any>((res) => reuse.on("message", (d) => res(JSON.parse(String(d)))));
    expect(rejected.error).toContain("Invalid or expired");
    first.ws.close();
  });
});
