import { SSMClient } from "@aws-sdk/client-ssm";
import { buildApp } from "./app.js";
import { createHandler } from "./lambda/handler.js";
import { loadSecrets } from "./lambda/secrets.js";

// AWS Lambda entry point (index.ts is the long-running one for local development). The infrastructure sets
// SSM_PARAMETER_PREFIX, for example /flakehunter/demo/, and grants read access to the parameters under it.
export const handler = createHandler({
  loadSecrets: () => {
    const prefix = process.env.SSM_PARAMETER_PREFIX;
    if (!prefix) throw new Error("SSM_PARAMETER_PREFIX is not set");
    return loadSecrets(new SSMClient({}), prefix);
  },
  buildApp: () => buildApp(),
});
