import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { ApiError } from "../api/errors.js";
import { gunzipLimited } from "./gzipBody.js";

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("gunzipLimited", () => {
  it("decompresses and reports how many compressed bytes it read", async () => {
    const compressed = gzipSync("hello gzip");
    const out = gunzipLimited(Readable.from([compressed]), 1024);
    expect((await readAll(out)).toString()).toBe("hello gzip");
    expect((out as unknown as { receivedEncodedLength: number }).receivedEncodedLength).toBe(compressed.length);
  });

  it("allows output of exactly the limit", async () => {
    const out = gunzipLimited(Readable.from([gzipSync(Buffer.alloc(100, "x"))]), 100);
    expect((await readAll(out)).length).toBe(100);
  });

  it("fails with payload_too_large one byte over the limit", async () => {
    const out = gunzipLimited(Readable.from([gzipSync(Buffer.alloc(101, "x"))]), 100);
    const error = await readAll(out).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("payload_too_large");
  });

  it("stops reading its source once the limit is hit instead of decompressing it all", async () => {
    // 64 MiB of zeros gzip to about 64 KB; with a 1 KiB limit the source must be destroyed long before it is drained.
    const compressed = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    let pushed = 0;
    const source = new Readable({
      read() {
        const chunk = compressed.subarray(pushed, pushed + 1024);
        pushed += chunk.length;
        this.push(chunk.length ? chunk : null);
      },
    });
    await readAll(gunzipLimited(source, 1024)).catch(() => undefined);
    expect(source.destroyed).toBe(true);
    expect(pushed).toBeLessThan(compressed.length);
  });

  it("fails with validation_error for bytes that are not gzip", async () => {
    const error = await readAll(gunzipLimited(Readable.from([Buffer.from("plain text")]), 1024)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("validation_error");
  });
});
