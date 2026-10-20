import type { GithubWorkflowRunEvent } from "@flakehunter/shared-types";

/** Stored in webhook_events.processing_error for a run whose code did not come from the repo itself. */
export const FORK_RUN_SKIP_REASON = "skipped: workflow run from a fork";

/** Stored in webhook_events.processing_error for a run started by a trigger not in TRUSTED_TRIGGERS. */
export const TRIGGER_SKIP_REASON = "skipped: workflow run trigger not allowed";

/**
 * Triggers whose runs test the repo's own code. Anything else is skipped, notably `pull_request_target`,
 * `workflow_run` and `issue_comment`: those run in the base repo (so `head_repository` is the repo itself) but are
 * often used to check out or relay a fork pull request's code and artifacts.
 */
export const TRUSTED_TRIGGERS: ReadonlySet<string> = new Set([
  "push",
  "pull_request",
  "merge_group",
  "schedule",
  "workflow_dispatch",
]);

/**
 * Whether a completed workflow run's artifact can be trusted enough to ingest. Whoever writes a run's code also
 * controls the artifact it uploads, so a run from outside the repo could plant fake passes and failures on real
 * commits. Returns null to ingest, or the reason to skip. Both checks are needed: the trigger allow-list does not stop
 * a fork's `pull_request` run, and the head-repository check does not stop a base-repo run that relays fork code.
 */
export function workflowRunSkipReason(event: GithubWorkflowRunEvent): string | null {
  if (!TRUSTED_TRIGGERS.has(event.workflow_run.event)) return TRIGGER_SKIP_REASON;
  const head = event.workflow_run.head_repository;
  if (!head || head.id !== event.repository.id) return FORK_RUN_SKIP_REASON;
  return null;
}
