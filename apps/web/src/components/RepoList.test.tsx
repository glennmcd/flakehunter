import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RepoList } from "./RepoList";

const repos = [
  { id: 3, fullName: "flakehunter-demo/storefront", owner: "flakehunter-demo", name: "storefront" },
  { id: 5, fullName: "glennmcd/<b>x</b>", owner: "glennmcd", name: "<b>x</b>" },
];

describe("RepoList", () => {
  it("links each repository to its overview", () => {
    const html = renderToStaticMarkup(<RepoList repos={repos} total={2} />);
    expect(html).toContain("<h1>Repositories</h1>");
    expect(html).toContain('href="/repos/3"');
    expect(html).toContain("storefront");
    expect(html).toContain("flakehunter-demo");
    expect(html).not.toContain("Showing the first");
  });

  it("escapes names", () => {
    const html = renderToStaticMarkup(<RepoList repos={repos} total={2} />);
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("says when the list is cut short", () => {
    expect(renderToStaticMarkup(<RepoList repos={repos} total={250} />)).toContain("first 2 of 250");
  });

  it("explains an empty list and says how to fix it", () => {
    const html = renderToStaticMarkup(<RepoList repos={[]} total={0} />);
    expect(html).not.toContain("<ul");
    expect(html).toContain("No repositories are registered yet");
    expect(html).toContain("seed-dev-repo.ts");
  });
});
