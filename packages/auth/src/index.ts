import {
  randomBytes, scrypt as scryptCb, timingSafeEqual, createHash,
  createCipheriv, createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import { ORG_ROLE_ORDER, type OrgRole } from "@deedwell/schemas";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

// Parameters are encoded into the stored hash so they can be raised later
// without invalidating existing credentials.
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, keyB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(keyB64!, "base64");
  const actual = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Opaque 256-bit session token. Only its SHA-256 hash is ever stored. */
export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function roleAtLeast(actual: OrgRole, required: OrgRole): boolean {
  return ORG_ROLE_ORDER.indexOf(actual) >= ORG_ROLE_ORDER.indexOf(required);
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// At-rest secret encryption (Google Ad Grants session storage). AES-256-GCM
// keyed from a required env var; keyVersion travels alongside the ciphertext
// so a future key rotation never strands existing rows, the same idea
// hashPassword already uses for its scrypt parameters.
// ---------------------------------------------------------------------------

const IV_LEN = 12; // recommended nonce length for GCM

function loadEncryptionKey(keyVersion: number): Buffer {
  if (keyVersion !== 1) {
    throw new Error(`No encryption key registered for version ${keyVersion}`);
  }
  const b64 = process.env.SESSION_ENCRYPTION_KEY;
  if (!b64) throw new Error("SESSION_ENCRYPTION_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function encryptSecret(plaintext: Buffer, keyVersion = 1): EncryptedSecret {
  const key = loadEncryptionKey(keyVersion);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion };
}

export function decryptSecret(secret: EncryptedSecret): Buffer {
  const key = loadEncryptionKey(secret.keyVersion);
  const decipher = createDecipheriv("aes-256-gcm", key, secret.iv);
  decipher.setAuthTag(secret.tag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]);
}
