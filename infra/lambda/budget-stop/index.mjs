/**
 * Budget kill switch: sets the API function's reserved concurrency to 0, which refuses every invocation until
 * someone runs `aws lambda delete-function-concurrency` (see docs/deployment.md). It runs when the account budget
 * reaches 100% of its actual spend. It ignores the message, so anyone in the account who can publish to the SNS topic
 * that triggers it can also trip it (infra/scp/README.md uses that to test the chain).
 *
 * `setConcurrency(functionName, limit)` is injected so tests need no AWS SDK.
 */
export function createHandler({ setConcurrency, functionName }) {
  if (!functionName) throw new Error("FUNCTION_NAME is not set");
  return async () => {
    await setConcurrency(functionName, 0);
    console.warn(`Budget exceeded: reserved concurrency of ${functionName} set to 0`);
    return { stopped: functionName };
  };
}

// The AWS SDK comes from the Lambda runtime, so it is loaded here only, never when the module is imported by a test.
export const handler = async (event) => {
  const { LambdaClient, PutFunctionConcurrencyCommand } = await import("@aws-sdk/client-lambda");
  const client = new LambdaClient({});
  const setConcurrency = (name, limit) =>
    client.send(new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: limit }));
  return createHandler({ setConcurrency, functionName: process.env.FUNCTION_NAME })(event);
};
