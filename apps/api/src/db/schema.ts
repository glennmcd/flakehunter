import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const repos = pgTable("repos", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  fullName: text("full_name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    githubRunId: bigint("github_run_id", { mode: "number" }).notNull(),
    githubRunAttempt: integer("github_run_attempt").notNull().default(1),
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
    unique().on(table.repoId, table.githubRunId, table.githubRunAttempt),
    index("idx_workflow_runs_repo_sha").on(table.repoId, table.headSha),
  ],
);

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
