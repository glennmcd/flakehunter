import { unzipSync } from "fflate";

export interface ExtractedXmlFile {
  fileName: string;
  contents: string;
}

export function extractXmlFiles(zipBuffer: Uint8Array): ExtractedXmlFile[] {
  const entries = unzipSync(zipBuffer);
  const files: ExtractedXmlFile[] = [];
  const decoder = new TextDecoder("utf-8");

  for (const [fileName, data] of Object.entries(entries)) {
    if (fileName.toLowerCase().endsWith(".xml")) {
      files.push({ fileName, contents: decoder.decode(data) });
    }
  }

  return files;
}
