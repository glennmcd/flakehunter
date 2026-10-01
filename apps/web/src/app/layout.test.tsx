import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout, { metadata } from "./layout";
import Home from "./page";

describe("root layout", () => {
  it("wraps children in an English html document and body", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <p>child content</p>
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<body>");
    expect(html).toContain("<p>child content</p>");
  });

  it("sets the page title", () => {
    expect(metadata.title).toBe("FlakeHunter");
  });
});

describe("home page", () => {
  it("renders the product name as the main heading", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("<main");
    expect(html).toContain("<h1>FlakeHunter</h1>");
  });
});
