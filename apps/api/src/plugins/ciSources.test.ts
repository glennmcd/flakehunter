import { afterEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { GithubActionsAdapter } from "../ci/githubActions/GithubActionsAdapter.js";
import { CiSourceRegistry } from "../ci/registry.js";
import ciSourcesPlugin from "./ciSources.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("ciSources plugin", () => {
  it("uses the registry it is given", async () => {
    const registry = new CiSourceRegistry([]);
    const app = Fastify({ logger: false });
    await app.register(ciSourcesPlugin, { registry });
    await app.ready();

    expect(app.ciSources).toBe(registry);
    await app.close();
  });

  it("builds the GitHub Actions adapter from GITHUB_PAT", async () => {
    process.env.GITHUB_PAT = "test-pat";
    const app = Fastify({ logger: false });
    await app.register(ciSourcesPlugin);
    await app.ready();

    expect(app.ciSources.get("github_actions")).toBeInstanceOf(GithubActionsAdapter);
    await app.close();
  });

  it("refuses to start without GITHUB_PAT", async () => {
    delete process.env.GITHUB_PAT;
    const app = Fastify({ logger: false });
    app.register(ciSourcesPlugin);

    // ready() boots the plugin and rejects with its error; register() alone returns the instance, not a promise.
    const err = await app.ready().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error | null)?.message).toBe("GITHUB_PAT is not set");
  });
});
