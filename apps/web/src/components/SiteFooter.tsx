import { formatVersion } from "../lib/version";

/** The version line at the foot of every page. Renders nothing when the version is unknown. */
export function SiteFooter({ version, commit }: { version?: string; commit?: string }) {
  const label = formatVersion(version, commit);
  if (!label) return null;
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <span className="app-version">{label}</span>
      </div>
    </footer>
  );
}
