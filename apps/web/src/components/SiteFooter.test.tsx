import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteFooter } from "./SiteFooter";

describe("SiteFooter", () => {
  it("shows the version and the short commit", () => {
    const html = renderToStaticMarkup(<SiteFooter version="0.0.1" commit="a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" />);
    expect(html).toContain('<footer class="site-footer">');
    expect(html).toContain("v0.0.1 · a1b2c3d");
  });

  it("shows only the version when the commit is unknown", () => {
    const html = renderToStaticMarkup(<SiteFooter version="0.0.1" />);
    expect(html).toContain(">v0.0.1<");
    expect(html).not.toContain("·");
  });

  it("renders nothing when there is no version", () => {
    expect(renderToStaticMarkup(<SiteFooter commit="a1b2c3d" />)).toBe("");
    expect(renderToStaticMarkup(<SiteFooter version="" />)).toBe("");
  });

  it("escapes and ignores anything that is not a version or a hash", () => {
    const html = renderToStaticMarkup(<SiteFooter version="<b>1</b>" commit="<script>x</script>" />);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;1&lt;/b&gt;");
  });
});
