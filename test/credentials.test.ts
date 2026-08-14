import { describe, it, expect } from "vitest";
import { sanitiseCredential } from "../src/commands/credentials.js";

describe("sanitiseCredential", () => {
  it("keeps safe metadata fields", () => {
    const cred = {
      id: 5,
      name: "prod-key",
      description: "deploy key",
      folder: "prod",
      tags: ["a"],
      authType: "key",
      username: "root",
      publicKey: "ssh-ed25519 AAA...",
      keyType: "ssh-ed25519",
      usageCount: 3,
      hasKey: true,
      hasKeyPassword: false,
    };
    expect(sanitiseCredential(cred)).toEqual(cred);
  });

  it("drops the plaintext secrets returned by GET /credentials/:id", () => {
    const out = sanitiseCredential({
      id: 5,
      name: "prod-key",
      password: "s3cret",
      key: "-----BEGIN OPENSSH PRIVATE KEY-----",
      keyPassword: "passphrase",
    });
    expect(out).toEqual({ id: 5, name: "prod-key" });
  });

  it("drops unknown fields (allowlist, not blocklist)", () => {
    const out = sanitiseCredential({
      id: 1,
      someFutureSecret: "leak-me-not",
    });
    expect(out).toEqual({ id: 1 });
  });
});
