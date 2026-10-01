import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout, { metadata } from "./layout";

describe("root layout", () => {
  it("wraps children in an English html document and body", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <p>child content</p>
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<body>");
    expect(html).toContain("<header");
    expect(html).toContain("<p>child content</p>");
  });

  it("has a wordmark that links home", () => {
    const html = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
    expect(html).toContain('<a class="wordmark" href="/">FlakeHunter</a>');
  });

  it("sets the page title", () => {
    expect(metadata.title).toBe("FlakeHunter");
  });
});
