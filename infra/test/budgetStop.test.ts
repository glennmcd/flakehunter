import { describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const handlerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../lambda/budget-stop/index.mjs");

interface Handler {
  createHandler(deps: {
    setConcurrency(functionName: string, limit: number): Promise<unknown>;
    functionName?: string;
  }): () => Promise<unknown>;
}

// Imported by path so the plain JavaScript Lambda needs no type declarations.
const { createHandler } = (await import(handlerPath)) as Handler;

describe("budget stop handler", () => {
  it("sets the API function's reserved concurrency to 0", async () => {
    const calls: [string, number][] = [];
    const handler = createHandler({
      setConcurrency: async (name, limit) => {
        calls.push([name, limit]);
      },
      functionName: "flakehunter-api-fn",
    });

    expect(await handler()).toEqual({ stopped: "flakehunter-api-fn" });
    expect(calls).toEqual([["flakehunter-api-fn", 0]]);
  });

  it("fails fast when the function name is missing", () => {
    expect(() => createHandler({ setConcurrency: async () => {} })).toThrow("FUNCTION_NAME");
  });

  it("lets an AWS error through, so the failed invocation is visible and retried", async () => {
    const handler = createHandler({
      setConcurrency: async () => {
        throw new Error("AccessDenied");
      },
      functionName: "f",
    });
    await expect(handler()).rejects.toThrow("AccessDenied");
  });
});
