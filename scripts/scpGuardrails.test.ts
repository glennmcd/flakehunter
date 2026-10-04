import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const apply = path.join(import.meta.dir, "scp-apply-guardrails.sh").replaceAll("\\", "/");
const rollback = path.join(import.meta.dir, "scp-rollback-guardrails.sh").replaceAll("\\", "/");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const freezeRollback = path.join(import.meta.dir, "scp-rollback-freeze.sh").replaceAll("\\", "/");
const MUTATING = /(create|update|attach|detach|delete)-policy|delete-function-concurrency/;
const policyFile = readFileSync(path.join(import.meta.dir, "../infra/scp/flakehunter-guardrails.json"), "utf8");

/**
 * A fake `aws` first on PATH. It logs every call on one line and answers from FAKE_* variables:
 * FAKE_ACCOUNT (the management account) and FAKE_APP_ACCOUNT (the flakehunter account, for profile "flakehunter"),
 * FAKE_POLICY_ID (id of an existing policy, default none), FAKE_ATTACHED (ids attached to the target, space
 * separated), FAKE_CURRENT (the policy text AWS holds), FAKE_FUNCTION (the stack's FunctionName output),
 * FAKE_CONCURRENCY (the function's reserved concurrency, "None" when unset) and FAKE_FAIL (a "<service> <command>"
 * that fails).
 */
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "scp-"));
  dirs.push(dir);
  const log = path.join(dir, "calls.txt").replaceAll("\\", "/");
  const stub = [
    "#!/bin/sh",
    `{ printf '%s' "$*" | tr '\\n' ' '; echo; } >> '${log}'`,
    '[ "$1" = "--profile" ] && { PROFILE=$2; shift 2; }',
    '[ "$1" = "--region" ] && shift 2',
    'if [ "$1 $2" = "$FAKE_FAIL" ]; then echo "fake failure" >&2; exit 254; fi',
    'case "$1 $2" in',
    // The flakehunter profile is the application account; any other profile is the management account.
    '  "sts get-caller-identity") if [ "$PROFILE" = flakehunter ]; then echo "$FAKE_APP_ACCOUNT"; else echo "$FAKE_ACCOUNT"; fi ;;',
    '  "cloudformation describe-stacks") echo "$FAKE_FUNCTION" ;;',
    '  "lambda get-function-concurrency") echo "$FAKE_CONCURRENCY" ;;',
    '  "lambda delete-function-concurrency") ;;',
    '  "organizations list-policies") echo "$FAKE_POLICY_ID" ;;',
    // Like `--output text`, the real CLI separates a list with tabs, not spaces.
    '  "organizations list-policies-for-target") echo "$FAKE_ATTACHED" | tr " " "\\t" ;;',
    '  "organizations describe-policy") echo "$FAKE_CURRENT" ;;',
    '  "organizations create-policy") echo "p-created" ;;',
    '  "organizations "*) ;;',
    '  *) echo "unexpected: $*" >&2; exit 2 ;;',
    "esac",
  ].join("\n");
  const file = path.join(dir, "aws");
  writeFileSync(file, `${stub}\n`);
  chmodSync(file, 0o755);
  const bin = dir.replaceAll("\\", "/");

  // A null value removes a variable, to test a script that is run without it.
  const run = (script: string, args: string[], env: Record<string, string | null> = {}) => {
    const PATH = `${bin}${path.delimiter === ";" ? ":" : path.delimiter}${process.env.PATH ?? ""}`;
    // The scripts require these two account ids from the environment; they have no defaults.
    const defaults = {
      FH_MGMT_ACCOUNT_ID: "111111111111",
      FH_SCP_TARGET_ID: "222222222222",
      FAKE_ACCOUNT: "111111111111",
      FAKE_APP_ACCOUNT: "222222222222",
      FAKE_POLICY_ID: "None",
      FAKE_ATTACHED: "",
      FAKE_CURRENT: "{}",
      FAKE_FUNCTION: "api-fn-123",
      FAKE_CONCURRENCY: "None",
    };
    const merged: Record<string, string | null> = { PATH, FAKE_LOG: log, ...defaults, ...env };
    const spawnEnv = Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null),
    );
    const result = Bun.spawnSync(["bash", script, ...args], { env: spawnEnv });
    let calls: string[] = [];
    try {
      calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {
      // the script never called aws
    }
    return {
      status: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      calls,
      changes: calls.filter((c) => MUTATING.test(c)),
    };
  };
  return { run };
}

describe("scp-apply-guardrails.sh", () => {
  it("creates the policy from the file and attaches it to the flakehunter account", () => {
    const { run } = setup();
    const result = run(apply, ["--yes"]);

    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe("--profile flakehunter-mgmt sts get-caller-identity --query Account --output text");
    const [create, attach] = result.changes;
    expect(create).toContain("organizations create-policy --type SERVICE_CONTROL_POLICY --name FlakeHunterGuardrails");
    expect(create).toContain('"Sid": "DenyOutsideUsEast2"'); // the policy text from infra/scp, passed as --content
    expect(attach).toContain("organizations attach-policy --policy-id p-created --target-id 222222222222");
    expect(result.changes).toHaveLength(2);
    expect(result.stdout).toContain("Created FlakeHunterGuardrails (p-created)");
  });

  it("updates an existing policy from the file and attaches it when it is not attached", () => {
    const { run } = setup();
    const result = run(apply, ["--yes"], { FAKE_POLICY_ID: "p-existing", FAKE_ATTACHED: "p-FullAWSAccess" });

    expect(result.status).toBe(0);
    expect(result.changes[0]).toContain("organizations update-policy --policy-id p-existing --content");
    expect(result.changes[1]).toContain("organizations attach-policy --policy-id p-existing --target-id 222222222222");
    expect(result.changes.some((c) => c.includes("create-policy"))).toBe(false);
  });

  it("updates but does not re-attach when the text differs and the policy is already attached", () => {
    const { run } = setup();
    const result = run(apply, ["--yes"], { FAKE_POLICY_ID: "p-existing", FAKE_ATTACHED: "p-other p-existing" });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("update-policy");
    expect(result.stdout).toContain("differs");
    expect(result.stdout).toContain("already attached");
  });

  it("does nothing, and does not even ask, when the text matches and the policy is attached", () => {
    const { run } = setup();
    // No --yes and no terminal: it must stop before the confirmation because there is nothing to confirm.
    const result = run(apply, [], {
      FAKE_POLICY_ID: "p-existing",
      FAKE_ATTACHED: "p-other p-existing",
      FAKE_CURRENT: policyFile,
    });

    expect(result.status).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.stdout).toContain("no update needed");
    expect(result.stdout).toContain("Nothing to do.");
  });

  it("only attaches when the text matches but the policy is not attached", () => {
    const { run } = setup();
    const result = run(apply, ["--yes"], {
      FAKE_POLICY_ID: "p-existing",
      FAKE_ATTACHED: "p-other",
      FAKE_CURRENT: policyFile,
    });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("attach-policy --policy-id p-existing");
  });

  it("ignores formatting: the same policy minified is not a change", () => {
    const { run } = setup();
    const minified = JSON.stringify(JSON.parse(policyFile));
    const result = run(apply, ["--yes"], {
      FAKE_POLICY_ID: "p-existing",
      FAKE_ATTACHED: "p-existing",
      FAKE_CURRENT: minified,
    });

    expect(result.status).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.stdout).toContain("Nothing to do.");
  });

  it("treats a real difference in the text as a change", () => {
    const { run } = setup();
    const edited = policyFile.replace("us-east-2", "us-west-2");
    const result = run(apply, ["--yes"], {
      FAKE_POLICY_ID: "p-existing",
      FAKE_ATTACHED: "p-existing",
      FAKE_CURRENT: edited,
    });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("update-policy --policy-id p-existing");
  });

  it("with --dry-run does not plan an update when the text matches", () => {
    const { run } = setup();
    const result = run(apply, ["--dry-run"], {
      FAKE_POLICY_ID: "p-existing",
      FAKE_ATTACHED: "p-other",
      FAKE_CURRENT: policyFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("update-policy");
    expect(result.stdout).toContain("[dry-run] would run: aws organizations attach-policy");
  });

  it("refuses, and changes nothing, when the profile is not the management account", () => {
    const { run } = setup();
    const result = run(apply, ["--yes"], { FAKE_ACCOUNT: "222222222222" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the management account 111111111111");
    expect(result.calls).toHaveLength(1); // only the identity check
  });

  it("refuses when the account already has the maximum number of SCPs attached", () => {
    const { run } = setup();
    const result = run(apply, ["--yes"], { FAKE_ATTACHED: "p-1 p-2 p-3 p-4 p-5" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already has 5 SCPs attached");
    expect(result.changes).toEqual([]);
  });

  it("reports a failed AWS call and changes nothing when the sign-in has expired", () => {
    const { run } = setup();
    const result = run(apply, ["--yes"], { FAKE_FAIL: "sts get-caller-identity" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("aws login --profile flakehunter-mgmt");
    expect(result.changes).toEqual([]);
  });

  it("with --dry-run reads from AWS, prints the plan and changes nothing", () => {
    const { run } = setup();
    const result = run(apply, ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.stdout).toContain("[dry-run] would run: aws organizations create-policy");
    expect(result.stdout).toContain("[dry-run] would run: aws organizations attach-policy");
  });

  it("will not change anything without --yes when there is no terminal to ask on", () => {
    const { run } = setup();
    const result = run(apply, []);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(result.changes).toEqual([]);
  });

  it("honours the profile, region, target and policy file overrides", () => {
    const { run } = setup();
    const file = path.join(dirs[0] as string, "policy.json").replaceAll("\\", "/");
    writeFileSync(file, '{"Version":"2012-10-17","Statement":[]}');
    const result = run(apply, ["--yes"], {
      FH_MGMT_PROFILE: "other",
      FH_MGMT_REGION: "us-east-1",
      FH_MGMT_ACCOUNT_ID: "111111111111",
      FAKE_ACCOUNT: "111111111111",
      FH_SCP_TARGET_ID: "999999999999",
      FH_SCP_NAME: "Other",
      FH_SCP_FILE: file,
    });

    expect(result.status).toBe(0);
    expect(result.calls[0]).toStartWith("--profile other --region us-east-1 sts get-caller-identity");
    expect(result.changes[0]).toContain("--name Other");
    expect(result.changes[0]).toContain('{"Version":"2012-10-17","Statement":[]}');
    expect(result.changes[1]).toContain("--target-id 999999999999");
  });

  it("fails clearly on a missing policy file and on an unknown argument", () => {
    const { run } = setup();
    expect(run(apply, ["--yes"], { FH_SCP_FILE: "/nonexistent/policy.json" })).toMatchObject({
      status: 1,
      calls: [],
    });
    const unknown = run(apply, ["--force"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown argument: --force");
    expect(unknown.calls).toEqual([]);
  });
});

describe("scp-rollback-guardrails.sh", () => {
  it("detaches the policy but keeps it", () => {
    const { run } = setup();
    const result = run(rollback, ["--yes"], { FAKE_POLICY_ID: "p-existing", FAKE_ATTACHED: "p-other p-existing" });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("organizations detach-policy --policy-id p-existing --target-id 222222222222");
    expect(result.stdout).toContain("Detached p-existing");
  });

  it("with --delete also deletes the policy, after detaching it", () => {
    const { run } = setup();
    const result = run(rollback, ["--yes", "--delete"], { FAKE_POLICY_ID: "p-existing", FAKE_ATTACHED: "p-existing" });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toContain("detach-policy");
    expect(result.changes[1]).toContain("organizations delete-policy --policy-id p-existing");
  });

  it("is not an error when the policy does not exist", () => {
    const { run } = setup();
    const result = run(rollback, ["--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to roll back");
    expect(result.changes).toEqual([]);
  });

  it("is not an error when the policy exists but is not attached", () => {
    const { run } = setup();
    const result = run(rollback, ["--yes"], { FAKE_POLICY_ID: "p-existing", FAKE_ATTACHED: "p-other" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("is not attached");
    expect(result.changes).toEqual([]);
  });

  it("with --delete still deletes a policy that is already detached", () => {
    const { run } = setup();
    const result = run(rollback, ["--yes", "--delete"], { FAKE_POLICY_ID: "p-existing", FAKE_ATTACHED: "" });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("delete-policy --policy-id p-existing");
  });

  it("refuses, and changes nothing, when the profile is not the management account", () => {
    const { run } = setup();
    const result = run(rollback, ["--yes"], { FAKE_ACCOUNT: "222222222222", FAKE_POLICY_ID: "p-existing" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the management account");
    expect(result.calls).toHaveLength(1);
  });

  it("with --dry-run prints the plan and changes nothing", () => {
    const { run } = setup();
    const result = run(rollback, ["--dry-run", "--delete"], {
      FAKE_POLICY_ID: "p-existing",
      FAKE_ATTACHED: "p-existing",
    });

    expect(result.status).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.stdout).toContain("[dry-run] would run: aws organizations detach-policy");
    expect(result.stdout).toContain("[dry-run] would run: aws organizations delete-policy");
  });

  it("will not change anything without --yes when there is no terminal to ask on", () => {
    const { run } = setup();
    const result = run(rollback, [], { FAKE_POLICY_ID: "p-existing", FAKE_ATTACHED: "p-existing" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(result.changes).toEqual([]);
  });

  it("rejects an unknown argument before calling AWS", () => {
    const { run } = setup();
    const result = run(rollback, ["--purge"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown argument: --purge");
    expect(result.calls).toEqual([]);
  });
});

describe("scp-rollback-freeze.sh", () => {
  const frozen = { FAKE_POLICY_ID: "p-freeze", FAKE_ATTACHED: "p-other p-freeze", FAKE_CONCURRENCY: "0" };

  it("detaches the freeze SCP, then removes the concurrency limit, each with its own account's profile", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes"], frozen);

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toBe(
      "--profile flakehunter-mgmt organizations detach-policy --policy-id p-freeze --target-id 222222222222",
    );
    expect(result.changes[1]).toBe(
      "--profile flakehunter --region us-east-2 lambda delete-function-concurrency --function-name api-fn-123",
    );
    // It looked up the freeze policy by name, and the function by the stack's output.
    expect(result.calls.some((c) => c.includes("Name=='FlakeHunterBudgetFreeze'"))).toBe(true);
    expect(result.calls.some((c) => c.includes("describe-stacks --stack-name FlakeHunterApi"))).toBe(true);
    expect(result.stdout).toContain("the API serves requests again");
  });

  it("leaves a concurrency cap you set yourself alone", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes"], { ...frozen, FAKE_CONCURRENCY: "5" });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("detach-policy");
    expect(result.stdout).toContain("limited to 5, not 0");
  });

  it("only removes the concurrency limit when the SCP is not attached", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes"], { ...frozen, FAKE_ATTACHED: "p-other" });

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("delete-function-concurrency");
    expect(result.stdout).toContain("is not attached");
  });

  it("is not an error, and does not ask, when there is nothing to roll back", () => {
    const { run } = setup();
    const result = run(freezeRollback, []); // no --yes and no terminal: it must stop before the question

    expect(result.status).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.stdout).toContain("does not exist");
    expect(result.stdout).toContain("not stopped");
    expect(result.stdout).toContain("Nothing to roll back.");
  });

  it("--scp-only never touches the flakehunter account", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes", "--scp-only"], frozen);

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("detach-policy");
    expect(result.calls.some((c) => c.startsWith("--profile flakehunter --region"))).toBe(false);
  });

  it("--concurrency-only never touches the management account", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes", "--concurrency-only"], frozen);

    expect(result.status).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("delete-function-concurrency");
    expect(result.calls.some((c) => c.startsWith("--profile flakehunter-mgmt"))).toBe(false);
  });

  it("rejects both scope flags together, and unknown arguments, before calling AWS", () => {
    const { run } = setup();
    const both = run(freezeRollback, ["--scp-only", "--concurrency-only"]);
    expect(both).toMatchObject({ status: 1, calls: [] });
    expect(both.stderr).toContain("cannot be used together");

    const unknown = run(freezeRollback, ["--force"]);
    expect(unknown).toMatchObject({ status: 1, calls: [] });
    expect(unknown.stderr).toContain("unknown argument: --force");
  });

  it("changes nothing in either account when the flakehunter profile is the wrong account", () => {
    const { run } = setup();
    // The SCP part would go ahead on its own, but every check runs before any change.
    const result = run(freezeRollback, ["--yes"], { ...frozen, FAKE_APP_ACCOUNT: "999999999999" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the flakehunter account 222222222222");
    expect(result.changes).toEqual([]);
  });

  it("changes nothing when the management profile is the wrong account", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes"], { ...frozen, FAKE_ACCOUNT: "222222222222" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the management account");
    expect(result.changes).toEqual([]);
  });

  it("stops when the stack has no FunctionName output, instead of guessing a function", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes"], { ...frozen, FAKE_FUNCTION: "None" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no FunctionName output");
    expect(result.changes).toEqual([]);
  });

  it("stops, and changes nothing, when a read from AWS fails", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--yes"], { ...frozen, FAKE_FAIL: "lambda get-function-concurrency" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not read the concurrency");
    expect(result.changes).toEqual([]);
  });

  it("with --dry-run prints the plan for both accounts and changes nothing", () => {
    const { run } = setup();
    const result = run(freezeRollback, ["--dry-run"], frozen);

    expect(result.status).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.stdout).toContain("[dry-run] would run: aws organizations detach-policy");
    expect(result.stdout).toContain("[dry-run] would run: aws lambda delete-function-concurrency");
  });

  it("will not change anything without --yes when there is no terminal to ask on", () => {
    const { run } = setup();
    const result = run(freezeRollback, [], frozen);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(result.changes).toEqual([]);
  });
});

describe("required account ids", () => {
  const scripts = [
    ["scp-apply-guardrails.sh", apply, ["--yes"]],
    ["scp-rollback-guardrails.sh", rollback, ["--yes"]],
    ["scp-rollback-freeze.sh", freezeRollback, ["--yes"]],
  ] as const;

  for (const [name, script, args] of scripts) {
    it(`${name} stops, naming the variable, before calling AWS when FH_MGMT_ACCOUNT_ID is not set`, () => {
      const { run } = setup();
      const result = run(script, [...args], { FH_MGMT_ACCOUNT_ID: null });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FH_MGMT_ACCOUNT_ID is not set");
      expect(result.calls).toEqual([]);
    });

    it(`${name} stops, naming the variable, before calling AWS when FH_SCP_TARGET_ID is not set`, () => {
      const { run } = setup();
      const result = run(script, [...args], { FH_SCP_TARGET_ID: null });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FH_SCP_TARGET_ID is not set");
      expect(result.calls).toEqual([]);
    });

    it(`${name} rejects an id that is not exactly 12 digits`, () => {
      const { run } = setup();
      for (const bad of ["12345678901", "1234567890123", "12345678901a", "<management-account-id>"]) {
        const result = run(script, [...args], { FH_MGMT_ACCOUNT_ID: bad });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("FH_MGMT_ACCOUNT_ID must be exactly 12 digits");
        expect(result.calls).toEqual([]);
      }
      const target = run(script, [...args], { FH_SCP_TARGET_ID: "not-an-id" });
      expect(target.stderr).toContain("FH_SCP_TARGET_ID must be exactly 12 digits");
      expect(target.calls).toEqual([]);
    });
  }

  it("the freeze rollback checks the flakehunter account against FH_SCP_TARGET_ID unless FH_APP_ACCOUNT_ID is set", () => {
    const { run } = setup();
    const frozen = { FAKE_POLICY_ID: "p-freeze", FAKE_ATTACHED: "p-freeze", FAKE_CONCURRENCY: "0" };

    // The default is the target account, so a profile in a different account is refused...
    const wrong = run(freezeRollback, ["--yes"], { ...frozen, FAKE_APP_ACCOUNT: "333333333333" });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("not the flakehunter account 222222222222");
    expect(wrong.changes).toEqual([]);

    // ...and FH_APP_ACCOUNT_ID overrides it.
    const overridden = run(freezeRollback, ["--yes"], {
      ...frozen,
      FAKE_APP_ACCOUNT: "333333333333",
      FH_APP_ACCOUNT_ID: "333333333333",
    });
    expect(overridden.status).toBe(0);
    expect(overridden.changes).toHaveLength(2);
  });

  it("the account ids are not stored in the scripts themselves", () => {
    for (const file of [
      "scp-common.sh",
      "scp-apply-guardrails.sh",
      "scp-rollback-guardrails.sh",
      "scp-rollback-freeze.sh",
    ]) {
      expect(readFileSync(path.join(import.meta.dir, file), "utf8")).not.toMatch(/\b\d{12}\b/);
    }
  });
});
