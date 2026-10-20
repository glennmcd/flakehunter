import { CI_SOURCES, REPO_HOSTS } from "@flakehunter/shared-types";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const repos = pgTable(
  "repos",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    host: text("host", { enum: REPO_HOSTS }).notNull(),
    // The host's own id for the repository.
    externalRepoId: bigint("external_repo_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("repos_host_check", sql`${table.host} IN ('github')`),
    unique().on(table.host, table.externalRepoId),
    unique().on(table.host, table.fullName),
  ],
);

export const githubInstallations = pgTable("github_installations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  installationId: bigint("installation_id", { mode: "number" }).unique(),
  accountLogin: text("account_login").notNull(),
  webhookSecret: text("webhook_secret").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookEvents = pgTable("webhook_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  deliveryId: text("delivery_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processingError: text("processing_error"),
});

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id),
    ciSource: text("ci_source", { enum: CI_SOURCES }).notNull(),
    // The CI system's own run id and attempt.
    ciRunId: bigint("ci_run_id", { mode: "number" }).notNull(),
    runAttempt: integer("run_attempt").notNull().default(1),
    workflowName: text("workflow_name").notNull(),
    headSha: text("head_sha").notNull(),
    headBranch: text("head_branch"),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }),
    runCompletedAt: timestamp("run_completed_at", { withTimezone: true }),
    htmlUrl: text("html_url"),
    artifactsFetchedAt: timestamp("artifacts_fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("workflow_runs_ci_source_check", sql`${table.ciSource} IN ('github_actions')`),
    // Runs from different CI systems can share an id and attempt, so the CI source is part of the key.
    unique("workflow_runs_run_key_unique").on(table.repoId, table.ciSource, table.ciRunId, table.runAttempt),
    index("idx_workflow_runs_repo_sha").on(table.repoId, table.headSha),
  ],
);

/** Idempotency record for uploads: one row per (run, report key); a repeat insert means a duplicate upload. */
export const reports = pgTable(
  "reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    reportKey: text("report_key").notNull().default("default"),
    suiteCount: integer("suite_count").notNull().default(0),
    testCount: integer("test_count").notNull().default(0),
    passedCount: integer("passed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.runId, table.reportKey)],
);

export const repoApiTokens = pgTable("repo_api_tokens", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  repoId: bigint("repo_id", { mode: "number" })
    .notNull()
    .references(() => repos.id),
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const testSuites = pgTable(
  "test_suites",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    jobName: text("job_name"),
    suiteName: text("suite_name").notNull(),
    fileName: text("file_name"),
    tests: integer("tests"),
    failures: integer("failures"),
    errors: integer("errors"),
    skipped: integer("skipped"),
    timeSeconds: numeric("time_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_test_suites_run").on(table.runId)],
);

export const testCases = pgTable(
  "test_cases",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id),
    classname: text("classname").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.repoId, table.classname, table.name)],
);

export const testResults = pgTable(
  "test_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    testCaseId: bigint("test_case_id", { mode: "number" })
      .notNull()
      .references(() => testCases.id),
    suiteId: bigint("suite_id", { mode: "number" })
      .notNull()
      .references(() => testSuites.id, { onDelete: "cascade" }),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id),
    headSha: text("head_sha").notNull(),
    occurrenceIndex: integer("occurrence_index").notNull().default(0),
    status: text("status").notNull(),
    durationSeconds: numeric("duration_seconds"),
    failureMessage: text("failure_message"),
    failureStack: text("failure_stack"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("test_results_status_check", sql`${table.status} IN ('passed','failed','error','skipped')`),
    index("idx_test_results_flaky_lookup").on(table.repoId, table.testCaseId, table.headSha, table.status),
    index("idx_test_results_run").on(table.runId),
  ],
);

/**
 * Read-only view created by migration 0001_flaky_tests_view.sql (Drizzle doesn't manage views
 * via generated migrations). `.existing()` tells drizzle-kit not to try to create/alter it.
 */
export const flakyTests = pgView("flaky_tests", {
  repoId: bigint("repo_id", { mode: "number" }).notNull(),
  testCaseId: bigint("test_case_id", { mode: "number" }).notNull(),
  classname: text("classname").notNull(),
  name: text("name").notNull(),
  headSha: text("head_sha").notNull(),
  passCount: bigint("pass_count", { mode: "number" }).notNull(),
  failCount: bigint("fail_count", { mode: "number" }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
}).existing();
