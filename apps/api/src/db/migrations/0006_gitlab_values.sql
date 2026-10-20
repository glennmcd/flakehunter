ALTER TABLE "repos" DROP CONSTRAINT "repos_host_check";--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_ci_source_check";--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_host_check" CHECK ("repos"."host" IN ('github','gitlab'));--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_ci_source_check" CHECK ("workflow_runs"."ci_source" IN ('github_actions','gitlab_ci'));