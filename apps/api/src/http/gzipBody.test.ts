import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";
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

  it("stops at the limit even when the compressed source never ends", async () => {
    // An endless gzip stream of zeros: the only way this test can finish is for the limiter to stop reading, so there
    // is no dependence on how deeply the streams buffer (a size comparison was flaky across platforms).
    const zeros = Readable.from(
      (function* () {
        for (;;) yield Buffer.alloc(16 * 1024);
      })(),
    );
    const endless = zeros.pipe(createGzip());

    const error = await readAll(gunzipLimited(endless, 1024)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("payload_too_large");
    expect(endless.destroyed).toBe(true);
  });

  it("fails with validation_error for bytes that are not gzip", async () => {
    const error = await readAll(gunzipLimited(Readable.from([Buffer.from("plain text")]), 1024)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("validation_error");
  });
});
