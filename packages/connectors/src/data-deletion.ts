import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Meta's signed_request: `{base64url(signature)}.{base64url(payload)}`, where
 * the signature is HMAC-SHA256 of the *encoded payload string* — not of the
 * decoded JSON — keyed with the app secret.
 */
export interface SignedRequestPayload {
  algorithm: string;
  issued_at?: number;
  user_id?: string;
}

export class SignedRequestError extends Error {}

export function parseSignedRequest(signedRequest: string, appSecret: string): SignedRequestPayload {
  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new SignedRequestError("Malformed signed request");
  const encodedSignature: string = parts[0];
  const encodedPayload: string = parts[1];

  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  const provided = Buffer.from(encodedSignature, "base64url");
  // Length-check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and that throw would itself leak the length.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new SignedRequestError("Bad signature");
  }

  let payload: SignedRequestPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new SignedRequestError("Unreadable payload");
  }
  if ((payload.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") {
    // Refusing an unexpected algorithm is the whole point — accepting
    // "algorithm": "none" is the classic way this check gets bypassed.
    throw new SignedRequestError(`Unsupported algorithm: ${payload.algorithm}`);
  }
  if (!payload.user_id) throw new SignedRequestError("No user in signed request");
  return payload;
}

/** Short, unambiguous, and safe to read down a phone line. */
export function newConfirmationCode(): string {
  return randomBytes(9).toString("base64url").replace(/[-_]/g, "").slice(0, 12).toUpperCase();
}
