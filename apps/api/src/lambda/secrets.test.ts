import { describe, expect, it } from "bun:test";
import type { GetParametersCommand } from "@aws-sdk/client-ssm";
import { loadSecrets, SECRET_NAMES, type SsmLike } from "./secrets";

function fakeSsm(values: Record<string, string | undefined>, invalid: string[] = []) {
  const calls: { Names?: string[]; WithDecryption?: boolean }[] = [];
  const client: SsmLike = {
    async send(command: GetParametersCommand) {
      calls.push(command.input);
      const names = command.input.Names ?? [];
      return {
        Parameters: names
          .filter((name) => name in values && !invalid.includes(name))
          .map((name) => ({ Name: name, Value: values[name] })),
        InvalidParameters: names.filter((name) => invalid.includes(name) || !(name in values)),
      };
    },
  };
  return { client, calls };
}

const ALL = Object.fromEntries(SECRET_NAMES.map((name) => [`/fh/demo/${name}`, `value-of-${name}`]));

describe("loadSecrets", () => {
  it("reads every secret under the prefix with decryption and returns them by name", async () => {
    const { client, calls } = fakeSsm(ALL);
    const secrets = await loadSecrets(client, "/fh/demo/");
    expect(secrets).toEqual({
      DATABASE_URL: "value-of-DATABASE_URL",
      API_TOKEN: "value-of-API_TOKEN",
      GITHUB_PAT: "value-of-GITHUB_PAT",
      GITHUB_WEBHOOK_SECRET: "value-of-GITHUB_WEBHOOK_SECRET",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.WithDecryption).toBe(true);
    expect(calls[0]?.Names).toEqual(SECRET_NAMES.map((name) => `/fh/demo/${name}`));
  });

  it("accepts a prefix without a trailing slash", async () => {
    const { client, calls } = fakeSsm(ALL);
    await loadSecrets(client, "/fh/demo");
    expect(calls[0]?.Names?.[0]).toBe("/fh/demo/DATABASE_URL");
  });

  it("rejects a prefix that is not an absolute parameter path", async () => {
    const { client } = fakeSsm(ALL);
    await expect(loadSecrets(client, "fh/demo/")).rejects.toThrow('must start with "/"');
  });

  it("names the missing parameters and never prints a value", async () => {
    const { client } = fakeSsm({ ...ALL, "/fh/demo/API_TOKEN": undefined }, ["/fh/demo/GITHUB_PAT"]);
    const error = await loadSecrets(client, "/fh/demo/").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("/fh/demo/GITHUB_PAT (not found)");
    expect(message).toContain("/fh/demo/API_TOKEN (empty)");
    expect(message).not.toContain("value-of-");
  });

  it("fails when a requested name is silently absent from the response", async () => {
    const client: SsmLike = { send: async () => ({ Parameters: [], InvalidParameters: [] }) };
    await expect(loadSecrets(client, "/fh/", ["DATABASE_URL"])).rejects.toThrow("/fh/DATABASE_URL (not returned)");
  });

  it("splits more than ten names across calls", async () => {
    const names = Array.from({ length: 23 }, (_, i) => `SECRET_${i}`);
    const values = Object.fromEntries(names.map((name) => [`/fh/${name}`, name]));
    const { client, calls } = fakeSsm(values);
    const secrets = await loadSecrets(client, "/fh/", names);
    expect(calls.map((call) => call.Names?.length)).toEqual([10, 10, 3]);
    expect(Object.keys(secrets)).toHaveLength(23);
  });
});
