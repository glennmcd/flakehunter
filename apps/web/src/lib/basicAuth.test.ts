import { describe, expect, it } from "bun:test";
import { checkBasicAuth, gateDecision } from "./basicAuth";

const basic = (credentials: string) => `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;

describe("checkBasicAuth", () => {
  it("accepts the right password with any username, or none", () => {
    expect(checkBasicAuth(basic("anyone:hunter2"), "hunter2")).toBe(true);
    expect(checkBasicAuth(basic("demo:hunter2"), "hunter2")).toBe(true);
    expect(checkBasicAuth(basic(":hunter2"), "hunter2")).toBe(true);
  });

  it("rejects a wrong, empty, truncated or extended password", () => {
    for (const attempt of ["wrong", "", "hunter", "hunter22", "HUNTER2", " hunter2", "hunter2 "]) {
      expect(checkBasicAuth(basic(`user:${attempt}`), "hunter2")).toBe(false);
    }
  });

  it("splits on the first colon only, so passwords may contain colons", () => {
    expect(checkBasicAuth(basic("user:pa:ss:word"), "pa:ss:word")).toBe(true);
    expect(checkBasicAuth(basic("user:pa:ss:word"), "ss:word")).toBe(false);
  });

  it("handles non-ASCII passwords as UTF-8", () => {
    expect(checkBasicAuth(basic("user:pässwörd✓"), "pässwörd✓")).toBe(true);
    expect(checkBasicAuth(basic("user:passwörd"), "pässwörd✓")).toBe(false);
  });

  it("treats the scheme case-insensitively and tolerates extra spaces", () => {
    const encoded = Buffer.from("user:hunter2").toString("base64");
    expect(checkBasicAuth(`basic ${encoded}`, "hunter2")).toBe(true);
    expect(checkBasicAuth(`BASIC   ${encoded}`, "hunter2")).toBe(true);
  });

  it("rejects missing and malformed headers without throwing", () => {
    const encoded = Buffer.from("user:hunter2").toString("base64");
    const malformed = [
      null,
      undefined,
      "",
      "Basic",
      "Basic ",
      `Bearer ${encoded}`,
      encoded,
      "Basic !!!not-base64!!!",
      `Basic ${Buffer.from("nocolonhere").toString("base64")}`,
      `Basic ${encoded} extra`,
    ];
    for (const header of malformed) {
      expect(checkBasicAuth(header, "hunter2")).toBe(false);
    }
  });

  it("never accepts anything when the expected password is empty", () => {
    expect(checkBasicAuth(basic("user:"), "")).toBe(false);
    expect(checkBasicAuth(basic(":"), "")).toBe(false);
  });
});

describe("gateDecision", () => {
  const good = basic("user:hunter2");

  it("allows a correct password and challenges anything else (401)", () => {
    expect(gateDecision({ authorization: good, sitePassword: "hunter2", nodeEnv: "production" })).toEqual({
      allow: true,
    });
    expect(gateDecision({ authorization: basic("u:nope"), sitePassword: "hunter2", nodeEnv: "production" })).toEqual({
      allow: false,
      status: 401,
    });
    expect(gateDecision({ authorization: null, sitePassword: "hunter2", nodeEnv: "development" })).toEqual({
      allow: false,
      status: 401,
    });
  });

  it("enforces the password in every environment once it is set", () => {
    for (const nodeEnv of ["development", "test", "production", undefined]) {
      expect(gateDecision({ authorization: null, sitePassword: "hunter2", nodeEnv }).allow).toBe(false);
    }
  });

  it("is open without a password in development and test", () => {
    expect(gateDecision({ authorization: null, sitePassword: undefined, nodeEnv: "development" })).toEqual({
      allow: true,
    });
    expect(gateDecision({ authorization: null, sitePassword: undefined, nodeEnv: "test" })).toEqual({ allow: true });
  });

  it("fails closed (503) without a password in production and in any unknown environment", () => {
    for (const nodeEnv of ["production", undefined, "staging", ""]) {
      expect(gateDecision({ authorization: null, sitePassword: undefined, nodeEnv })).toEqual({
        allow: false,
        status: 503,
      });
    }
    // Even a header that looks like credentials does not open an ungated production site.
    expect(gateDecision({ authorization: good, sitePassword: undefined, nodeEnv: "production" })).toEqual({
      allow: false,
      status: 503,
    });
  });

  it("treats an empty password as unset", () => {
    expect(gateDecision({ authorization: null, sitePassword: "", nodeEnv: "production" })).toEqual({
      allow: false,
      status: 503,
    });
    expect(gateDecision({ authorization: null, sitePassword: "", nodeEnv: "development" })).toEqual({ allow: true });
  });
});
