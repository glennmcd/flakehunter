import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_FOLDER } from "./migrator.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("MIGRATIONS_FOLDER", () => {
  it("is an absolute path to the migrations next to the source", () => {
    expect(path.isAbsolute(MIGRATIONS_FOLDER)).toBe(true);
    expect(MIGRATIONS_FOLDER).toBe(path.join(here, "migrations"));
  });

  it("contains the drizzle journal and every migration it lists", () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.length).toBeGreaterThan(0);
    for (const { tag } of journal.entries) {
      expect(existsSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`))).toBe(true);
    }
  });
});

describe("db:migrate script", () => {
  // The script used a cwd-relative folder before; run it from an unrelated directory to prove that is gone.
  function run(cwd: string, env: Record<string, string>) {
    const result = Bun.spawnSync([process.execPath, path.join(here, "migrate.ts")], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  }

  it("starts from any working directory and reports a missing DATABASE_URL", () => {
    const { code, stderr } = run(tmpdir(), {});
    expect(code).not.toBe(0);
    expect(stderr).toContain("DATABASE_URL is not set");
  });

  it("finds its migrations from another cwd: it gets as far as connecting, not as far as a missing folder", () => {
    // Nothing listens on this port, so the connection fails; a bad migrations path would fail differently.
    const { code, stderr } = run(tmpdir(), { DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" });
    expect(code).not.toBe(0);
    expect(stderr).not.toContain("Can't find meta/_journal.json");
    expect(stderr).toMatch(/ECONNREFUSED|CONNECT_TIMEOUT|connect/i);
  });
});
