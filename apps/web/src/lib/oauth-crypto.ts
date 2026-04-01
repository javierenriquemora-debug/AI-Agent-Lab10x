import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;

function parseEncryptionKey(): Buffer {
  const rawKey = process.env.OAUTH_ENCRYPTION_KEY?.trim();
  if (!rawKey) {
    throw new Error("Missing OAUTH_ENCRYPTION_KEY");
  }

  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, "hex");
  }

  const base64Key = Buffer.from(rawKey, "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }

  const utf8Key = Buffer.from(rawKey, "utf8");
  if (utf8Key.length === 32) {
    return utf8Key;
  }

  throw new Error(
    "OAUTH_ENCRYPTION_KEY must be 32 bytes as raw text, 64 hex chars, or base64 for 32 bytes"
  );
}

export function encryptOAuthPayload(payload: Record<string, unknown>): string {
  const key = parseEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

export function decryptOAuthPayload<T>(encryptedPayload: string): T {
  const key = parseEncryptionKey();
  const payload = JSON.parse(encryptedPayload) as {
    iv?: string;
    tag?: string;
    data?: string;
  };

  if (!payload.iv || !payload.tag || !payload.data) {
    throw new Error("Invalid encrypted OAuth payload");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8")) as T;
}
