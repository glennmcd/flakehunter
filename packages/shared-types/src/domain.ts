export type TestResultStatus = "passed" | "failed" | "error" | "skipped";

export interface Repo {
  id: number;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  createdAt: string;
}

export interface WorkflowRun {
  id: number;
  repoId: number;
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
