# Part 3: Dashboard and demo data

A Next.js dashboard on top of the Part 2 API, and a realistic fake CI history to show it with.

## Prompt

*Paraphrased; no prompt file was kept.* Put a real face on the API and get a public demo online: a Next.js dashboard
with an overview and a test detail page, a seed script that uploads realistic runs through the real upload endpoint,
and a recommendation for where to host it all next to Neon, with the public upload endpoint protected.

## Plan

**API additions and demo data**
- `X-FH-Timestamp` upload header, so seeded runs spread over past days instead of one instant.
- `GET /api/repos`, so the dashboard can find a repo's id.
- A deterministic demo generator (`scripts/demo/`): about 45 tests, six flaky in different ways, one broken until
  partway, re-runs on the same commit; seeding twice uploads nothing new.

**Dashboard (`apps/web`)**
- Next.js App Router and React 19. Server Components call the API with a server-only token, so the browser never
  sees a token and no CORS is needed.
- Pages: repo list, repo overview (summary and flakiest tests, with window, minimum-runs and paging filters in the
  URL), and test detail (a server-rendered SVG timeline plus a history table).
- A site-wide password gate that fails closed in production.
- Plain CSS with light and dark themes; status shown by shape as well as colour.

**Hosting** (superseded, see Outcome): the API on Fly.io, the dashboard on Vercel.

## Outcome

The API additions, demo data and dashboard were built as planned, on Next 16 rather than 15. The hosting half was
never built: Part 4 replaced Fly.io and Vercel with AWS.

## Decisions

- [0007: Host on AWS, keep the database on Neon](../decisions/0007-host-on-aws.md) (replaced this part's hosting plan)

## Full plan

[archive/part-3-plan.md](archive/part-3-plan.md), as approved.
