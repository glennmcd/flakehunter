import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";

export interface RateLimitHit {
  /** Requests counted for this key in the current window, this one included. */
  count: number;
  /** Seconds since the epoch at which the current window ends and the count starts again. */
  resetAt: number;
}

/**
 * Counts requests per key in fixed windows. The in-memory implementation serves tests and local development; on
 * Lambda the count must live outside the process (every concurrent invocation is a separate process), so production
 * uses the DynamoDB implementation.
 */
export interface RateLimitStore {
  hit(key: string, windowSeconds: number, nowMs?: number): Promise<RateLimitHit>;
}

function windowOf(nowMs: number, windowSeconds: number) {
  const bucket = Math.floor(nowMs / 1000 / windowSeconds);
  return { bucket, resetAt: (bucket + 1) * windowSeconds };
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowSeconds: number, nowMs: number = Date.now()): Promise<RateLimitHit> {
    const { bucket, resetAt } = windowOf(nowMs, windowSeconds);
    const id = `${key}#${bucket}`;
    const entry = this.counts.get(id) ?? { count: 0, resetAt };
    entry.count += 1;
    this.counts.set(id, entry);

    // Drop windows that have ended so the map does not grow without bound.
    const nowSeconds = nowMs / 1000;
    for (const [other, value] of this.counts) if (value.resetAt <= nowSeconds) this.counts.delete(other);

    return { count: entry.count, resetAt };
  }

  /** Number of live counters; for tests. */
  get size() {
    return this.counts.size;
  }
}

/** The slice of DynamoDBClient this module uses, so tests can pass a plain fake. */
export interface DynamoLike {
  send(command: UpdateItemCommand): Promise<{ Attributes?: Record<string, { N?: string } | undefined> }>;
}

/** How long past the end of its window a counter lives before DynamoDB's TTL may delete it. */
const TTL_SLACK_SECONDS = 120;

/**
 * A fixed-window counter in one DynamoDB item per key and window: an atomic `ADD hits 1`, so concurrent Lambda
 * instances never lose a count. The table needs a string partition key `pk` and TTL enabled on `expiresAt`.
 */
export class DynamoRateLimitStore implements RateLimitStore {
  constructor(
    private readonly client: DynamoLike,
    private readonly tableName: string,
  ) {}

  async hit(key: string, windowSeconds: number, nowMs: number = Date.now()): Promise<RateLimitHit> {
    const { bucket, resetAt } = windowOf(nowMs, windowSeconds);
    const result = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: `${key}#${bucket}` } },
        UpdateExpression: "ADD hits :one SET expiresAt = :expires",
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":expires": { N: String(resetAt + TTL_SLACK_SECONDS) },
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const hits = Number(result.Attributes?.hits?.N);
    if (!Number.isFinite(hits)) throw new Error("DynamoDB did not return a hit count for the rate limit counter");
    return { count: hits, resetAt };
  }
}
