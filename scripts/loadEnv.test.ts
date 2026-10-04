import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dir, "load-env.sh").replaceAll("\\", "/");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "load-env-"));
  dirs.push(dir);
  const file = path.join(dir, ".env").replaceAll("\\", "/");
  writeFileSync(file, contents);
  return file;
}

/** Sources the script in a fresh bash, then prints the variable and the exit status of the source. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template
function load(args: string, extra = 'printf "%s" "${TARGET-<unset>}"') {
  const result = Bun.spawnSync(["bash", "-c", `. '${script}' ${args}; status=$?; printf '|%s|' "$status"; ${extra}`], {
    env: { PATH: process.env.PATH ?? "" },
  });
  const out = result.stdout.toString();
  const [status, ...rest] = out.slice(1).split("|");
  return { status: Number(status), value: rest.join("|"), stderr: result.stderr.toString() };
}

describe("load-env.sh", () => {
  it("exports the value into the calling shell", () => {
    const file = envFile("OTHER=x\nTARGET=abc123\n");
    expect(load(`TARGET '${file}'`)).toMatchObject({ status: 0, value: "abc123", stderr: "" });
  });

  it("makes the variable visible to child processes", () => {
    const file = envFile("TARGET=abc123\n");
    expect(load(`TARGET '${file}'`, 'bash -c \'printf "%s" "$TARGET"\'').value).toBe("abc123");
  });

  it("keeps = signs inside the value and takes the last definition", () => {
    const file = envFile("TARGET=first\nTARGET=postgres://u:p@h/db?sslmode=require\n");
    expect(load(`TARGET '${file}'`).value).toBe("postgres://u:p@h/db?sslmode=require");
  });

  it("strips matching quotes, `export`, carriage returns and trailing comments", () => {
    expect(load(`TARGET '${envFile('TARGET="a b"\n')}'`).value).toBe("a b");
    expect(load(`TARGET '${envFile("TARGET='a b'\n")}'`).value).toBe("a b");
    expect(load(`TARGET '${envFile("export TARGET=abc\r\n")}'`).value).toBe("abc");
    expect(load(`TARGET '${envFile("TARGET=abc # note\n")}'`).value).toBe("abc");
  });

  it("does not execute the file or expand its values", () => {
    const file = envFile("TARGET=$(echo pwned)\nOTHER=`echo pwned`\n");
    expect(load(`TARGET '${file}'`).value).toBe("$(echo pwned)");
  });

  it("matches the exact name, not a prefix or a suffix", () => {
    const file = envFile("TARGET_EXTRA=no\nMY_TARGET=no\n");
    expect(load(`TARGET '${file}'`)).toMatchObject({ status: 1, value: "<unset>" });
  });

  it("fails without leaking the value when the name is missing from the file", () => {
    const result = load(`TARGET '${envFile("OTHER=super-secret\n")}'`);
    expect(result).toMatchObject({ status: 1, value: "<unset>" });
    expect(result.stderr).toContain("TARGET is not set");
    expect(result.stderr).not.toContain("super-secret");
  });

  it("fails for an unreadable file and for invalid names", () => {
    expect(load("TARGET /nonexistent/.env").status).toBe(1);
    for (const bad of ["''", "1ABC", "A-B", "'A;B'"]) {
      expect(load(`${bad} '${envFile("A=1\n")}'`).status).toBe(1);
    }
  });

  it("leaves no helper variables or functions behind", () => {
    const file = envFile("TARGET=abc\n");
    const { value } = load(
      `TARGET '${file}'`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template
      'printf "%s" "${_fh_value-gone}"; type _fh_load_env >/dev/null 2>&1 && printf "fn" || printf "nofn"',
    );
    expect(value).toBe("gonenofn");
  });
});

describe("load-env.sh run instead of sourced", () => {
  it("fails with a message that says to source it", () => {
    const file = envFile("TARGET=abc\n");
    const result = Bun.spawnSync(["bash", script, "TARGET", file], { env: { PATH: process.env.PATH ?? "" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("must be sourced");
  });
});
