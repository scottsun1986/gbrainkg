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
    if (!['development', 'dev', 'test'].includes(String(process.env.NODE_ENV ?? '').trim().toLowerCase()) || !['1', 'true', 'yes', 'on'].includes(String(process.env.LLMWIKI_ALLOW_DEV_SECRET ?? '').trim().toLowerCase()))
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
    if (payload.length < 29) throw new Error("Invalid encrypted credential envelope");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt model credential; verify MODEL_CONFIG_KEY configuration.");
  }
}

export function isEncryptedModelCredential(
  value?: Uint8Array | Buffer | null,
): boolean {
  return Boolean(
    value?.length && Buffer.from(value).toString("utf8").startsWith(PREFIX),
  );
}

/**
 * Display-only masking. This runs once per provider row, so a single
 * undecryptable value must not fail the whole listing: report it as such
 * instead of propagating the throw. It still surfaces the misconfiguration
 * rather than degrading to "(无密钥)", which is what made a rotated
 * MODEL_CONFIG_KEY look like a wrong password. Value-comparison paths call
 * decryptModelCredential() directly and keep failing closed.
 */
export function maskModelCredential(
  value?: Uint8Array | Buffer | null,
): string {
  let plain: string;
  try {
    plain = decryptModelCredential(value);
  } catch {
    return "无法解密 · 请检查 MODEL_CONFIG_KEY";
  }
  return plain ? `已配置 · ${plain.slice(-4).padStart(4, "*")}` : "(无密钥)";
}
