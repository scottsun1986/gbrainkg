import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const PREFIX = "enc:v1:";

function encryptionKey(): Buffer {
  const secret = process.env.MODEL_CONFIG_KEY || process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error(
        "MODEL_CONFIG_KEY or AUTH_SECRET is required to protect model credentials.",
      );
    return createHash("sha256")
      .update("llmwiki-local-model-config-key")
      .digest();
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptModelCredential(value: string): Buffer {
  if (!value) return Buffer.alloc(0);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`,
    "utf8",
  );
}

export function decryptModelCredential(
  value?: Uint8Array | Buffer | null,
): string {
  if (!value?.length) return "";
  const stored = Buffer.from(value).toString("utf8");
  // Backward compatibility for credentials written before encryption was
  // enabled. The next provider update rewrites them in encrypted form.
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const payload = Buffer.from(stored.slice(PREFIX.length), "base64");
    if (payload.length < 29) return "";
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    return "";
  }
}

export function isEncryptedModelCredential(
  value?: Uint8Array | Buffer | null,
): boolean {
  return Boolean(
    value?.length && Buffer.from(value).toString("utf8").startsWith(PREFIX),
  );
}

export function maskModelCredential(
  value?: Uint8Array | Buffer | null,
): string {
  const plain = decryptModelCredential(value);
  return plain ? `已配置 · ${plain.slice(-4).padStart(4, "*")}` : "(无密钥)";
}
