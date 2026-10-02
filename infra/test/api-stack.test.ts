import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match, Template } from "aws-cdk-lib/assertions";
import { type ApiStackProps, SECRET_NAMES } from "../lib/api-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const infraRoot = path.join(here, "..");
const ACCOUNT = "123456789012";
const REGION = "us-east-2";

// Every stack these tests need is synthesized in one Node process (see synth-worker.ts for why not in Bun); the
// assertions below then run against the resulting CloudFormation templates.
const SCENARIOS: Record<string, ApiStackProps> = {
  defaults: {},
  custom: { parameterPrefix: "/fh/prod/", uploadRateLimit: { max: 5, windowSeconds: 10 } },
  concurrency: { reservedConcurrency: 5 },
  throttle: { throttle: { rateLimit: 5, burstLimit: 10 } },
  budget: { alertEmail: "me@example.com", monthlyBudgetUsd: 25 },
  budgetDefault: { alertEmail: "me@example.com" },
  badPrefixNoLeadingSlash: { parameterPrefix: "flakehunter/demo/" },
  badPrefixNoTrailingSlash: { parameterPrefix: "/flakehunter/demo" },
};

interface Scenario {
  template: Template;
  warnings: string[];
  error?: string;
}

function synthAll(): Record<string, Scenario> {
  const run = Bun.spawnSync(["node", "--import", "tsx", "test/synth-worker.ts", JSON.stringify(SCENARIOS)], {
    cwd: infraRoot,
    env: { ...process.env },
  });
  const stdout = run.stdout.toString();
  const marker = stdout.lastIndexOf("@@RESULT@@");
  if (run.exitCode !== 0 || marker < 0) {
    throw new Error(`synth-worker failed (exit ${run.exitCode}): ${run.stderr.toString() || stdout}`);
  }
  const parsed = JSON.parse(stdout.slice(marker + "@@RESULT@@".length)) as Record<
    string,
    { template?: object; warnings: string[]; error?: string }
  >;
  return Object.fromEntries(
    Object.entries(parsed).map(([name, result]) => [
      name,
      {
        template: result.template ? Template.fromJSON(result.template) : (undefined as unknown as Template),
        warnings: result.warnings,
        error: result.error,
      },
    ]),
  );
}

const scenarios = synthAll();
const scenario = (name: string) => {
  const found = scenarios[name];
  if (!found) throw new Error(`no scenario ${name}`);
  return found;
};

type Statement = { Action: string | string[]; Effect: string; Resource: unknown };
function statements(template: Template): Statement[] {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap(
    (policy) =>
      (policy as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );
}

const apiFunction = (name: string) =>
  Object.values(scenario(name).template.findResources("AWS::Lambda::Function")).find(
    (resource) => (resource as { Properties: { Runtime?: string } }).Properties.Runtime === "nodejs22.x",
  ) as { Properties: Record<string, unknown> } | undefined;

describe("ApiStack Lambda function", () => {
  it("runs the handler on Node 22 arm64 within API Gateway's time limit, with the rate limit and secret locations", () => {
    scenario("defaults").template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 1024,
      Timeout: 29,
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          SSM_PARAMETER_PREFIX: "/flakehunter/demo/",
          RATE_LIMIT_TABLE: { Ref: Match.stringLikeRegexp("RateLimitTable") },
          UPLOAD_RATE_LIMIT_MAX: "120",
          UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "60",
        }),
      },
    });
  });

  it("passes the upload rate limit and parameter prefix through", () => {
    scenario("custom").template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          SSM_PARAMETER_PREFIX: "/fh/prod/",
          UPLOAD_RATE_LIMIT_MAX: "5",
          UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "10",
        }),
      },
    });
  });

  it("does not reserve concurrency unless asked (a new account cannot spare it), and does when asked", () => {
    expect(apiFunction("defaults")?.Properties).not.toHaveProperty("ReservedConcurrentExecutions");
    expect(apiFunction("concurrency")?.Properties).toMatchObject({ ReservedConcurrentExecutions: 5 });
  });

  it("keeps its logs for two weeks", () => {
    scenario("defaults").template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
  });

  it("rejects a parameter prefix that is not an absolute path ending in a slash", () => {
    expect(scenario("badPrefixNoLeadingSlash").error).toContain("parameterPrefix");
    expect(scenario("badPrefixNoTrailingSlash").error).toContain("parameterPrefix");
  });
});

describe("ApiStack rate limit table", () => {
  it("is on-demand, keyed on pk, and expires counters through the expiresAt TTL attribute", () => {
    scenario("defaults").template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });
});

describe("ApiStack HTTP API", () => {
  it("is an HTTP API whose $default route goes to the Lambda with payload format 2.0", () => {
    const { template } = scenario("defaults");
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP", Name: "flakehunter-api" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$default" });
  });

  it("uses the $default stage (no path prefix), throttles it and writes JSON access logs", () => {
    scenario("defaults").template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      AccessLogSettings: Match.objectLike({
        DestinationArn: Match.anyValue(),
        Format: Match.stringLikeRegexp("requestId"),
      }),
    });
  });

  it("takes throttle settings from props", () => {
    scenario("throttle").template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
    });
  });

  it("has no CORS configuration, because the browser never calls it", () => {
    const api = Object.values(scenario("defaults").template.findResources("AWS::ApiGatewayV2::Api"))[0];
    expect(api?.Properties).not.toHaveProperty("CorsConfiguration");
  });

  it("outputs the API URL for the dashboard's API_BASE_URL", () => {
    scenario("defaults").template.hasOutput("ApiUrl", { Value: Match.anyValue() });
  });
});

describe("ApiStack permissions", () => {
  it("lets the Lambda read exactly the four secrets, not the whole prefix", () => {
    const ssm = statements(scenario("defaults").template).filter((s) =>
      [s.Action].flat().includes("ssm:GetParameters"),
    );
    expect(ssm).toHaveLength(1);
    // The partition is a CloudFormation token, so compare the serialized form.
    const resources = [ssm[0]?.Resource].flat().map((resource) => JSON.stringify(resource));
    expect(resources).toHaveLength(SECRET_NAMES.length);
    for (const name of SECRET_NAMES) {
      const expected = `:ssm:${REGION}:${ACCOUNT}:parameter/flakehunter/demo/${name}"`;
      expect(resources.some((r) => r.includes(expected))).toBe(true);
    }
    for (const resource of resources) expect(resource).not.toContain("*");
  });

  it("lets the Lambda only update items in the rate limit table", () => {
    const dynamo = statements(scenario("defaults").template).filter((s) =>
      [s.Action].flat().some((a) => a.startsWith("dynamodb:")),
    );
    expect(dynamo).toHaveLength(1);
    expect(dynamo[0]?.Action).toBe("dynamodb:UpdateItem");
    expect(JSON.stringify(dynamo[0]?.Resource)).toContain("RateLimitTable");
  });

  it("grants no wildcard resource", () => {
    const wildcard = statements(scenario("defaults").template).filter((s) => JSON.stringify(s.Resource) === '"*"');
    expect(wildcard).toEqual([]);
  });
});

describe("ApiStack cost budget", () => {
  it("creates an account budget that emails at 80% actual and 100% forecast spend", () => {
    scenario("budget").template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 25, Unit: "USD" } }),
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 80 }),
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "me@example.com" }],
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "FORECASTED", Threshold: 100 }),
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "me@example.com" }],
        }),
      ],
    });
  });

  it("defaults to 10 USD", () => {
    scenario("budgetDefault").template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: "USD" } }),
    });
  });

  it("creates no budget without an email, and warns so it is not forgotten", () => {
    const { template, warnings } = scenario("defaults");
    template.resourceCountIs("AWS::Budgets::Budget", 0);
    expect(warnings.some((w) => w.includes("alertEmail"))).toBe(true);
    expect(scenario("budget").warnings.some((w) => w.includes("alertEmail"))).toBe(false);
  });
});

describe("secret names", () => {
  it("match the ones the Lambda reads from SSM", () => {
    const source = readFileSync(path.join(here, "../../apps/api/src/lambda/secrets.ts"), "utf8");
    const declared = /SECRET_NAMES = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    const names = [...declared.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([...SECRET_NAMES]);
  });
});
