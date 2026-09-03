import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { newConfirmationCode, parseSignedRequest, SignedRequestError } from "./data-deletion.js";

const SECRET = "test-app-secret";

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${signature}.${encoded}`;
}

describe("parseSignedRequest", () => {
  it("accepts a correctly signed request", () => {
    const parsed = parseSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "1234" }), SECRET);
    expect(parsed.user_id).toBe("1234");
  });

  it("rejects a request signed with the wrong secret", () => {
    const forged = sign({ algorithm: "HMAC-SHA256", user_id: "1234" }, "not-our-secret");
    expect(() => parseSignedRequest(forged, SECRET)).toThrow(SignedRequestError);
  });

  it("rejects a tampered payload", () => {
    const good = sign({ algorithm: "HMAC-SHA256", user_id: "1234" });
    const [signature] = good.split(".");
    const swapped = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "9999" })).toString("base64url");
    expect(() => parseSignedRequest(`${signature}.${swapped}`, SECRET)).toThrow(SignedRequestError);
  });

  it("refuses algorithm downgrade", () => {
    expect(() => parseSignedRequest(sign({ algorithm: "none", user_id: "1234" }), SECRET)).toThrow(/Unsupported algorithm/);
  });

  it("refuses a payload with no user", () => {
    expect(() => parseSignedRequest(sign({ algorithm: "HMAC-SHA256" }), SECRET)).toThrow(/No user/);
  });

  it("refuses a malformed request", () => {
    expect(() => parseSignedRequest("nonsense", SECRET)).toThrow(/Malformed/);
  });

  it("mints distinct confirmation codes", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newConfirmationCode()));
    expect(codes.size).toBe(200);
  });
});
