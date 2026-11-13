import { describe, it, expect } from "vitest";
import { Command } from "commander";
import {
  normalizeEnvName,
  maskSecrets,
  StreamMasker,
  buildInjectedEnv,
  registerInjectCommands,
  type TermixCredentialRaw,
} from "../src/commands/inject.js";
import { UsageError, ExitCode } from "../src/core/errors.js";

describe("inject command", () => {
  describe("normalizeEnvName", () => {
    it("converts spaces, hyphens and special chars to underscores", () => {
      expect(normalizeEnvName("Stripe API-Key#prod")).toBe(
        "STRIPE_API_KEY_PROD",
      );
    });

    it("strips leading and trailing underscores", () => {
      expect(normalizeEnvName("__my_secret__")).toBe("MY_SECRET");
    });
  });

  describe("buildInjectedEnv (Point 1 & 2)", () => {
    const credPassword: TermixCredentialRaw = {
      id: 42,
      name: "Stripe Key",
      username: "admin_user",
      password: "secret_password_123",
      authType: "password",
    };

    const credKey: TermixCredentialRaw = {
      id: 99,
      name: "Bastion SSH",
      username: "ubuntu",
      authType: "key",
      privateKey:
        "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
    };

    it("injects only TERMIX_<ID>_* variables by default (without --names)", () => {
      const env = buildInjectedEnv([credPassword, credKey]);

      expect(env).toEqual({
        TERMIX_42_USERNAME: "admin_user",
        TERMIX_42_PASSWORD: "secret_password_123",
        TERMIX_99_USERNAME: "ubuntu",
        TERMIX_99_KEY:
          "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
      });

      // Crucial: Must NOT contain named variables
      expect(env["STRIPE_KEY"]).toBeUndefined();
      expect(env["STRIPE_KEY_PASSWORD"]).toBeUndefined();
      expect(env["BASTION_SSH_KEY"]).toBeUndefined();
    });

    it("injects normalized named variables when options.names is true", () => {
      const env = buildInjectedEnv([credPassword], { names: true });

      expect(env["TERMIX_42_USERNAME"]).toBe("admin_user");
      expect(env["TERMIX_42_PASSWORD"]).toBe("secret_password_123");
      expect(env["STRIPE_KEY"]).toBe("secret_password_123");
      expect(env["STRIPE_KEY_PASSWORD"]).toBe("secret_password_123");
      expect(env["STRIPE_KEY_USERNAME"]).toBe("admin_user");
    });

    it("throws UsageError if named variable collides with existing process.env", () => {
      const original = process.env.EXISTING_CUSTOM_VAR;
      process.env.EXISTING_CUSTOM_VAR = "pre-existing";

      const collidingCred: TermixCredentialRaw = {
        id: 7,
        name: "Existing Custom Var",
        password: "new-secret",
        authType: "password",
      };

      try {
        expect(() =>
          buildInjectedEnv([collidingCred], { names: true }),
        ).toThrow(UsageError);
      } finally {
        if (original === undefined) {
          delete process.env.EXISTING_CUSTOM_VAR;
        } else {
          process.env.EXISTING_CUSTOM_VAR = original;
        }
      }
    });

    it("throws UsageError if multiple credentials produce duplicate named variables", () => {
      const cred1: TermixCredentialRaw = {
        id: 1,
        name: "Database Cred",
        password: "pw1",
        authType: "password",
      };
      const cred2: TermixCredentialRaw = {
        id: 2,
        name: "Database Cred",
        password: "pw2",
        authType: "password",
      };

      expect(() => buildInjectedEnv([cred1, cred2], { names: true })).toThrow(
        UsageError,
      );
    });

    it("throws UsageError if a key-based credential lacks a private key", () => {
      const emptyKeyCred: TermixCredentialRaw = {
        id: 10,
        name: "Broken Key",
        authType: "key",
      };

      expect(() => buildInjectedEnv([emptyKeyCred])).toThrow(UsageError);
    });
  });

  describe("maskSecrets and StreamMasker (Point 5)", () => {
    it("redacts complete secrets in a single string", () => {
      const secrets = ["supersecret123", "password"];
      const text = "connecting with password and token supersecret123 now";
      const masked = maskSecrets(text, secrets);
      expect(masked).toBe(
        "connecting with [REDACTED_BY_TERMIX] and token [REDACTED_BY_TERMIX] now",
      );
    });

    it("masks secrets that are split across chunk boundaries", () => {
      const secret = "VERY_LONG_TOP_SECRET_TOKEN";
      const masker = new StreamMasker([secret]);

      const chunk1 = "Authorization: Bearer VERY_LONG_TOP_";
      const chunk2 = "SECRET_TOKEN in request header";

      let emitted = "";
      emitted += masker.process(chunk1);
      emitted += masker.process(chunk2);
      emitted += masker.flush();

      expect(emitted).toBe(
        "Authorization: Bearer [REDACTED_BY_TERMIX] in request header",
      );
    });

    it("masks secrets split across multiple tiny chunks", () => {
      const secret = "SPLIT_SECRET";
      const masker = new StreamMasker([secret]);

      const parts = ["prefix-", "SP", "LI", "T_", "SE", "CR", "ET", "-suffix"];
      let emitted = "";
      for (const p of parts) {
        emitted += masker.process(p);
      }
      emitted += masker.flush();

      expect(emitted).toBe("prefix-[REDACTED_BY_TERMIX]-suffix");
    });

    it("emits output immediately when secrets list is empty or keepLen is 0 without buffering", () => {
      const masker = new StreamMasker([]);
      const chunk = "Immediate real-time log output";
      const emitted = masker.process(chunk);
      expect(emitted).toBe("Immediate real-time log output");
      expect(masker.flush()).toBe("");
    });

    it("emits non-secret data without distortion when flushed", () => {
      const secret = "SUPER_SECRET";
      const masker = new StreamMasker([secret]);

      let emitted = "";
      emitted += masker.process("Hello world! Just a normal log line.");
      emitted += masker.flush();

      expect(emitted).toBe("Hello world! Just a normal log line.");
    });
  });

  describe("command configuration and usage exit code", () => {
    it("configures inject with allowUnknownOption so child command flags do not fail parsing", () => {
      const program = new Command();
      registerInjectCommands(program);
      const inject = program.commands.find((c) => c.name() === "inject");
      expect(inject).toBeDefined();
      // @ts-expect-error commander internal property
      expect(inject?._allowUnknownOption).toBe(true);
    });

    it("maps UsageError exitCode to ExitCode.USAGE (code 2)", () => {
      const error = new UsageError(
        "Missing '--' separator before the command to run.",
      );
      expect(error.exitCode).toBe(ExitCode.USAGE);
      expect(error.exitCode).toBe(2);
    });
  });
});
