import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { WebStack } from "../lib/web-stack.js";

// Everything lives in the project's one AWS Region. The account comes from the credentials the CDK CLI runs with
// (CDK_DEFAULT_ACCOUNT), so no account id is committed.
const REGION = "us-east-2";

const app = new App();

const number = (name: string): number | undefined => {
  const raw = app.node.tryGetContext(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) throw new Error(`context ${name} must be a positive number`);
  return value;
};

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

// -c throttleRate=N sets the API's steady requests per second (default 10); -c throttleBurst=M the burst (default 2N).
const throttleRate = number("throttleRate");
const throttleBurst = number("throttleBurst");
if (throttleBurst !== undefined && throttleRate === undefined) {
  throw new Error("context throttleBurst needs throttleRate as well");
}
const throttle =
  throttleRate === undefined ? undefined : { rateLimit: throttleRate, burstLimit: throttleBurst ?? throttleRate * 2 };

const api = new ApiStack(app, "FlakeHunterApi", {
  env,
  description: "FlakeHunter API: Lambda behind an API Gateway HTTP API",
  // Pass with: cdk deploy -c alertEmail=you@example.com [-c monthlyBudgetUsd=30] [-c reservedConcurrency=5]
  //   [-c throttleRate=10 -c throttleBurst=20]
  alertEmail: app.node.tryGetContext("alertEmail"),
  monthlyBudgetUsd: number("monthlyBudgetUsd"),
  reservedConcurrency: number("reservedConcurrency"),
  throttle,
});

// The dashboard's custom domain lives in cdk.json's context, so every deploy carries it (a deploy without it would
// delete the domain association). A -c override arrives as a JSON string.
const rawDomain = app.node.tryGetContext("customDomain");
const customDomain = typeof rawDomain === "string" ? JSON.parse(rawDomain) : rawDomain;

// The dashboard on Amplify Hosting. Deploy with the two secrets it needs and, to build from GitHub, the repository:
//   cdk deploy FlakeHunterWeb --parameters FlakeHunterWeb:ApiToken=... --parameters FlakeHunterWeb:SitePassword=... \
//     -c repository=https://github.com/<owner>/<repo> -c githubTokenSecretName=<secrets manager secret>
new WebStack(app, "FlakeHunterWeb", {
  env,
  description: "FlakeHunter dashboard: Next.js on Amplify Hosting",
  apiUrl: api.httpApiUrl,
  repository: app.node.tryGetContext("repository"),
  githubTokenSecretName: app.node.tryGetContext("githubTokenSecretName"),
  branch: app.node.tryGetContext("branch"),
  customDomain,
});
