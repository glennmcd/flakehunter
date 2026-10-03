import { Unzip, type UnzipFile, UnzipInflate } from "fflate";
import { ArtifactRejectedError, MAX_REPORT_BYTES, MAX_ZIP_ENTRIES } from "./limits.js";

export interface ExtractedXmlFile {
  fileName: string;
  contents: string;
}

export interface ZipLimits {
  /** Most entries read from the archive. */
  maxEntries: number;
  /** Most decompressed bytes across all XML entries together. */
  maxXmlBytes: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxEntries: MAX_ZIP_ENTRIES, maxXmlBytes: MAX_REPORT_BYTES };

/**
 * The archive is fed to the unzipper in chunks this size, so a single decompression step emits at most about a
 * thousand times this much (DEFLATE's maximum ratio, so about 4 MB) before the byte count is checked again.
 */
const PUSH_CHUNK_BYTES = 4 * 1024;

/** Thrown inside the unzipper to stop it immediately; turned into an ArtifactRejectedError by the caller. */
class LimitReached extends Error {}

/**
 * Extracts the `.xml` entries of an artifact zip. The artifact comes from a workflow run, so its content is
 * untrusted: only XML entries are ever decompressed, and decompression stops as soon as the actual decompressed
 * bytes (not the sizes the archive declares, which the archive's author chooses) pass `maxXmlBytes`.
 *
 * Limitation: for entries whose sizes come in a data descriptor (how streaming zippers, including
 * actions/upload-artifact, write them), fflate finds the end of the entry by scanning for zip signatures. If those
 * bytes happen to occur inside the compressed data, the entry is cut short and the artifact is rejected as invalid.
 * That fails closed and is rare (roughly one in a million per kilobyte of compressed XML).
 */
export function extractXmlFiles(zipBuffer: Uint8Array, limits: ZipLimits = DEFAULT_LIMITS): ExtractedXmlFile[] {
  // The streaming unzipper skips bytes it does not recognise, so check the signature: a local file header, or the
  // end-of-archive record of an empty zip.
  if (!startsWithZipSignature(zipBuffer)) throw new ArtifactRejectedError("artifact is not a valid zip archive");

  const files: ExtractedXmlFile[] = [];
  let entries = 0;
  let xmlBytes = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file: UnzipFile) => {
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new LimitReached(`artifact has more than ${limits.maxEntries} entries`);
    }
    if (!file.name.toLowerCase().endsWith(".xml")) return;

    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      xmlBytes += chunk.length;
      if (xmlBytes > limits.maxXmlBytes) {
        file.terminate();
        throw new LimitReached(`artifact XML exceeds ${limits.maxXmlBytes} bytes decompressed`);
      }
      chunks.push(chunk);
      if (final) files.push({ fileName: file.name, contents: decodeUtf8(chunks) });
    };
    file.start();
  };

  try {
    for (let offset = 0; offset < zipBuffer.length; offset += PUSH_CHUNK_BYTES) {
      const end = Math.min(offset + PUSH_CHUNK_BYTES, zipBuffer.length);
      unzip.push(zipBuffer.subarray(offset, end), end === zipBuffer.length);
    }
  } catch (err) {
    if (err instanceof LimitReached) throw new ArtifactRejectedError(err.message);
    throw new ArtifactRejectedError("artifact is not a valid zip archive");
  }

  return files;
}

function startsWithZipSignature(data: Uint8Array): boolean {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
  return (data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06);
}

function decodeUtf8(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
