import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dir, "load-aws-secret.sh").replaceAll("\\", "/");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake `aws` first on PATH: it records its arguments and prints `output` (or fails with `error`). */
function fakeAws(opts: { output?: string; error?: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "load-aws-"));
  dirs.push(dir);
  const log = path.join(dir, "args.txt").replaceAll("\\", "/");
  const stub = [
    "#!/bin/sh",
    `printf '%s\n' "$*" > '${log}'`,
    opts.error !== undefined ? `echo '${opts.error}' >&2; exit 254` : `printf '%s\n' '${opts.output ?? ""}'`,
  ].join("\n");
  const file = path.join(dir, "aws");
  writeFileSync(file, `${stub}\n`);
  chmodSync(file, 0o755);
  return { dir: dir.replaceAll("\\", "/"), args: () => readFileSync(log, "utf8").trim() };
}

function load(args: string, aws: { dir: string }, env: Record<string, string> = {}) {
  const PATH = `${aws.dir}${path.delimiter === ";" ? ":" : path.delimiter}${process.env.PATH ?? ""}`;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template
  const probe = 'printf "%s" "${TARGET-<unset>}"';
  const result = Bun.spawnSync(["bash", "-c", `. '${script}' ${args}; status=$?; printf '|%s|' "$status"; ${probe}`], {
    env: { PATH, ...env },
  });
  const [status, ...rest] = result.stdout.toString().slice(1).split("|");
  return { status: Number(status), value: rest.join("|"), stderr: result.stderr.toString() };
}

describe("load-aws-secret.sh", () => {
  it("reads the decrypted SSM parameter and exports it", () => {
    const aws = fakeAws({ output: "s3cr3t-value" });
    expect(load("TARGET", aws)).toMatchObject({ status: 0, value: "s3cr3t-value", stderr: "" });
    expect(aws.args()).toBe(
      "ssm get-parameter --name /flakehunter/demo/TARGET --with-decryption --query Parameter.Value --output text --profile g26work --region us-east-2",
    );
  });

  it("honours the profile, region and prefix overrides", () => {
    const aws = fakeAws({ output: "v" });
    const env = { FH_AWS_PROFILE: "other", FH_AWS_REGION: "eu-west-1", FH_SSM_PREFIX: "/app/prod/" };
    expect(load("TARGET", aws, env).value).toBe("v");
    expect(aws.args()).toContain("--name /app/prod/TARGET");
    expect(aws.args()).toContain("--profile other --region eu-west-1");
  });

  it("fails with a hint, and leaves the variable unset, when the CLI fails", () => {
    const aws = fakeAws({ error: "Token has expired" });
    const result = load("TARGET", aws);
    expect(result).toMatchObject({ status: 1, value: "<unset>" });
    expect(result.stderr).toContain("could not read /flakehunter/demo/TARGET");
  });

  it("fails when the parameter is empty or None", () => {
    expect(load("TARGET", fakeAws({ output: "" }))).toMatchObject({ status: 1, value: "<unset>" });
    expect(load("TARGET", fakeAws({ output: "None" }))).toMatchObject({ status: 1, value: "<unset>" });
  });

  it("rejects invalid names and prefixes without calling aws", () => {
    for (const bad of ["''", "1ABC", "A-B", "'A;B'"]) {
      const aws = fakeAws({ output: "v" });
      expect(load(bad, aws).status).toBe(1);
      expect(() => aws.args()).toThrow();
    }
    expect(load("TARGET", fakeAws({ output: "v" }), { FH_SSM_PREFIX: "no-slashes" }).status).toBe(1);
  });

  it("does not leave helper variables behind", () => {
    const aws = fakeAws({ output: "v" });
    const PATH = `${aws.dir}:${process.env.PATH ?? ""}`;
    const probe =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template
      '. "$0" TARGET; printf "%s" "${_fh_value-gone}"; type _fh_load_aws_secret >/dev/null 2>&1 && printf fn || printf nofn';
    const result = Bun.spawnSync(["bash", "-c", probe, script], { env: { PATH } });
    expect(result.stdout.toString()).toBe("gonenofn");
  });

  it("fails with a message that says to source it when run directly", () => {
    const result = Bun.spawnSync(["bash", script, "TARGET"], { env: { PATH: process.env.PATH ?? "" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("must be sourced");
  });
});
