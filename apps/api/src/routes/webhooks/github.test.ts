import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { seedRepo } from "../../../test/fixtures.js";
import { createTestDb } from "../../../test/testDb.js";
import { buildApp } from "../../app.js";
import { webhookEvents } from "../../db/schema.js";
import type { GithubClient } from "../../github/client.js";
import { FORK_RUN_SKIP_REASON, TRIGGER_SKIP_REASON } from "../../github/runSource.js";

const SECRET = "test-webhook-secret";
const REPO_ID = 4242;
const JUNIT = `<testsuite name="S"><testcase classname="pkg.Foo" name="bar"/></testsuite>`;

const saved = { ...process.env };
beforeAll(() => {
  process.env.API_TOKEN = "test-global-api-token";
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
});
afterAll(() => {
  process.env = saved;
});

/** A GitHub client serving one artifact; `calls` records each request's method and owner/repo. */
function fakeGithub() {
  const zip = zipSync({ "junit.xml": strToU8(JUNIT) });
  const calls: string[] = [];
  const client = {
    rest: {
      actions: {
        listWorkflowRunArtifacts: async ({ owner, repo }: { owner: string; repo: string }) => {
          calls.push(`list ${owner}/${repo}`);
          return { data: { artifacts: [{ id: 1, name: "junit", size_in_bytes: zip.length, expired: false }] } };
        },
        downloadArtifact: async ({ owner, repo }: { owner: string; repo: string }) => {
          calls.push(`download ${owner}/${repo}`);
          return { data: zip.buffer };
        },
      },
    },
  } as unknown as GithubClient;
  return { client, calls };
}

function workflowRunEvent(
  overrides: { headRepository?: { id: number; full_name: string } | null; event?: string } = {},
) {
  return {
    action: "completed",
    workflow_run: {
      id: 1001,
      run_attempt: 1,
      name: "CI",
      head_sha: "a".repeat(40),
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      run_started_at: null,
      updated_at: null,
      html_url: "https://github.com/acme/widgets/actions/runs/1001",
      event: overrides.event ?? "push",
      head_repository:
        overrides.headRepository === undefined ? { id: REPO_ID, full_name: "acme/widgets" } : overrides.headRepository,
    },
    repository: { id: REPO_ID, name: "widgets", full_name: "acme/widgets", owner: { login: "acme" } },
  };
}

async function setup(github = fakeGithub()) {
  const { db, close } = await createTestDb();
  await seedRepo(db, { githubRepoId: REPO_ID, owner: "acme", name: "widgets" });
  const app = await buildApp({ db, logger: false, github: github.client });

  let deliveries = 0;
  const deliver = (payload: unknown, opts: { deliveryId?: string; secret?: string } = {}) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", opts.secret ?? SECRET)
      .update(body)
      .digest("hex")}`;
    deliveries += 1;
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": opts.deliveryId ?? `delivery-${deliveries}`,
        "x-hub-signature-256": signature,
      },
      payload: body,
    });
  };

  const results = async () => {
    const { rows } = await db.execute(sql`select count(*)::int as n from test_results`);
    return (rows[0] as { n: number }).n;
  };
  const events = () =>
    db
      .select({ processedAt: webhookEvents.processedAt, processingError: webhookEvents.processingError })
      .from(webhookEvents);

  return { app, db, close, calls: github.calls, deliver, results, events };
}

describe("POST /webhooks/github workflow_run", () => {
  it("ingests a completed run whose code came from the repo itself", async () => {
    const t = await setup();
    try {
      const res = await t.deliver(workflowRunEvent());

      expect(res.statusCode).toBe(200);
      expect(await t.results()).toBe(1);
      const [event] = await t.events();
      expect(event?.processedAt).not.toBeNull();
      expect(event?.processingError).toBeNull();
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  it("skips a run from a fork without calling GitHub", async () => {
    const t = await setup();
    try {
      const res = await t.deliver(
        workflowRunEvent({ event: "pull_request", headRepository: { id: 999, full_name: "outsider/widgets" } }),
      );

      expect(res.statusCode).toBe(200);
      expect(t.calls).toEqual([]);
      expect(await t.results()).toBe(0);
      const [event] = await t.events();
      expect(event?.processingError).toBe(FORK_RUN_SKIP_REASON);
      expect(event?.processedAt).toBeNull();
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  it("skips a fork run started with pull_request_target too", async () => {
    const t = await setup();
    try {
      await t.deliver(
        workflowRunEvent({ event: "pull_request_target", headRepository: { id: 999, full_name: "outsider/widgets" } }),
      );

      expect(t.calls).toEqual([]);
      expect(await t.results()).toBe(0);
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  for (const trigger of ["pull_request_target", "workflow_run", "issue_comment"]) {
    it(`skips a ${trigger} run even though it ran in the repo itself`, async () => {
      const t = await setup();
      try {
        // These triggers run in the base repo, so head_repository is the repo, but they often relay fork code.
        await t.deliver(workflowRunEvent({ event: trigger }));

        expect(t.calls).toEqual([]);
        expect(await t.results()).toBe(0);
        const [event] = await t.events();
        expect(event?.processingError).toBe(TRIGGER_SKIP_REASON);
      } finally {
        await t.app.close();
        await t.close();
      }
    });
  }

  for (const trigger of ["pull_request", "merge_group", "schedule", "workflow_dispatch"]) {
    it(`ingests a same-repo ${trigger} run`, async () => {
      const t = await setup();
      try {
        await t.deliver(workflowRunEvent({ event: trigger }));
        expect(await t.results()).toBe(1);
      } finally {
        await t.app.close();
        await t.close();
      }
    });
  }

  it("stores fixed text, not the raw error, when processing fails unexpectedly", async () => {
    const github = fakeGithub();
    github.client.rest.actions.listWorkflowRunArtifacts = (async () => {
      throw new Error("connect ECONNREFUSED postgres://user:secret@db.internal");
    }) as unknown as GithubClient["rest"]["actions"]["listWorkflowRunArtifacts"];
    const t = await setup(github);
    try {
      const res = await t.deliver(workflowRunEvent());

      expect(res.statusCode).toBe(200);
      const [event] = await t.events();
      expect(event?.processingError).toBe("processing failed; see the API logs");
      expect(event?.processedAt).toBeNull();
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  it("skips a run whose head repository is gone (a deleted fork)", async () => {
    const t = await setup();
    try {
      await t.deliver(workflowRunEvent({ headRepository: null }));

      expect(t.calls).toEqual([]);
      const [event] = await t.events();
      expect(event?.processingError).toBe(FORK_RUN_SKIP_REASON);
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  it("asks GitHub for the registered repo's owner and name, not the payload's", async () => {
    const t = await setup();
    try {
      const payload = workflowRunEvent();
      payload.repository.owner.login = "someone-else";
      payload.repository.name = "other-repo";

      await t.deliver(payload);

      expect(t.calls).toEqual(["list acme/widgets", "download acme/widgets"]);
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  it("rejects a bad signature before writing anything", async () => {
    const t = await setup();
    try {
      const res = await t.deliver(workflowRunEvent(), { secret: "wrong-secret" });

      expect(res.statusCode).toBe(401);
      expect(await t.events()).toEqual([]);
      expect(t.calls).toEqual([]);
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  it("skips a redelivery of the same delivery id", async () => {
    const t = await setup();
    try {
      await t.deliver(workflowRunEvent(), { deliveryId: "same" });
      const res = await t.deliver(workflowRunEvent(), { deliveryId: "same" });

      expect(res.json<unknown>()).toEqual({ ok: true, duplicate: true });
      expect(t.calls).toEqual(["list acme/widgets", "download acme/widgets"]);
      expect(await t.results()).toBe(1);
    } finally {
      await t.app.close();
      await t.close();
    }
  });

  it("records a rejected artifact's fixed message and still answers 200", async () => {
    const github = fakeGithub();
    github.client.rest.actions.listWorkflowRunArtifacts = (async () => ({
      data: { artifacts: [{ id: 1, name: "huge", size_in_bytes: 50 * 1024 * 1024, expired: false }] },
    })) as unknown as GithubClient["rest"]["actions"]["listWorkflowRunArtifacts"];
    const t = await setup(github);
    try {
      const res = await t.deliver(workflowRunEvent());

      expect(res.statusCode).toBe(200);
      expect(t.calls).toEqual([]);
      const [event] = await t.events();
      expect(event?.processingError).toBe("artifact is larger than 10485760 bytes");
    } finally {
      await t.app.close();
      await t.close();
    }
  });
});
