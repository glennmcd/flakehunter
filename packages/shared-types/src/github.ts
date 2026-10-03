export interface GithubWorkflowRunEvent {
  action: string;
  workflow_run: {
    id: number;
    run_attempt: number;
    name: string;
    head_sha: string;
    head_branch: string | null;
    status: string;
    conclusion: string | null;
    run_started_at: string | null;
    updated_at: string | null;
    html_url: string;
    /** What triggered the run, e.g. "push", "pull_request", "pull_request_target". */
    event: string;
    /** The repository the run's code came from: a fork for fork pull requests; null when that fork was deleted. */
    head_repository: { id: number; full_name: string } | null;
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
}
