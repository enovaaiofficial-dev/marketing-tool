import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { ENCRYPTION_ALGORITHM } from "@shared/constants";

const ENCRYPTION_KEY = getEncryptionKey();

function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) return Buffer.from(envKey, "hex");
  return Buffer.from("default-dev-key-do-not-use-in-production!", "utf8").subarray(0, 32);
}

export function encryptToken(plain: string): { encrypted: string; iv: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
  };
}

export function decryptToken(encrypted: string, iv: string): string {
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    ENCRYPTION_KEY,
    Buffer.from(iv, "hex")
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function maskToken(token: string): string {
  if (token.length <= 8) return token + "****";
  return token.slice(0, 8) + "****";
}
