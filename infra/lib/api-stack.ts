import path from "node:path";
import { fileURLToPath } from "node:url";
import { Annotations, ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, Tags } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import { HttpApi, HttpStage, LogGroupLogDestination } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/** Where `bun run scripts/bundle-api.ts` writes the bundled Lambda (cdk.json runs it before every synth). */
const DEFAULT_CODE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/api");

/**
 * The SSM parameters the API reads at start-up, as `<prefix><NAME>`. Must match SECRET_NAMES in
 * apps/api/src/lambda/secrets.ts (a test compares them).
 */
export const SECRET_NAMES = ["DATABASE_URL", "API_TOKEN", "GITHUB_PAT", "GITHUB_WEBHOOK_SECRET"] as const;

/** 10 requests per second, burst 20: a dashboard page view makes two calls, and the seed uploads one at a time. */
export const DEFAULT_THROTTLE = { rateLimit: 10, burstLimit: 20 } as const;

export interface ApiStackProps extends StackProps {
  /** Directory holding the bundled Lambda (index.mjs). Defaults to infra/dist/api; tests pass a small fixture. */
  codePath?: string;
  /** Where the secrets live in Parameter Store; created by hand (SecureString), never by this stack. */
  parameterPrefix?: string;
  /** Email for the cost budget alerts. Without one no budget is created and synth prints a warning. */
  alertEmail?: string;
  /** Monthly cost, in USD, at which the budget alerts (80% actual, 100% forecast). Covers the whole account. */
  monthlyBudgetUsd?: number;
  /**
   * Steady and burst requests per second the HTTP API accepts, across all callers; over it API Gateway answers 429
   * itself, without invoking the Lambda. This is the hard cap on what a flood can cost, so keep it as low as real use
   * allows (see "What it costs" in docs/deployment.md). Defaults to DEFAULT_THROTTLE.
   */
  throttle?: { rateLimit: number; burstLimit: number };
  /** Per-token and per-IP upload limit enforced by the API itself (see apps/api/src/ratelimit). */
  uploadRateLimit?: { max: number; windowSeconds: number };
  /**
   * Caps the Lambda's concurrent executions, which bounds cost and database connections. Left unset by default:
   * AWS refuses a reservation that leaves an account under 10 unreserved concurrent executions, which a new account
   * (default quota 10) cannot afford. Check `aws lambda get-account-settings`, then pass a number.
   */
  reservedConcurrency?: number;
}

export class ApiStack extends Stack {
  readonly httpApiUrl: string;
  readonly rateLimitTable: Table;
  readonly apiFunction: LambdaFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps = {}) {
    super(scope, id, props);

    const prefix = props.parameterPrefix ?? "/flakehunter/demo/";
    if (!/^\/.+\/$/.test(prefix)) {
      throw new Error(`parameterPrefix must start and end with "/": got "${prefix}"`);
    }
    const throttle = props.throttle ?? DEFAULT_THROTTLE;
    for (const [name, value] of Object.entries(throttle)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`throttle.${name} must be a positive integer`);
    }
    const uploadRateLimit = props.uploadRateLimit ?? { max: 120, windowSeconds: 60 };

    Tags.of(this).add("project", "flakehunter");

    // Counters for the per-token upload rate limit. They expire on their own (TTL), so losing the table loses nothing.
    this.rateLimitTable = new Table(this, "RateLimitTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new LogGroup(this, "ApiFunctionLogs", {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.apiFunction = new LambdaFunction(this, "ApiFunction", {
      code: Code.fromAsset(props.codePath ?? DEFAULT_CODE_PATH),
      handler: "index.handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      // API Gateway gives an integration at most 29 seconds, so a longer Lambda timeout could never be used.
      timeout: Duration.seconds(29),
      reservedConcurrentExecutions: props.reservedConcurrency,
      logGroup,
      environment: {
        SSM_PARAMETER_PREFIX: prefix,
        RATE_LIMIT_TABLE: this.rateLimitTable.tableName,
        UPLOAD_RATE_LIMIT_MAX: String(uploadRateLimit.max),
        UPLOAD_RATE_LIMIT_WINDOW_SECONDS: String(uploadRateLimit.windowSeconds),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // Least privilege: read exactly the four secrets, and write only counter items in the rate limit table.
    this.apiFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: SECRET_NAMES.map((name) =>
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: `${prefix.slice(1)}${name}`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ),
      }),
    );
    this.rateLimitTable.grant(this.apiFunction, "dynamodb:UpdateItem");

    // No CORS: the browser never calls this API (the dashboard's server does), and the API does its own token auth.
    // The $default stage has no path prefix, which the API's auth exemptions rely on.
    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: "flakehunter-api",
      createDefaultStage: false,
      defaultIntegration: new HttpLambdaIntegration("ApiIntegration", this.apiFunction),
    });

    const accessLogs = new LogGroup(this, "ApiAccessLogs", {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new HttpStage(this, "DefaultStage", {
      httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle,
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.jsonWithStandardFields(),
      },
    });
    this.httpApiUrl = httpApi.apiEndpoint;

    if (props.alertEmail) {
      this.addBudget(props.alertEmail, props.monthlyBudgetUsd ?? 10);
    } else {
      Annotations.of(this).addWarningV2(
        "flakehunter:no-budget",
        "No alertEmail given, so no cost budget is created. Pass -c alertEmail=you@example.com before deploying.",
      );
    }

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint, description: "API_BASE_URL for the dashboard" });
    new CfnOutput(this, "FunctionName", {
      value: this.apiFunction.functionName,
      description: "For aws lambda commands",
    });
    new CfnOutput(this, "RateLimitTableName", { value: this.rateLimitTable.tableName });
    new CfnOutput(this, "ParameterPrefix", {
      value: prefix,
      description: "Create the four SecureString parameters here",
    });
  }

  private addBudget(email: string, monthlyUsd: number) {
    const subscribers = [{ subscriptionType: "EMAIL", address: email }];
    new CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "flakehunter-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: monthlyUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers,
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers,
        },
      ],
    });
  }
}
