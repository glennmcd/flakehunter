import { buildChart, type ChartPoint, formatDateTime, shortSha, type TestStatus } from "../lib/history";

const LABELS: Record<TestStatus, string> = { passed: "Passed", failed: "Failed", error: "Error", skipped: "Skipped" };

/** Shape as well as colour tells statuses apart: circle passed, diamond failed, triangle error, small ring skipped. */
export function Marker({ status, x, y }: { status: TestStatus; x: number; y: number }) {
  const className = `mark mark-${status}`;
  switch (status) {
    case "passed":
      return <circle className={className} cx={x} cy={y} r={4.5} />;
    case "failed":
      return <polygon className={className} points={`${x},${y - 6} ${x + 6},${y} ${x},${y + 6} ${x - 6},${y}`} />;
    case "error":
      return <polygon className={className} points={`${x},${y - 6} ${x + 6},${y + 5} ${x - 6},${y + 5}`} />;
    case "skipped":
      return <circle className={className} cx={x} cy={y} r={3.5} />;
  }
}

function pointTitle(point: ChartPoint): string {
  const flaky = point.flaky ? ", flaky commit" : "";
  return `${LABELS[point.status]} on ${shortSha(point.sha)} at ${formatDateTime(point.at)}${flaky}`;
}

/** The result timeline: time left to right, one lane per status, flaky commits ringed. Server-rendered SVG. */
export function HistoryChart({ items, total }: { items: Parameters<typeof buildChart>[0]; total: number }) {
  const chart = buildChart(items);
  if (chart.points.length === 0) return null;

  const counts = chart.lanes.map((lane) => `${lane.count} ${lane.status}`).join(", ");
  const flakyCommits = new Set(chart.points.filter((point) => point.flaky).map((point) => point.sha)).size;
  const label = `Timeline of ${chart.points.length} results: ${counts}. ${flakyCommits} flaky ${
    flakyCommits === 1 ? "commit" : "commits"
  }.`;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={label}>
        <title>{label}</title>
        {chart.lanes.map((lane) => (
          <g key={lane.status}>
            <line className="lane" x1={chart.plot.left} x2={chart.plot.right} y1={lane.y} y2={lane.y} />
            <text className="lane-label" x={chart.plot.left - 10} y={lane.y} textAnchor="end" dominantBaseline="middle">
              {LABELS[lane.status]}
            </text>
          </g>
        ))}
        {chart.ticks.map((tick) => (
          <text
            key={`${tick.x}-${tick.label}`}
            className="tick"
            x={tick.x}
            y={chart.plot.bottom + 26}
            textAnchor="middle"
          >
            {tick.label}
          </text>
        ))}
        {chart.points
          .filter((point) => point.flaky)
          .map((point) => (
            <circle key={`ring-${point.resultId}`} className="flaky-ring" cx={point.x} cy={point.y} r={10} />
          ))}
        {chart.points.map((point) => (
          <g key={point.resultId}>
            <title>{pointTitle(point)}</title>
            <Marker status={point.status} x={point.x} y={point.y} />
          </g>
        ))}
      </svg>
      <figcaption>
        <ul className="legend">
          {chart.lanes.map((lane) => (
            <li key={lane.status}>
              <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
                <Marker status={lane.status} x={0} y={0} />
              </svg>{" "}
              {LABELS[lane.status]}
            </li>
          ))}
          <li>
            <svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true">
              <circle className="flaky-ring" cx={0} cy={0} r={9} />
            </svg>{" "}
            Flaky commit (passed and failed)
          </li>
        </ul>
        {total > chart.points.length ? (
          <p className="hint">
            Showing the newest {chart.points.length} of {total} results in this window.
          </p>
        ) : null}
      </figcaption>
    </figure>
  );
}
