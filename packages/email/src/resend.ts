/**
 * Minimal Resend client over fetch (Node 20+). One endpoint is all the
 * platform needs — POST /emails — so there is no SDK dependency to keep
 * current. https://resend.com/docs/api-reference/emails/send-email
 */
export interface OutboundEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

export class ResendError extends Error {
  constructor(message: string, readonly status: number, readonly permanent: boolean) {
    super(message);
    this.name = "ResendError";
  }
}

export interface ResendSender {
  send(email: OutboundEmail): Promise<{ id: string }>;
}

export function createResendSender(apiKey: string, fetchImpl: typeof fetch = fetch): ResendSender {
  return {
    async send(email) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: email.from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          ...(email.headers ? { headers: email.headers } : {}),
          ...(email.tags ? { tags: email.tags } : {}),
        }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        return { id: body.id ?? "" };
      }
      const detail = await res.text().catch(() => "");
      let message = `Resend ${res.status}`;
      try {
        const parsed = JSON.parse(detail) as { message?: string; name?: string };
        if (parsed.message) message = `${message}: ${parsed.name ? `${parsed.name} — ` : ""}${parsed.message}`;
      } catch {
        if (detail) message = `${message}: ${detail.slice(0, 200)}`;
      }
      // 429 and 5xx are worth retrying; a 4xx (bad address, unverified
      // domain, restricted key) will not fix itself.
      const permanent = res.status < 500 && res.status !== 429 && res.status !== 408;
      throw new ResendError(message, res.status, permanent);
    },
  };
}
