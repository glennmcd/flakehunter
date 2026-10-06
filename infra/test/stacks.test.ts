import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match, Template } from "aws-cdk-lib/assertions";
import { type ApiStackProps, DEFAULT_THROTTLE, SECRET_NAMES } from "../lib/api-stack.js";
import { ENV_SAFE_SECRET_PATTERN } from "../lib/web-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const infraRoot = path.join(here, "..");
const ACCOUNT = "123456789012";
const REGION = "us-east-2";

// Every stack these tests need is synthesized in one Node process (see synth-worker.ts for why not in Bun); the
// assertions below then run against the resulting CloudFormation templates.
const api = (props: ApiStackProps) => ({ stack: "api", props });
const web = (props: object) => ({ stack: "web", props });
const SCENARIOS: Record<string, { stack: string; props: object }> = {
  defaults: api({}),
  custom: api({ parameterPrefix: "/fh/prod/", uploadRateLimit: { max: 5, windowSeconds: 10 } }),
  concurrency: api({ reservedConcurrency: 5 }),
  throttle: api({ throttle: { rateLimit: 5, burstLimit: 10 } }),
  badThrottleZero: api({ throttle: { rateLimit: 0, burstLimit: 10 } }),
  badThrottleFraction: api({ throttle: { rateLimit: 5, burstLimit: 7.5 } }),
  budget: api({ alertEmail: "me@example.com", monthlyBudgetUsd: 25 }),
  budgetDefault: api({ alertEmail: "me@example.com" }),
  badPrefixNoLeadingSlash: api({ parameterPrefix: "flakehunter/demo/" }),
  badPrefixNoTrailingSlash: api({ parameterPrefix: "/flakehunter/demo" }),
  webDefaults: web({}),
  webConnected: web({
    repository: "https://github.com/glennmcd/flakehunter",
    githubTokenSecretName: "flakehunter/github-token",
  }),
  webDomain: web({ customDomain: { domainName: "example.com", subDomains: ["", "www", "app.dev"] } }),
  webDomainBranch: web({ branch: "release", customDomain: { domainName: "example.com", subDomains: ["www"] } }),
  badDomainName: web({ customDomain: { domainName: "Example.com", subDomains: [""] } }),
  badDomainNoSubDomains: web({ customDomain: { domainName: "example.com", subDomains: [] } }),
  badDomainPrefix: web({ customDomain: { domainName: "example.com", subDomains: ["-www"] } }),
  badDomainDuplicate: web({ customDomain: { domainName: "example.com", subDomains: ["www", "www"] } }),
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
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
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

  it("keeps the default throttle low, since it is the hard cap on what a flood can cost", () => {
    expect(DEFAULT_THROTTLE).toEqual({ rateLimit: 10, burstLimit: 20 });
  });

  it("rejects a throttle that is not a positive whole number, naming the field", () => {
    expect(scenario("badThrottleZero").error).toContain("throttle.rateLimit");
    expect(scenario("badThrottleFraction").error).toContain("throttle.burstLimit");
  });

  it("has no CORS configuration, because the browser never calls it", () => {
    const api = Object.values(scenario("defaults").template.findResources("AWS::ApiGatewayV2::Api"))[0];
    expect(api?.Properties).not.toHaveProperty("CorsConfiguration");
  });

  it("outputs the API URL for the dashboard's API_BASE_URL, and the function name for aws lambda commands", () => {
    scenario("defaults").template.hasOutput("ApiUrl", { Value: Match.anyValue() });
    scenario("defaults").template.hasOutput("FunctionName", { Value: Match.anyValue() });
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
  it("creates an account budget that emails at 80% actual and 100% forecast spend, and stops the API at 100% actual", () => {
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
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 100 }),
          Subscribers: [
            { SubscriptionType: "EMAIL", Address: "me@example.com" },
            { SubscriptionType: "SNS", Address: { Ref: Match.stringLikeRegexp("BudgetStopTopic") } },
          ],
        }),
      ],
    });
  });

  it("has no fixed name, so a replacement cannot collide with the budget it replaces", () => {
    const budget = Object.values(scenario("budget").template.findResources("AWS::Budgets::Budget"))[0] as {
      Properties: { Budget: Record<string, unknown> };
    };
    expect(budget.Properties.Budget).not.toHaveProperty("BudgetName");
  });

  it("defaults to 30 USD", () => {
    scenario("budgetDefault").template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 30, Unit: "USD" } }),
    });
  });

  it("grants publish on the stop topic to AWS Budgets in this account, and to no other principal", () => {
    scenario("budget").template.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sns:Publish",
            Effect: "Allow",
            Principal: { Service: "budgets.amazonaws.com" },
            Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT }, ArnLike: Match.anyValue() },
          }),
        ],
      },
    });
    // The ARN carries the partition as a token, so check its rendered pieces rather than one string.
    const policy = Object.values(scenario("budget").template.findResources("AWS::SNS::TopicPolicy"))[0];
    const arn = JSON.stringify(policy).match(/budgets::.*?\*/)?.[0];
    expect(arn).toContain(ACCOUNT);
  });

  it("gives the stop function permission to set concurrency on the API function only", () => {
    const { template } = scenario("budget");
    const policies = Object.values(template.findResources("AWS::IAM::Policy")) as {
      Properties: {
        PolicyName: string;
        PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] };
      };
    }[];
    const stop = policies.find((p) => p.Properties.PolicyName.includes("BudgetStopFunction"));
    expect(stop).toBeDefined();
    const statements = (stop?.Properties.PolicyDocument.Statement ?? []).filter(
      (s) => s.Action === "lambda:PutFunctionConcurrency",
    );
    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0]?.Resource)).toContain("ApiFunction");
    expect(JSON.stringify(statements[0]?.Resource)).not.toContain('"*"');
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { FUNCTION_NAME: { Ref: Match.stringLikeRegexp("^ApiFunction") } } },
      Handler: "index.handler",
    });
  });

  it("creates no budget without an email, and warns so it is not forgotten", () => {
    const { template, warnings } = scenario("defaults");
    template.resourceCountIs("AWS::Budgets::Budget", 0);
    template.resourceCountIs("AWS::SNS::Topic", 0);
    expect(warnings.some((w) => w.includes("alertEmail"))).toBe(true);
    expect(scenario("budget").warnings.some((w) => w.includes("alertEmail"))).toBe(false);
  });
});

describe("WebStack Amplify app", () => {
  const app = (name: string) =>
    Object.values(scenario(name).template.findResources("AWS::Amplify::App"))[0] as {
      Properties: Record<string, unknown> & { EnvironmentVariables: { Name: string; Value: unknown }[] };
    };
  const envVar = (name: string, variable: string) =>
    app(name).Properties.EnvironmentVariables.find((v) => v.Name === variable);

  it("is a compute-platform app, so Next.js server rendering runs", () => {
    scenario("webConnected").template.hasResourceProperties("AWS::Amplify::App", {
      Name: "flakehunter-web",
      Platform: "WEB_COMPUTE",
    });
  });

  it("builds the monorepo's apps/web with Bun after a full, hoisted install that includes the root's TypeScript", () => {
    const spec = String(app("webConnected").Properties.BuildSpec);
    expect(spec).toContain("appRoot: apps/web");
    // Hoisted, so `next` is at the top of node_modules where Amplify's packaging step looks for it.
    expect(spec).toMatch(/- bun install --frozen-lockfile --linker hoisted$/m);
    // A filtered install skips the repo root, where typescript lives, and Next's build then fails.
    expect(spec).not.toContain("--filter");
    expect(spec).toContain("bun run build");
    expect(spec).toContain("baseDirectory: .next");
    expect(envVar("webConnected", "AMPLIFY_MONOREPO_APP_ROOT")?.Value).toBe("apps/web");
  });

  it("writes the three variables the dashboard reads into .env.production for the server runtime", () => {
    const spec = String(app("webConnected").Properties.BuildSpec);
    for (const name of ["API_BASE_URL", "API_TOKEN", "SITE_PASSWORD"]) {
      expect(spec).toContain(`echo "${name}=$${name}" >> .env.production`);
      expect(envVar("webConnected", name)).toBeDefined();
    }
  });

  it("points API_BASE_URL at the API and takes the two secrets from NoEcho parameters", () => {
    expect(envVar("webConnected", "API_BASE_URL")?.Value).toBe("https://api.example.com");
    expect(envVar("webConnected", "API_TOKEN")?.Value).toEqual({ Ref: "ApiToken" });
    expect(envVar("webConnected", "SITE_PASSWORD")?.Value).toEqual({ Ref: "SitePassword" });
    const { template } = scenario("webConnected");
    template.hasParameter("ApiToken", { Type: "String", NoEcho: true });
    template.hasParameter("SitePassword", { Type: "String", NoEcho: true, MinLength: 8 });
  });

  it("only accepts secrets that survive the trip through .env.production unchanged", () => {
    const { template } = scenario("webConnected");
    for (const name of ["ApiToken", "SitePassword"]) {
      template.hasParameter(name, { AllowedPattern: ENV_SAFE_SECRET_PATTERN, ConstraintDescription: Match.anyValue() });
    }
    const allowed = new RegExp(ENV_SAFE_SECRET_PATTERN);
    // Next loads .env.production with dotenv and dotenv-expand: an unquoted value is cut at "#", "$NAME" is replaced
    // by another variable, and quotes, backslashes and whitespace change how the line is read.
    for (const bad of [
      "pass#word1",
      "pa$HOME12",
      "pa$" + "{X}word",
      'pass"word',
      "pass'word",
      "pass\\word",
      "pass word",
      "pass`word",
      "pass\nword",
      "",
    ]) {
      expect(allowed.test(bad)).toBe(false);
    }
    // A token from `openssl rand -hex 32`, a typical strong password, and every allowed punctuation mark.
    for (const good of ["0123456789abcdef".repeat(4), "Tr0ub4dor!3", "x-y_z.~+/=@%^*,:?!"]) {
      expect(allowed.test(good)).toBe(true);
    }
  });

  it("never exposes a variable with the NEXT_PUBLIC_ prefix, which would put it in the browser bundle", () => {
    for (const variable of app("webConnected").Properties.EnvironmentVariables) {
      expect(variable.Name.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
  });

  it("connects to GitHub through a Secrets Manager dynamic reference, never a literal token", () => {
    const properties = app("webConnected").Properties;
    expect(properties.Repository).toBe("https://github.com/glennmcd/flakehunter");
    expect(String(properties.AccessToken)).toContain("{{resolve:secretsmanager:flakehunter/github-token");
    expect(String(properties.AccessToken)).not.toMatch(/gh[pousr]_|github_pat_/);
  });

  it("serves the main branch as production with automatic builds when connected", () => {
    scenario("webConnected").template.hasResourceProperties("AWS::Amplify::Branch", {
      BranchName: "main",
      Stage: "PRODUCTION",
      Framework: "Next.js - SSR",
      EnableAutoBuild: true,
    });
  });

  it("is created unconnected, without auto builds, and warns, when no repository is given", () => {
    const { template, warnings } = scenario("webDefaults");
    const properties = app("webDefaults").Properties;
    expect(properties).not.toHaveProperty("Repository");
    expect(properties).not.toHaveProperty("AccessToken");
    template.hasResourceProperties("AWS::Amplify::Branch", { EnableAutoBuild: false });
    expect(warnings.some((w) => w.includes("not connected to GitHub"))).toBe(true);
    expect(scenario("webConnected").warnings).toEqual([]);
  });

  it("outputs the app id and the site URL", () => {
    const { template } = scenario("webConnected");
    template.hasOutput("AmplifyAppId", { Value: Match.anyValue() });
    template.hasOutput("SiteUrl", { Value: Match.anyValue() });
  });

  it("uses the same package names and Bun version as the repository, so the build spec cannot drift", () => {
    const read = (file: string) => readFileSync(path.join(here, "../..", file), "utf8");
    const spec = String(app("webConnected").Properties.BuildSpec);
    expect(JSON.parse(read("apps/web/package.json")).name).toBe("@flakehunter/web");
    expect(JSON.parse(read("packages/shared-types/package.json")).name).toBe("@flakehunter/shared-types");
    expect(JSON.parse(read("apps/web/package.json")).scripts.build).toBeDefined();
    const ciBun = /bun-version:\s*([\d.]+)/.exec(read(".github/workflows/ci.yml"))?.[1];
    expect(spec).toContain(`bun@${ciBun}`);
  });
});

describe("WebStack custom domain", () => {
  const domain = (name: string) =>
    scenario(name).template.findResources("AWS::Amplify::Domain") as Record<
      string,
      { Properties: Record<string, unknown>; DependsOn?: string[] }
    >;

  it("creates no domain association unless one is given", () => {
    scenario("webDefaults").template.resourceCountIs("AWS::Amplify::Domain", 0);
    scenario("webConnected").template.resourceCountIs("AWS::Amplify::Domain", 0);
  });

  it("serves each prefix from the branch on the app, with no automatic subdomains", () => {
    scenario("webDomain").template.hasResourceProperties("AWS::Amplify::Domain", {
      AppId: { "Fn::GetAtt": [Match.stringLikeRegexp("^WebApp"), "AppId"] },
      DomainName: "example.com",
      EnableAutoSubDomain: false,
      SubDomainSettings: [
        { Prefix: "", BranchName: "main" },
        { Prefix: "www", BranchName: "main" },
        { Prefix: "app.dev", BranchName: "main" },
      ],
    });
    scenario("webDomainBranch").template.hasResourceProperties("AWS::Amplify::Domain", {
      SubDomainSettings: [{ Prefix: "www", BranchName: "release" }],
    });
  });

  it("has the logical id the import of an existing association maps to, and leaves the certificate to Amplify", () => {
    const resources = domain("webDomain");
    expect(Object.keys(resources)).toEqual(["Domain"]);
    expect(resources.Domain?.Properties).not.toHaveProperty("CertificateSettings");
  });

  it("waits for the branch, which it names only by a plain string", () => {
    expect(domain("webDomain").Domain?.DependsOn).toContain("Branch");
  });

  it("rejects a malformed domain, an empty prefix list, a bad prefix and a repeated one, naming the field", () => {
    expect(scenario("badDomainName").error).toContain("customDomain.domainName");
    expect(scenario("badDomainNoSubDomains").error).toContain("customDomain.subDomains must list");
    expect(scenario("badDomainPrefix").error).toContain('invalid prefix: "-www"');
    expect(scenario("badDomainDuplicate").error).toContain("twice");
  });
});

describe("cdk.json custom domain", () => {
  // g26work.com and www belong to the g26work-site app; the dashboard has its own subdomain as a separate association
  // (docs/deployment.md, "Custom domain").
  it("is flakehunter.g26work.com alone, served at its own root", () => {
    const context = JSON.parse(readFileSync(path.join(infraRoot, "cdk.json"), "utf8")).context;
    expect(context.customDomain).toEqual({ domainName: "flakehunter.g26work.com", subDomains: [""] });
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
