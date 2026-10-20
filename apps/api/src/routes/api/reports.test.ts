import { describe, expect, it } from "bun:test";
import type { RepoHost } from "@flakehunter/shared-types";
import { sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { buildApiApp } from "../../../test/apiApp.js";
import { runIdentity, seedRepo } from "../../../test/fixtures.js";
import { createTestDb, type TestDb } from "../../../test/testDb.js";
import { API_VERSIONS, type ApiVersion, apiPrefix } from "../../api/version.js";
import { mintRepoToken, revokeRepoToken } from "../../auth/repoToken.js";
import type { CiSourceAdapter } from "../../ci/types.js";
import { processCiRun, WEBHOOK_REPORT_KEY } from "../../ingest/processCiRun.js";
import reportsRoute from "./reports.js";

const SHA = "a".repeat(40);

const XML = `
<testsuite name="S1">
  <testcase classname="pkg.Foo" name="passes" time="0.1" />
  <testcase classname="pkg.Foo" name="fails"><failure message="boom">stack</failure></testcase>
</testsuite>`;

function headers(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/xml",
    "x-fh-run-id": "987",
    "x-fh-sha": SHA,
    ...extra,
  };
}

async function setup(apiVersion: ApiVersion) {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const { token } = await mintRepoToken(db, repo.id);
  const app = await buildApiApp(db, [reportsRoute], apiVersion);
  return { db, close, repo, token, app };
}

async function count(db: TestDb, table: string) {
  const { rows } = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return (rows[0] as { n: number }).n;
}

describe.each([...API_VERSIONS])("POST /reports (v%d)", (apiVersion) => {
  const api = apiPrefix(apiVersion);

  it("creates a run and returns 201 with counts", async () => {
    const { db, close, token, app } = await setup(apiVersion);
    try {
      const res = await app.inject({ method: "POST", url: `${api}/reports`, headers: headers(token), payload: XML });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        duplicate: false,
        run: { ...runIdentity(apiVersion, 987), attempt: 1, headSha: SHA },
        counts: { suites: 1, tests: 2, passed: 1, failed: 1, error: 0, skipped: 0 },
      });
      expect(await count(db, "test_results")).toBe(2);
    } finally {
      await close();
    }
  });

  it("returns 200 with the original counts and no new rows on a re-upload", async () => {
    const { db, close, token, app } = await setup(apiVersion);
    try {
      const first = await app.inject({ method: "POST", url: `${api}/reports`, headers: headers(token), payload: XML });
      const second = await app.inject({ method: "POST", url: `${api}/reports`, headers: headers(token), payload: XML });

      expect(second.statusCode).toBe(200);
      expect(second.json().duplicate).toBe(true);
      expect(second.json().counts).toEqual(first.json().counts);
      expect(second.json().run.id).toBe(first.json().run.id);
      expect(await count(db, "test_results")).toBe(2);
      expect(await count(db, "workflow_runs")).toBe(1);
    } finally {
      await close();
    }
  });

  it("creates a second run for a different attempt and honours branch, workflow and report key", async () => {
    const { db, close, token, app } = await setup(apiVersion);
    try {
      await app.inject({ method: "POST", url: `${api}/reports`, headers: headers(token), payload: XML });
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, {
          "x-fh-run-attempt": "2",
          "x-fh-branch": "feature/x",
          "x-fh-workflow": "Nightly",
          "x-fh-report-key": "integration",
        }),
        payload: XML,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().run.attempt).toBe(2);
      const { rows } = await db.execute(
        sql`select workflow_name, head_branch from workflow_runs where run_attempt = 2`,
      );
      expect(rows).toEqual([{ workflow_name: "Nightly", head_branch: "feature/x" }]);
    } finally {
      await close();
    }
  });

  it("backdates the run and results when X-FH-Timestamp is given", async () => {
    const { db, close, token, app } = await setup(apiVersion);
    try {
      const when = "2026-01-15T10:30:00.000Z";
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, { "x-fh-timestamp": when }),
        payload: XML,
      });

      expect(res.statusCode).toBe(201);
      const { rows } = await db.execute(sql`
        select (select created_at from workflow_runs) as run_created,
               (select count(*)::int from test_results where created_at = ${when}::timestamptz) as stamped`);
      const row = rows[0] as { run_created: string; stamped: number };
      expect(new Date(row.run_created).toISOString()).toBe(when);
      expect(row.stamped).toBe(2);
    } finally {
      await close();
    }
  });

  it("returns 400 for a future or malformed X-FH-Timestamp and writes nothing", async () => {
    const { db, close, token, app } = await setup(apiVersion);
    try {
      for (const ts of ["2999-01-01T00:00:00Z", "yesterday", "2026-01-15"]) {
        const res = await app.inject({
          method: "POST",
          url: `${api}/reports`,
          headers: headers(token, { "x-fh-timestamp": ts }),
          payload: XML,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
        expect(res.json().error.details[0].path).toBe("headers.x-fh-timestamp");
      }
      expect(await count(db, "workflow_runs")).toBe(0);
    } finally {
      await close();
    }
  });

  it("accepts text/xml as well as application/xml", async () => {
    const { close, token, app } = await setup(apiVersion);
    try {
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, { "content-type": "text/xml" }),
        payload: XML,
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  it("returns 401 for a missing, malformed, unknown or revoked token", async () => {
    const { db, close, repo, token, app } = await setup(apiVersion);
    try {
      const { token: revoked } = await mintRepoToken(db, repo.id);
      await revokeRepoToken(db, revoked);

      const cases = [
        { ...headers(token), authorization: "" },
        { ...headers(token), authorization: token },
        headers("fh_unknown"),
        headers("some-global-api-token"),
        headers(revoked),
      ];
      for (const h of cases) {
        const { authorization, ...rest } = h;
        const res = await app.inject({
          method: "POST",
          url: `${api}/reports`,
          headers: authorization ? { ...rest, authorization } : rest,
          payload: XML,
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe("unauthorized");
      }
      expect(await count(db, "workflow_runs")).toBe(0);
    } finally {
      await close();
    }
  });

  it("checks the token before validating headers or body size", async () => {
    const { close, app } = await setup(apiVersion);
    try {
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: { authorization: "Bearer fh_unknown", "content-type": "application/xml" },
        payload: "x".repeat(11 * 1024 * 1024 + 1),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("writes to the repo the token belongs to, never to another repo", async () => {
    const { db, close, repo, token, app } = await setup(apiVersion);
    try {
      const other = await seedRepo(db, { externalRepoId: 2, name: "other" });
      const { token: otherToken } = await mintRepoToken(db, other.id);

      await app.inject({ method: "POST", url: `${api}/reports`, headers: headers(token), payload: XML });
      // Same CI run id from a different repo is not a duplicate.
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(otherToken),
        payload: XML,
      });

      expect(res.statusCode).toBe(201);
      const { rows } = await db.execute(sql`select repo_id from workflow_runs order by repo_id`);
      expect(rows).toEqual([{ repo_id: repo.id }, { repo_id: other.id }]);
    } finally {
      await close();
    }
  });

  it("returns 422 invalid_report for non-JUnit and empty bodies", async () => {
    const { db, close, token, app } = await setup(apiVersion);
    try {
      for (const payload of ["<html></html>", "garbage", "<testsuites/>"]) {
        const res = await app.inject({ method: "POST", url: `${api}/reports`, headers: headers(token), payload });
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe("invalid_report");
      }
      expect(await count(db, "workflow_runs")).toBe(0);
    } finally {
      await close();
    }
  });

  it("returns 400 validation_error for missing or malformed headers", async () => {
    const { close, token, app } = await setup(apiVersion);
    try {
      const { "x-fh-run-id": _omit, ...noRunId } = headers(token);
      const missing = await app.inject({ method: "POST", url: `${api}/reports`, headers: noRunId, payload: XML });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.code).toBe("validation_error");
      expect(missing.json().error.details[0].path).toContain("x-fh-run-id");

      const badSha = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, { "x-fh-sha": "abc123" }),
        payload: XML,
      });
      expect(badSha.statusCode).toBe(400);
      expect(badSha.json().error.details[0].path).toContain("x-fh-sha");

      const badAttempt = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, { "x-fh-run-attempt": "0" }),
        payload: XML,
      });
      expect(badAttempt.statusCode).toBe(400);
    } finally {
      await close();
    }
  });

  it("returns 400 for a sha that contradicts the existing run", async () => {
    const { close, token, app } = await setup(apiVersion);
    try {
      await app.inject({ method: "POST", url: `${api}/reports`, headers: headers(token), payload: XML });
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, { "x-fh-sha": "b".repeat(40), "x-fh-report-key": "other" }),
        payload: XML,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    } finally {
      await close();
    }
  });

  it("returns 400 for an unsupported content type", async () => {
    const { close, token, app } = await setup(apiVersion);
    try {
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, { "content-type": "application/json" }),
        payload: "{}",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    } finally {
      await close();
    }
  });

  it("returns 413 when the body is larger than 11 MB", async () => {
    const { close, token, app } = await setup(apiVersion);
    try {
      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token),
        payload: "x".repeat(11 * 1024 * 1024 + 1),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe("payload_too_large");
    } finally {
      await close();
    }
  });
});

describe.each([...API_VERSIONS])("POST /reports and the CI source (v%d)", (apiVersion) => {
  const api = apiPrefix(apiVersion);

  it("records the run under the host's own CI, so it meets a webhook delivery of the same run", async () => {
    const { db, close, repo, token, app } = await setup(apiVersion);
    try {
      const zip = zipSync({ "junit.xml": strToU8(XML) });
      const adapter = {
        ciSource: "github_actions" as const,
        hosts: new Set<RepoHost>(["github"]) as ReadonlySet<RepoHost>,
        listRunArtifacts: async () => [{ id: 1, name: "junit", sizeInBytes: zip.length, expired: false }],
        downloadArtifact: async () => zip,
      } satisfies CiSourceAdapter;
      const ciRepo = {
        id: repo.id,
        host: repo.host,
        externalRepoId: repo.externalRepoId,
        owner: repo.owner,
        name: repo.name,
      };
      await processCiRun(db, adapter, {
        repo: ciRepo,
        ciSource: "github_actions",
        runId: 987,
        attempt: 1,
        workflowName: "CI",
        headSha: SHA,
        headBranch: "main",
        status: "completed",
        conclusion: "success",
        runStartedAt: null,
        runCompletedAt: null,
        htmlUrl: null,
      });

      const res = await app.inject({
        method: "POST",
        url: `${api}/reports`,
        headers: headers(token, { "x-fh-report-key": WEBHOOK_REPORT_KEY }),
        payload: XML,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().duplicate).toBe(true);
      const { rows } = await db.execute(sql`select ci_source from workflow_runs`);
      expect(rows).toEqual([{ ci_source: "github_actions" }]);
    } finally {
      await close();
    }
  });
});

describe("POST /reports X-FH-CI-Source", () => {
  it("v2 records the named CI source and returns it with the run", async () => {
    const { db, close, token, app } = await setup(2);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v2/reports",
        headers: headers(token, { "x-fh-ci-source": "github_actions" }),
        payload: XML,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().run).toEqual({
        id: expect.any(Number),
        ciRunId: 987,
        ciSource: "github_actions",
        attempt: 1,
        headSha: SHA,
      });
      const { rows } = await db.execute(sql`select ci_source from workflow_runs`);
      expect(rows).toEqual([{ ci_source: "github_actions" }]);
    } finally {
      await close();
    }
  });

  it("v2 rejects an unknown CI source with 400 and stores nothing", async () => {
    const { db, close, token, app } = await setup(2);
    try {
      for (const value of ["jenkins", "GitHub_Actions", ""]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v2/reports",
          headers: headers(token, { "x-fh-ci-source": value }),
          payload: XML,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
      expect(await count(db, "workflow_runs")).toBe(0);
    } finally {
      await close();
    }
  });

  it("v1 ignores the header", async () => {
    const { close, token, app } = await setup(1);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reports",
        headers: headers(token, { "x-fh-ci-source": "jenkins" }),
        payload: XML,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().run).toEqual({ id: expect.any(Number), githubRunId: 987, attempt: 1, headSha: SHA });
    } finally {
      await close();
    }
  });
});
