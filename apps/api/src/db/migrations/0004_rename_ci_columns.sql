-- Hand-written: RENAME keeps the data and only changes the catalog. The run key's name (workflow_runs_run_key_unique)
-- does not mention the columns, so only the repo key needs renaming.
ALTER TABLE "repos" RENAME COLUMN "github_repo_id" TO "external_repo_id";--> statement-breakpoint
ALTER TABLE "repos" RENAME CONSTRAINT "repos_host_github_repo_id_unique" TO "repos_host_external_repo_id_unique";--> statement-breakpoint
ALTER TABLE "workflow_runs" RENAME COLUMN "github_run_id" TO "ci_run_id";--> statement-breakpoint
ALTER TABLE "workflow_runs" RENAME COLUMN "github_run_attempt" TO "run_attempt";
