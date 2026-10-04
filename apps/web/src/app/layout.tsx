import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SiteFooter } from "../components/SiteFooter";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlakeHunter",
  description: "Find and rank flaky tests from your CI runs",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link className="wordmark" href="/">
              FlakeHunter
            </Link>
          </div>
        </header>
        {children}
        <SiteFooter version={process.env.APP_VERSION} commit={process.env.APP_COMMIT} />
      </body>
    </html>
  );
}
