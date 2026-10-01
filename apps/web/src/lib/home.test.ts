import { describe, expect, it } from "bun:test";
import { ApiClientError } from "./api";
import { decideHome } from "./home";

const repo = (id: number, fullName: string) => ({ id, fullName, owner: fullName.split("/")[0] ?? "", name: fullName });

function client(data: ReturnType<typeof repo>[], total = data.length) {
  return { listRepos: async () => ({ data, page: { limit: 100, offset: 0, total } }) };
}

describe("decideHome", () => {
  it("redirects when there is exactly one repository", async () => {
    expect(await decideHome(client([repo(3, "o/r")]), false)).toEqual({ kind: "redirect", repoId: 3 });
  });

  it("lists the single repository when asked to show all", async () => {
    const result = await decideHome(client([repo(3, "o/r")]), true);
    expect(result).toMatchObject({ kind: "list", total: 1 });
  });

  it("lists several repositories, and an empty set", async () => {
    expect(await decideHome(client([repo(1, "a/b"), repo(2, "c/d")]), false)).toMatchObject({ kind: "list", total: 2 });
    expect(await decideHome(client([]), false)).toEqual({ kind: "list", repos: [], total: 0 });
  });

  it("reports the total even when it exceeds what was fetched", async () => {
    const result = await decideHome(client([repo(1, "a/b")], 250), false);
    expect(result).toMatchObject({ kind: "list", total: 250 });
  });

  it("turns failures into an error view instead of throwing", async () => {
    const failing = {
      listRepos: async () => {
        throw new ApiClientError("network", "Could not reach the API at http://internal:3000", 0);
      },
    };
    const result = await decideHome(failing, false);
    expect(result.kind).toBe("error");
    expect(JSON.stringify(result)).not.toContain("internal:3000");
  });
});
