import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";

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

new ApiStack(app, "FlakeHunterApi", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  description: "FlakeHunter API: Lambda behind an API Gateway HTTP API",
  // Pass with: cdk deploy -c alertEmail=you@example.com [-c monthlyBudgetUsd=10] [-c reservedConcurrency=5]
  alertEmail: app.node.tryGetContext("alertEmail"),
  monthlyBudgetUsd: number("monthlyBudgetUsd"),
  reservedConcurrency: number("reservedConcurrency"),
});
