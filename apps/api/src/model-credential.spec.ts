import {
  decryptModelCredential,
  encryptModelCredential,
  isEncryptedModelCredential,
  maskModelCredential,
} from "./model-credential";

describe("model credentials", () => {
  const originalKey = process.env.MODEL_CONFIG_KEY;

  beforeAll(() => {
    process.env.MODEL_CONFIG_KEY = "a-test-key-that-is-long-and-independent";
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.MODEL_CONFIG_KEY;
    else process.env.MODEL_CONFIG_KEY = originalKey;
  });

  it("encrypts at rest and decrypts for provider calls", () => {
    const encrypted = encryptModelCredential("sk-sensitive-1234");
    expect(encrypted.toString("utf8")).not.toContain("sk-sensitive-1234");
    expect(isEncryptedModelCredential(encrypted)).toBe(true);
    expect(decryptModelCredential(encrypted)).toBe("sk-sensitive-1234");
    expect(maskModelCredential(encrypted)).toBe("已配置 · 1234");
  });

  it('reports key rotation or tampering instead of silently returning an empty credential', () => {
    const encrypted = encryptModelCredential('secret');
    const key = process.env.MODEL_CONFIG_KEY;
    try {
      process.env.MODEL_CONFIG_KEY = 'wrong-key';
      expect(() => decryptModelCredential(encrypted)).toThrow('Unable to decrypt');
    } finally { process.env.MODEL_CONFIG_KEY = key; }
  });

  it("continues to read legacy plaintext during migration", () => {
    expect(decryptModelCredential(Buffer.from("legacy-key"))).toBe(
      "legacy-key",
    );
  });
});
