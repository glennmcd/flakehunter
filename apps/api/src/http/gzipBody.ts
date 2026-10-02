import { pipeline, type Readable, Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import type { preParsingAsyncHookHandler } from "fastify";
import { ApiError } from "../api/errors.js";

/**
 * Gunzips `source`, failing as soon as the decompressed size passes `maxBytes`. The limit is on the decompressed
 * bytes, because a few kilobytes of gzip can expand to gigabytes: counting only the compressed length would let a
 * decompression bomb through. The stream is destroyed at the limit, so nothing keeps decompressing.
 *
 * The result carries `receivedEncodedLength` (the compressed bytes read), which Fastify compares with Content-Length
 * instead of the decompressed length.
 */
export function gunzipLimited(source: Readable, maxBytes: number): Readable {
  let encoded = 0;
  let decoded = 0;

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      encoded += chunk.length;
      callback(null, chunk);
    },
  });

  const gunzip = createGunzip();

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decoded += chunk.length;
      if (decoded > maxBytes) {
        callback(new ApiError("payload_too_large", `Decompressed request body exceeds ${maxBytes} bytes`));
      } else {
        callback(null, chunk);
      }
    },
  });

  // Registered before pipeline() so the client sees a 400 rather than zlib's internal message.
  gunzip.on("error", () => {
    limiter.destroy(
      new ApiError("validation_error", "Request body is not valid gzip data", [
        { path: "body", message: "could not be decompressed" },
      ]),
    );
  });

  pipeline(source, counter, gunzip, limiter, () => {
    // Errors reach the consumer through the destroyed `limiter`; this callback only prevents an unhandled error.
  });

  Object.defineProperty(limiter, "receivedEncodedLength", { get: () => encoded });
  return limiter;
}

/** The Content-Encoding values meaning "gzip"; "identity" or none means the body is sent as is. */
function parseEncodings(header: string | string[] | undefined): string[] {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  return value
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "identity");
}

/**
 * A Fastify preParsing hook that accepts `Content-Encoding: gzip` request bodies, enforcing `maxDecompressedBytes` on
 * the decompressed size. Other encodings are rejected with a 400 rather than parsed as garbage.
 */
export function gzipPreParsing(maxDecompressedBytes: number): preParsingAsyncHookHandler {
  return async (request, _reply, payload) => {
    const encodings = parseEncodings(request.headers["content-encoding"]);
    if (encodings.length === 0) return payload;
    const first = encodings[0];
    if (encodings.length === 1 && (first === "gzip" || first === "x-gzip")) {
      return gunzipLimited(payload, maxDecompressedBytes);
    }
    throw new ApiError("validation_error", "Unsupported Content-Encoding; only gzip is accepted", [
      { path: "headers.content-encoding", message: "expected gzip" },
    ]);
  };
}
