import { describe, expect, it } from "bun:test";
import type { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoRateLimitStore, MemoryRateLimitStore } from "./store.js";

// 2026-03-31T12:00:30Z; a 60 second window containing it runs from 12:00:00 to 12:01:00.
const NOW = Date.UTC(2026, 2, 31, 12, 0, 30);
const WINDOW_END = Date.UTC(2026, 2, 31, 12, 1, 0) / 1000;

describe("MemoryRateLimitStore", () => {
  it("counts hits per key within a window and reports when the window ends", async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.hit("a", 60, NOW)).toEqual({ count: 1, resetAt: WINDOW_END });
    expect(await store.hit("a", 60, NOW + 5000)).toEqual({ count: 2, resetAt: WINDOW_END });
    expect((await store.hit("a", 60, NOW + 20_000)).count).toBe(3);
  });

  it("keeps keys independent", async () => {
    const store = new MemoryRateLimitStore();
    await store.hit("a", 60, NOW);
    await store.hit("a", 60, NOW);
    expect((await store.hit("b", 60, NOW)).count).toBe(1);
  });

  it("starts again in the next window", async () => {
    const store = new MemoryRateLimitStore();
    await store.hit("a", 60, NOW);
    await store.hit("a", 60, NOW);
    const next = await store.hit("a", 60, NOW + 31_000);
    expect(next).toEqual({ count: 1, resetAt: WINDOW_END + 60 });
  });

  it("forgets windows that have ended", async () => {
    const store = new MemoryRateLimitStore();
    await store.hit("a", 60, NOW);
    await store.hit("b", 60, NOW);
    expect(store.size).toBe(2);
    await store.hit("c", 60, NOW + 120_000);
    expect(store.size).toBe(1);
  });
});

function fakeDynamo(respond: (input: UpdateItemCommand["input"]) => { Attributes?: Record<string, { N?: string }> }) {
  const sent: UpdateItemCommand["input"][] = [];
  const client = {
    async send(command: UpdateItemCommand) {
      sent.push(command.input);
      return respond(command.input);
    },
  };
  return { client, sent };
}

describe("DynamoRateLimitStore", () => {
  it("does one atomic ADD per hit on a per-window item, with a TTL, and returns the new count", async () => {
    const { client, sent } = fakeDynamo(() => ({ Attributes: { hits: { N: "7" } } }));
    const store = new DynamoRateLimitStore(client, "rate-limits");

    expect(await store.hit("token:abc", 60, NOW)).toEqual({ count: 7, resetAt: WINDOW_END });

    expect(sent).toHaveLength(1);
    const input = sent[0];
    expect(input?.TableName).toBe("rate-limits");
    expect(input?.Key).toEqual({ pk: { S: `token:abc#${Math.floor(NOW / 1000 / 60)}` } });
    expect(input?.UpdateExpression).toBe("ADD hits :one SET expiresAt = :expires");
    expect(input?.ExpressionAttributeValues?.[":one"]).toEqual({ N: "1" });
    // Expires after the window ends, with slack, so the counter is never deleted while it is still counting.
    expect(Number(input?.ExpressionAttributeValues?.[":expires"]?.N)).toBeGreaterThan(WINDOW_END);
    expect(input?.ReturnValues).toBe("UPDATED_NEW");
  });

  it("uses a different item for the next window", async () => {
    const { client, sent } = fakeDynamo(() => ({ Attributes: { hits: { N: "1" } } }));
    const store = new DynamoRateLimitStore(client, "t");
    await store.hit("k", 60, NOW);
    await store.hit("k", 60, NOW + 31_000);
    expect(sent[0]?.Key?.pk?.S).not.toBe(sent[1]?.Key?.pk?.S);
  });

  it("fails loudly if DynamoDB returns no count", async () => {
    const { client } = fakeDynamo(() => ({}));
    await expect(new DynamoRateLimitStore(client, "t").hit("k", 60, NOW)).rejects.toThrow("hit count");
  });

  it("passes DynamoDB errors through", async () => {
    const client = {
      send: async () => {
        throw new Error("ProvisionedThroughputExceededException");
      },
    };
    await expect(new DynamoRateLimitStore(client, "t").hit("k", 60, NOW)).rejects.toThrow("Provisioned");
  });
});
