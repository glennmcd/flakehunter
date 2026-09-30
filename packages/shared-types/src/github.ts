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
