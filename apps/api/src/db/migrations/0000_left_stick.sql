CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"installation_id" bigint,
	"account_login" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_github_repo_id_unique" UNIQUE("github_repo_id"),
	CONSTRAINT "repos_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_cases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"classname" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_cases_repo_id_classname_name_unique" UNIQUE("repo_id","classname","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"test_case_id" bigint NOT NULL,
	"suite_id" bigint NOT NULL,
	"run_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"head_sha" text NOT NULL,
	"occurrence_index" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"duration_seconds" numeric,
	"failure_message" text,
	"failure_stack" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_results_status_check" CHECK ("test_results"."status" IN ('passed','failed','error','skipped'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_suites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"job_name" text,
	"suite_name" text NOT NULL,
	"file_name" text,
	"tests" integer,
	"failures" integer,
	"errors" integer,
	"skipped" integer,
	"time_seconds" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	CONSTRAINT "webhook_events_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"github_run_id" bigint NOT NULL,
	"github_run_attempt" integer DEFAULT 1 NOT NULL,
	"workflow_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"head_branch" text,
	"status" text NOT NULL,
	"conclusion" text,
	"run_started_at" timestamp with time zone,
	"run_completed_at" timestamp with time zone,
	"html_url" text,
	"artifacts_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_repo_id_github_run_id_github_run_attempt_unique" UNIQUE("repo_id","github_run_id","github_run_attempt")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_results" ADD CONSTRAINT "test_results_suite_id_test_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."test_suites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_results" ADD CONSTRAINT "test_results_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_results" ADD CONSTRAINT "test_results_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_results_flaky_lookup" ON "test_results" USING btree ("repo_id","test_case_id","head_sha","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_results_run" ON "test_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_suites_run" ON "test_suites" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_repo_sha" ON "workflow_runs" USING btree ("repo_id","head_sha");