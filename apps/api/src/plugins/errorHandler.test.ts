import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "../api/errors.js";
import errorHandlerPlugin from "./errorHandler.js";

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);

  app.get("/typed", { schema: { querystring: z.object({ limit: z.coerce.number().int().max(10) }) } }, async () => ({
    ok: true,
  }));
  app.get("/not-found", async () => {
    throw new ApiError("not_found", "Test 42 not found");
  });
  app.get("/unauthorized", async () => {
    throw new ApiError("unauthorized", "nope");
  });
  app.get("/invalid-report", async () => {
    throw new ApiError("invalid_report", "not junit");
  });
  app.get("/boom", async () => {
    throw new Error("secret database password is hunter2");
  });
  app.post("/small", { bodyLimit: 10 }, async () => ({ ok: true }));
  return app;
}

describe("error handler", () => {
  it("maps ApiError codes to status and the standard body", async () => {
    const app = await buildApp();
    const cases = [
      ["/not-found", 404, "not_found"],
      ["/unauthorized", 401, "unauthorized"],
      ["/invalid-report", 422, "invalid_report"],
    ] as const;
    for (const [url, status, code] of cases) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(status);
      const body = res.json();
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
      expect(body.error.details).toBeUndefined();
      expect(body.requestId).toBeTruthy();
    }
  });

  it("turns zod validation failures into 400 validation_error with details paths", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/typed?limit=99" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details).toHaveLength(1);
    expect(body.error.details[0].path).toBe("querystring.limit");
    expect(body.requestId).toBeTruthy();
  });

  it("returns 413 payload_too_large when the body exceeds bodyLimit", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/small",
      headers: { "content-type": "text/plain" },
      payload: "x".repeat(100),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("returns 500 internal_error without leaking the underlying message", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");
    expect(res.body).not.toContain("hunter2");
  });
});
