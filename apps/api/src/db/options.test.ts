import { describe, expect, it } from "bun:test";
import { dbOptionsFor, isPooledNeonUrl } from "./options.js";

const DIRECT = "postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/db?sslmode=require";
const POOLED = "postgres://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require";

describe("isPooledNeonUrl", () => {
  it("recognises the -pooler host", () => {
    expect(isPooledNeonUrl(POOLED)).toBe(true);
    expect(isPooledNeonUrl(DIRECT)).toBe(false);
  });

  it("only looks at the host's first label, not the password or path", () => {
    expect(isPooledNeonUrl("postgres://u:-pooler@db.example.com/-pooler")).toBe(false);
    expect(isPooledNeonUrl("postgres://u:p@db-pooler.example.com/db")).toBe(true);
  });

  it("is false for a string that is not a URL", () => {
    expect(isPooledNeonUrl("not a url")).toBe(false);
    expect(isPooledNeonUrl("")).toBe(false);
  });
});

describe("dbOptionsFor", () => {
  it("uses postgres-js defaults locally against a direct connection", () => {
    expect(dbOptionsFor(DIRECT, {})).toEqual({});
  });

  it("uses a single connection with timeouts on Lambda", () => {
    expect(dbOptionsFor(DIRECT, { AWS_LAMBDA_FUNCTION_NAME: "flakehunter-api" })).toEqual({
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  });

  it("turns off prepared statements for the pooled endpoint, wherever it runs", () => {
    expect(dbOptionsFor(POOLED, {})).toEqual({ prepare: false });
    expect(dbOptionsFor(POOLED, { AWS_LAMBDA_FUNCTION_NAME: "f" })).toEqual({
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  });

  it("reads process.env by default", () => {
    const saved = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = "f";
    try {
      expect(dbOptionsFor(DIRECT).max).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = saved;
    }
  });
});
