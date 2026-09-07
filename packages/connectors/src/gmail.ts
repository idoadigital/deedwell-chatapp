/**
 * Minimal Gmail REST client for reading a connected account's inbox —
 * exactly what the Ad Grants review phase needs: find Google's and
 * Goodstack's emails about the application, read them, and hand the text to
 * the workflow. Uses the access token the GoogleConnectionService already
 * refreshes and audits; never stores mail.
 */
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: Date | null;
  snippet: string;
  /** Best-effort plain text of the body (text/plain part, else stripped HTML). */
  text: string;
}

export class GmailError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "GmailError"; }
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL}${path}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new GmailError(`Gmail returned ${res.status}${res.status === 403 ? " (is the gmail.readonly permission granted?)" : ""}`, res.status);
  return (await res.json()) as T;
}

/** Message ids matching a Gmail search query, newest first. */
export async function searchGmail(accessToken: string, query: string, maxResults = 20): Promise<string[]> {
  const body = await gmailFetch<{ messages?: Array<{ id: string }> }>(accessToken, `/messages?${new URLSearchParams({ q: query, maxResults: String(maxResults) })}`);
  return (body.messages ?? []).map((m) => m.id);
}

function decodeBody(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[] }

function extractText(payload: Part | undefined): string {
  if (!payload) return "";
  const walk = (p: Part, want: string): string | null => {
    if (p.mimeType === want && p.body?.data) return decodeBody(p.body.data);
    for (const child of p.parts ?? []) { const found = walk(child, want); if (found) return found; }
    return null;
  };
  const plain = walk(payload, "text/plain");
  if (plain) return plain.replace(/\r/g, "").trim();
  const html = walk(payload, "text/html");
  if (html) return stripHtml(html);
  return payload.body?.data ? decodeBody(payload.body.data) : "";
}

export async function getGmailMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const m = await gmailFetch<{ id: string; threadId: string; snippet?: string; internalDate?: string; payload?: Part & { headers?: Array<{ name: string; value: string }> } }>(accessToken, `/messages/${id}?format=full`);
  const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  return {
    id: m.id, threadId: m.threadId,
    from: header("From"), subject: header("Subject"),
    date: m.internalDate ? new Date(Number(m.internalDate)) : null,
    snippet: m.snippet ?? "",
    text: extractText(m.payload).slice(0, 20_000),
  };
}
