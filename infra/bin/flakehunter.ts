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

const api = new ApiStack(app, "FlakeHunterApi", {
  env,
  description: "FlakeHunter API: Lambda behind an API Gateway HTTP API",
  // Pass with: cdk deploy -c alertEmail=you@example.com [-c monthlyBudgetUsd=10] [-c reservedConcurrency=5]
  alertEmail: app.node.tryGetContext("alertEmail"),
  monthlyBudgetUsd: number("monthlyBudgetUsd"),
  reservedConcurrency: number("reservedConcurrency"),
});

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
});
