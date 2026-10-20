import { describe, expect, it } from "bun:test";
import type { GithubWorkflowRunEvent } from "@flakehunter/shared-types";
import type { CiRepo } from "../types.js";
import { workflowRunToInput } from "./workflowRun.js";

const REPO: CiRepo = { id: 9, host: "github", externalRepoId: 4242, owner: "acme", name: "widgets" };

const EVENT: GithubWorkflowRunEvent = {
  action: "completed",
  workflow_run: {
    id: 1001,
    run_attempt: 2,
    name: "CI",
    head_sha: "a".repeat(40),
    head_branch: "main",
    status: "completed",
    conclusion: "failure",
    run_started_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:05:00Z",
    html_url: "https://github.com/acme/widgets/actions/runs/1001",
    event: "push",
    head_repository: { id: 4242, full_name: "acme/widgets" },
  },
  repository: { id: 4242, name: "other-repo", full_name: "someone-else/other-repo", owner: { login: "someone-else" } },
};

describe("workflowRunToInput", () => {
  it("maps a workflow_run to a github_actions run of the registered repo", () => {
    expect(workflowRunToInput(EVENT, REPO)).toEqual({
      repo: REPO,
      ciSource: "github_actions",
      runId: 1001,
      attempt: 2,
      workflowName: "CI",
      headSha: "a".repeat(40),
      headBranch: "main",
      status: "completed",
      conclusion: "failure",
      runStartedAt: "2026-10-01T10:00:00Z",
      runCompletedAt: "2026-10-01T10:05:00Z",
      htmlUrl: "https://github.com/acme/widgets/actions/runs/1001",
    });
  });
});
