import type { GithubWorkflowRunEvent } from "@flakehunter/shared-types";
import type { CiRunInput } from "../../ingest/processCiRun.js";
import type { CiRepo } from "../types.js";

/** Maps a completed `workflow_run` webhook to a run to ingest. The repo is the registered row, never the payload's. */
export function workflowRunToInput(event: GithubWorkflowRunEvent, repo: CiRepo): CiRunInput {
  const run = event.workflow_run;
  return {
    repo,
    ciSource: "github_actions",
    runId: run.id,
    attempt: run.run_attempt,
    workflowName: run.name,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    runStartedAt: run.run_started_at,
    runCompletedAt: run.updated_at,
    htmlUrl: run.html_url,
  };
}
