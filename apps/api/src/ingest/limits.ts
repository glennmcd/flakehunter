/** Largest JUnit XML accepted, decompressed: one upload body, or all XML files in one artifact together. */
export const MAX_REPORT_BYTES = 11 * 1024 * 1024;

/**
 * Largest artifact zip downloaded from GitHub (compressed size). The size GitHub lists is checked before downloading;
 * the downloaded body is checked again, but only after it has been buffered.
 */
export const MAX_ARTIFACT_ZIP_BYTES = 10 * 1024 * 1024;

/** Most entries (files and directories) read from one artifact zip. */
export const MAX_ZIP_ENTRIES = 1000;

/**
 * An artifact that is refused for its size or shape. The message is fixed text, safe to store in
 * webhook_events.processing_error.
 */
export class ArtifactRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRejectedError";
  }
}
