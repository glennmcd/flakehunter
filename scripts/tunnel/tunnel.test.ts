import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractTunnelUrl, webhookUrl } from "./extractTunnelUrl.js";
import { runTunnel } from "./runTunnel.js";

describe("extractTunnelUrl", () => {
  it("finds the quick tunnel URL in cloudflared's boxed log output", () => {
    const log = [
      "2026-10-01T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment.",
      "2026-10-01T10:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-10-01T10:00:02Z INF +--------------------------------------------------------------------------------------------+",
      "2026-10-01T10:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "2026-10-01T10:00:02Z INF |  https://random-words-here-1234.trycloudflare.com                                          |",
      "2026-10-01T10:00:02Z INF +--------------------------------------------------------------------------------------------+",
    ].join("\n");
    expect(extractTunnelUrl(log)).toBe("https://random-words-here-1234.trycloudflare.com");
  });

  it("returns null when there is no tunnel URL yet", () => {
    expect(extractTunnelUrl("")).toBeNull();
    expect(extractTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
  });

  it("ignores the api.trycloudflare.com endpoint that appears in error messages", () => {
    const err =
      'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup failed';
    expect(extractTunnelUrl(err)).toBeNull();
    expect(extractTunnelUrl(`${err}\nINF | https://real-name.trycloudflare.com |`)).toBe(
      "https://real-name.trycloudflare.com",
    );
  });

  it("is case-insensitive and returns a lowercase URL", () => {
    expect(extractTunnelUrl("| HTTPS://Mixed-Case.TryCloudflare.com |")).toBe("https://mixed-case.trycloudflare.com");
  });
});

describe("webhookUrl", () => {
  it("appends /webhooks/github, without doubling a trailing slash", () => {
    expect(webhookUrl("https://a-b.trycloudflare.com")).toBe("https://a-b.trycloudflare.com/webhooks/github");
    expect(webhookUrl("https://a-b.trycloudflare.com/")).toBe("https://a-b.trycloudflare.com/webhooks/github");
  });
});

describe("runTunnel", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "flakehunter-tunnel-test-"));
    dirs.push(dir);
    const out: string[] = [];
    const err: string[] = [];
    return {
      file: path.join(dir, "webhook-url.txt"),
      out,
      err,
      sinks: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    };
  }

  // Stands in for cloudflared, which logs to stderr.
  const fake = (script: string) => ["bun", "-e", script];

  it("writes the webhook URL to the file while passing stdout and stderr through unchanged", async () => {
    const { file, out, err, sinks } = setup();
    const script = `
      console.error("INF Requesting new quick Tunnel on trycloudflare.com...");
      console.error("INF |  https://quiet-river-9876.trycloudflare.com  |");
      console.log("some stdout line");
      await Bun.sleep(300);
    `;

    let seenWhileRunning: string | null = null;
    const exitCode = await runTunnel({
      cmd: fake(script),
      file,
      ...sinks,
      onUrl: () => {
        seenWhileRunning = readFileSync(file, "utf8");
      },
    });

    expect(exitCode).toBe(0);
    // The file is there while the process is still running, not only after it exits.
    expect(seenWhileRunning).toBe("https://quiet-river-9876.trycloudflare.com/webhooks/github");
    expect(readFileSync(file, "utf8")).toBe("https://quiet-river-9876.trycloudflare.com/webhooks/github");
    // Output is passed through verbatim, on the stream it came from.
    expect(err.join("")).toContain("INF Requesting new quick Tunnel on trycloudflare.com...");
    expect(err.join("")).toContain("INF |  https://quiet-river-9876.trycloudflare.com  |");
    expect(out.join("")).toContain("some stdout line");
    expect(out.join("")).not.toContain("trycloudflare");
  });

  it("overwrites an existing file", async () => {
    const { file, sinks } = setup();
    writeFileSync(file, "https://old-tunnel.trycloudflare.com/webhooks/github\nleftover text that must go");

    const script = `console.error("| https://new-tunnel.trycloudflare.com |"); await Bun.sleep(100);`;
    await runTunnel({ cmd: fake(script), file, ...sinks });

    expect(readFileSync(file, "utf8")).toBe("https://new-tunnel.trycloudflare.com/webhooks/github");
  });

  it("leaves the file in place after the process exits", async () => {
    const { file, sinks } = setup();
    const script = `console.error("| https://short-lived.trycloudflare.com |"); await Bun.sleep(100);`;
    await runTunnel({ cmd: fake(script), file, ...sinks });
    expect(readFileSync(file, "utf8")).toBe("https://short-lived.trycloudflare.com/webhooks/github");
  });

  it("finds a URL that is split across output chunks", async () => {
    const { file, sinks } = setup();
    const script = `
      process.stderr.write("INF |  https://split-na");
      await Bun.sleep(100);
      process.stderr.write("me-5555.trycloudflare.com  |\\n");
      await Bun.sleep(200);
    `;
    await runTunnel({ cmd: fake(script), file, ...sinks });
    expect(readFileSync(file, "utf8")).toBe("https://split-name-5555.trycloudflare.com/webhooks/github");
  });

  it("only records the first URL it sees", async () => {
    const { file, sinks } = setup();
    const script = `
      console.error("| https://first-one.trycloudflare.com |");
      await Bun.sleep(100);
      console.error("| https://second-one.trycloudflare.com |");
      await Bun.sleep(100);
    `;
    await runTunnel({ cmd: fake(script), file, ...sinks });
    expect(readFileSync(file, "utf8")).toBe("https://first-one.trycloudflare.com/webhooks/github");
  });

  it("returns the child's exit code and does not create or touch the file if no URL appeared", async () => {
    const { file, err, sinks } = setup();
    const exitCode = await runTunnel({
      cmd: fake(`console.error("ERR could not start"); process.exit(3);`),
      file,
      ...sinks,
    });
    expect(exitCode).toBe(3);
    expect(existsSync(file)).toBe(false);
    expect(err.join("")).toContain("ERR could not start");
  });
});
