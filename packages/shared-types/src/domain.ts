export type TestResultStatus = "passed" | "failed" | "error" | "skipped";

/** Where a repository's code lives; with the host's own repository id, it identifies the repository. */
export const REPO_HOSTS = ["github"] as const;
export type RepoHost = (typeof REPO_HOSTS)[number];

/** The system that ran a workflow and holds its artifacts. One repository's runs can come from several. */
export const CI_SOURCES = ["github_actions"] as const;
export type CiSource = (typeof CI_SOURCES)[number];

/** The CI source assumed for a repository's runs when the caller does not name one. */
export const DEFAULT_CI_SOURCE: Readonly<Record<RepoHost, CiSource>> = { github: "github_actions" };

export interface Repo {
  id: number;
  host: RepoHost;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  createdAt: string;
}

export interface WorkflowRun {
  id: number;
  repoId: number;
  ciSource: CiSource;
  githubRunId: number;
  githubRunAttempt: number;
  workflowName: string;
  headSha: string;
  headBranch: string | null;
  status: string;
  conclusion: string | null;
  runStartedAt: string | null;
  runCompletedAt: string | null;
  htmlUrl: string | null;
}

export interface TestCase {
  id: number;
  repoId: number;
  classname: string;
  name: string;
}

export interface TestResult {
  id: number;
  testCaseId: number;
  suiteId: number;
  runId: number;
  repoId: number;
  headSha: string;
  occurrenceIndex: number;
  status: TestResultStatus;
  durationSeconds: number | null;
  failureMessage: string | null;
  failureStack: string | null;
}

export interface FlakyTest {
  repoId: number;
  testCaseId: number;
  classname: string;
  name: string;
  headSha: string;
  passCount: number;
  failCount: number;
  lastSeenAt: string;
}
