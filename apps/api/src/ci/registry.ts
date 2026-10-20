import type { CiSource, CiSourceAdapter } from "./types.js";

/** The CI adapters the app can use, one per CI source. */
export class CiSourceRegistry {
  private readonly adapters = new Map<CiSource, CiSourceAdapter>();

  constructor(adapters: readonly CiSourceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.ciSource)) {
        throw new Error(`more than one adapter registered for CI source ${adapter.ciSource}`);
      }
      this.adapters.set(adapter.ciSource, adapter);
    }
  }

  get(ciSource: CiSource): CiSourceAdapter {
    const adapter = this.adapters.get(ciSource);
    if (!adapter) throw new Error(`no adapter registered for CI source ${ciSource}`);
    return adapter;
  }
}
