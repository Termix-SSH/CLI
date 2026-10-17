import { describe, expect, it } from "vitest";
import {
  listenForBrowserLogin,
  pickBrowserLogin,
  type PublicLoginMethod,
} from "../src/core/browser-login.js";

const methods: PublicLoginMethod[] = [
  { id: "password", kind: "form", instances: [] },
  {
    id: "oidc",
    kind: "redirect",
    instances: [
      { id: "1", label: "Entra" },
      { id: "2", label: "Google" },
    ],
  },
];

describe("pickBrowserLogin", () => {
  it("uses the only provider without a name", () => {
    const one: PublicLoginMethod[] = [
      {
        id: "oidc",
        kind: "redirect",
        instances: [{ id: "1", label: "Entra" }],
      },
    ];
    expect(pickBrowserLogin(one)).toEqual({
      methodId: "oidc",
      instanceId: "1",
      label: "Entra",
    });
  });

  it("matches a provider by label or id", () => {
    expect(pickBrowserLogin(methods, "google").instanceId).toBe("2");
    expect(pickBrowserLogin(methods, "1").label).toBe("Entra");
  });

  it("asks for a name when there are several, and lists them", () => {
    expect(() => pickBrowserLogin(methods)).toThrow(/"Entra", "Google"/);
    expect(() => pickBrowserLogin(methods, "okta")).toThrow(
      /No single sign-on/,
    );
    expect(() => pickBrowserLogin([methods[0]!])).toThrow(/no single sign-on/);
  });
});

describe("listenForBrowserLogin", () => {
  it("takes the token from the loopback callback", async () => {
    const listener = await listenForBrowserLogin(5000);
    const res = await fetch(
      `http://localhost:${listener.port}/oidc-callback?success=true&token=abc`,
    );
    expect(res.status).toBe(200);
    await expect(listener.result).resolves.toEqual({
      kind: "token",
      token: "abc",
    });
  });

  it("hands back a pending second factor", async () => {
    const listener = await listenForBrowserLogin(5000);
    await fetch(
      `http://localhost:${listener.port}/oidc-callback?second_factor=1&temp_token=t&second_factors=totp,webauthn`,
    );
    await expect(listener.result).resolves.toEqual({
      kind: "second-factor",
      tempToken: "t",
      factors: ["totp", "webauthn"],
    });
  });

  it("reports a failed sign in", async () => {
    const listener = await listenForBrowserLogin(5000);
    await fetch(
      `http://localhost:${listener.port}/oidc-callback?success=false&error=denied`,
    );
    await expect(listener.result).rejects.toThrow("denied");
  });
});
