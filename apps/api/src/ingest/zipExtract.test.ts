import { describe, expect, it } from "bun:test";
import { strToU8, Zip, ZipDeflate, zipSync } from "fflate";
import { ArtifactRejectedError } from "./limits.js";
import { extractXmlFiles } from "./zipExtract.js";

const XML = `<testsuite name="s"><testcase classname="a" name="b"/></testsuite>`;

/**
 * Builds a zip the way streaming zippers do (actions/upload-artifact uses one): each local header has general
 * purpose bit 3 set and no sizes, which follow the data in a data descriptor instead.
 */
function streamedZip(entries: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    parts.push(chunk);
  });
  for (const [name, data] of Object.entries(entries)) {
    const file = new ZipDeflate(name);
    zip.add(file);
    file.push(data, true);
  }
  zip.end();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  // Bit 3 of the general purpose flags (local header offset 6) must be set for these tests to mean anything.
  expect((out[6] ?? 0) & 0x08).toBe(0x08);
  return out;
}

function rejection(run: () => unknown): ArtifactRejectedError {
  try {
    run();
  } catch (err) {
    if (err instanceof ArtifactRejectedError) return err;
    throw err;
  }
  throw new Error("expected an ArtifactRejectedError");
}

describe("extractXmlFiles", () => {
  it("returns the .xml entries, at any depth, and skips other files", () => {
    const zip = zipSync({
      "junit.xml": strToU8(XML),
      "nested/dir/Report.XML": strToU8(XML),
      "screenshot.png": new Uint8Array([1, 2, 3]),
      "empty.xml": new Uint8Array(0),
    });

    const files = extractXmlFiles(zip);

    expect(files.map((f) => f.fileName).sort()).toEqual(["empty.xml", "junit.xml", "nested/dir/Report.XML"]);
    expect(files.find((f) => f.fileName === "junit.xml")?.contents).toBe(XML);
    expect(files.find((f) => f.fileName === "empty.xml")?.contents).toBe("");
  });

  it("decodes multi-byte UTF-8 split across chunks", () => {
    const text = `<testsuite name="${"é".repeat(100_000)}"/>`;
    const files = extractXmlFiles(zipSync({ "r.xml": strToU8(text) }, { level: 0 }));
    expect(files[0]?.contents).toBe(text);
  });

  it("stops a decompression bomb at the limit instead of inflating all of it", () => {
    // 200 MB of zeros compresses to about 200 KB.
    const bomb = zipSync({ "bomb.xml": new Uint8Array(200 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(1024 * 1024);

    const err = rejection(() => extractXmlFiles(bomb, { maxEntries: 10, maxXmlBytes: 1024 * 1024 }));

    expect(err.message).toBe("artifact XML exceeds 1048576 bytes decompressed");
  });

  describe("archives with data descriptors (as GitHub artifacts are built)", () => {
    it("extracts XML entries larger than one read chunk", () => {
      const big = `<testsuite name="s">${'<testcase classname="a" name="b"/>'.repeat(5_000)}</testsuite>`;
      const zip = streamedZip({ "a.xml": strToU8(big), "logs/run.txt": strToU8("log"), "b.xml": strToU8(XML) });
      expect(zip.length).toBeGreaterThan(0);

      const files = extractXmlFiles(zip);

      expect(files.map((f) => [f.fileName, f.contents])).toEqual([
        ["a.xml", big],
        ["b.xml", XML],
      ]);
    });

    it("still stops a decompression bomb at the limit", () => {
      const bomb = streamedZip({ "bomb.xml": new Uint8Array(100 * 1024 * 1024) });
      expect(rejection(() => extractXmlFiles(bomb, { maxEntries: 10, maxXmlBytes: 1024 * 1024 })).message).toBe(
        "artifact XML exceeds 1048576 bytes decompressed",
      );
    });

    it("rejects a truncated archive", () => {
      const zip = streamedZip({ "a.xml": strToU8(XML.repeat(200)) });
      expect(rejection(() => extractXmlFiles(zip.subarray(0, Math.floor(zip.length / 2)))).message).toBe(
        "artifact is not a valid zip archive",
      );
    });
  });

  it("rejects an XML entry with an unsupported compression method", () => {
    const zip = zipSync({ "r.xml": strToU8(XML.repeat(50)) }).slice();
    // Compression method lives at offset 8 of the local header; 12 is bzip2, which is not registered.
    zip[8] = 12;
    expect(rejection(() => extractXmlFiles(zip)).message).toBe("artifact is not a valid zip archive");
  });

  it("counts the limit across all XML entries together", () => {
    const zip = zipSync({ "a.xml": new Uint8Array(600), "b.xml": new Uint8Array(600) });
    expect(rejection(() => extractXmlFiles(zip, { maxEntries: 10, maxXmlBytes: 1000 })).message).toContain("exceeds");
    expect(extractXmlFiles(zip, { maxEntries: 10, maxXmlBytes: 1200 })).toHaveLength(2);
  });

  it("never decompresses non-XML entries, however large", () => {
    const zip = zipSync({ "big.bin": new Uint8Array(50 * 1024 * 1024), "r.xml": strToU8(XML) });
    expect(extractXmlFiles(zip, { maxEntries: 10, maxXmlBytes: 1024 }).map((f) => f.fileName)).toEqual(["r.xml"]);
  });

  it("rejects an archive with too many entries", () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 11; i++) entries[`f${i}.txt`] = strToU8("x");
    expect(rejection(() => extractXmlFiles(zipSync(entries), { maxEntries: 10, maxXmlBytes: 1024 })).message).toBe(
      "artifact has more than 10 entries",
    );
  });

  it("rejects corrupt deflate data inside an XML entry", () => {
    const zip = zipSync({ "r.xml": strToU8(XML.repeat(50)) });
    // Corrupt the compressed bytes that follow the 30-byte local header and the 5-byte name.
    const corrupt = zip.slice();
    corrupt.fill(0xff, 35, 60);
    expect(rejection(() => extractXmlFiles(corrupt)).message).toBe("artifact is not a valid zip archive");
  });

  it("rejects data that is not a zip at all", () => {
    expect(rejection(() => extractXmlFiles(strToU8("not a zip file"))).message).toBe(
      "artifact is not a valid zip archive",
    );
    expect(rejection(() => extractXmlFiles(new Uint8Array(0))).message).toBe("artifact is not a valid zip archive");
  });

  it("accepts an empty zip", () => {
    expect(extractXmlFiles(zipSync({}))).toEqual([]);
  });
});
