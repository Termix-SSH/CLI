import { describe, it, expect } from "vitest";
import { normalizeEnvName, maskSecrets } from "../src/commands/inject.js";

describe("termix inject helper utilities", () => {
  describe("normalizeEnvName", () => {
    it("converts spaces, hyphens and special chars to uppercase underscores", () => {
      expect(normalizeEnvName("Database Prod (Primary)")).toBe(
        "DATABASE_PROD__PRIMARY",
      );
      expect(normalizeEnvName("api-key-staging")).toBe("API_KEY_STAGING");
      expect(normalizeEnvName("@super_secret#2026!")).toBe("SUPER_SECRET_2026");
    });

    it("trims leading and trailing underscores", () => {
      expect(normalizeEnvName("_my_var_")).toBe("MY_VAR");
      expect(normalizeEnvName("---test---")).toBe("TEST");
    });
  });

  describe("maskSecrets", () => {
    it("replaces detected secrets in text output with REDACTED placeholder", () => {
      const output =
        "Connecting to database with password s3cr3t_pass_123 on host 10.0.0.1";
      const masked = maskSecrets(output, ["s3cr3t_pass_123"]);
      expect(masked).toBe(
        "Connecting to database with password [REDACTED_BY_TERMIX] on host 10.0.0.1",
      );
    });

    it("masks multiple secrets independently", () => {
      const output = "USER=admin PASS=very_secret_pwd TOKEN=tok_abc123456";
      const masked = maskSecrets(output, ["very_secret_pwd", "tok_abc123456"]);
      expect(masked).toBe(
        "USER=admin PASS=[REDACTED_BY_TERMIX] TOKEN=[REDACTED_BY_TERMIX]",
      );
    });

    it("preserves text if no secrets match", () => {
      const output = "All tests passed successfully.";
      const masked = maskSecrets(output, ["non_existent_secret"]);
      expect(masked).toBe("All tests passed successfully.");
    });
  });
});
