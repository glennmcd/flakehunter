import { Annotations, CfnOutput, CfnParameter, SecretValue, Stack, type StackProps, Tags } from "aws-cdk-lib";
import { CfnApp, CfnBranch, CfnDomain } from "aws-cdk-lib/aws-amplify";
import type { Construct } from "constructs";

/**
 * A custom domain served by the branch. Amplify issues and renews the certificate and, when the domain's Route 53
 * hosted zone is in this account, writes the DNS records itself; with the zone elsewhere it times out waiting for them.
 */
export interface CustomDomain {
  /** The registered domain, for example example.com. */
  domainName: string;
  /** Prefixes to serve: "" is the domain itself, "www" serves www.<domainName>. */
  subDomains: string[];
}

const DOMAIN_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBDOMAIN_PREFIX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function checkCustomDomain({ domainName, subDomains }: CustomDomain): void {
  if (!DOMAIN_NAME.test(domainName)) {
    throw new Error(`customDomain.domainName must be a lowercase domain such as example.com: got "${domainName}"`);
  }
  if (!Array.isArray(subDomains) || subDomains.length === 0) {
    throw new Error('customDomain.subDomains must list at least one prefix ("" for the domain itself)');
  }
  for (const prefix of subDomains) {
    if (prefix !== "" && !SUBDOMAIN_PREFIX.test(prefix)) {
      throw new Error(`customDomain.subDomains has an invalid prefix: "${prefix}"`);
    }
  }
  if (new Set(subDomains).size !== subDomains.length) {
    throw new Error("customDomain.subDomains lists a prefix twice");
  }
}

export interface WebStackProps extends StackProps {
  /** The API's base URL (the HTTP API endpoint); becomes the dashboard's API_BASE_URL. */
  apiUrl: string;
  /** HTTPS URL of the GitHub repository to build from, for example https://github.com/glennmcd/flakehunter. */
  repository?: string;
  /**
   * Name of an AWS Secrets Manager secret holding a GitHub personal access token Amplify uses to read the repository
   * and register its webhook. Resolved by CloudFormation at deploy time, so the token is never in the template.
   * Without it (or without `repository`) the app is created unconnected and the repository is attached in the console.
   */
  githubTokenSecretName?: string;
  /** Branch to build and serve. */
  branch?: string;
  /**
   * Serve the branch on a custom domain as well. Removing it from a later deploy deletes the domain association, so
   * keep it in cdk.json rather than passing it per deploy.
   */
  customDomain?: CustomDomain;
}

/**
 * The monorepo build for Amplify Hosting (compute platform, which runs Next.js server rendering). Notes:
 * - `appRoot` points Amplify at apps/web; the install runs at the repo root so the workspace packages resolve.
 * - Amplify installs Bun with npm because its build image has none. The install is a full one (TypeScript is a
 *   dependency of the repo root, which Next's build needs; an earlier `--filter` install left the root out) and uses
 *   the hoisted linker. Bun's default isolated linker keeps packages in a symlinked store with no `next` at the top
 *   of node_modules, and Amplify's packaging step then fails with "The 'node_modules' folder is missing the 'next'
 *   dependency". AWS asks for the same thing from pnpm workspaces (`node-linker=hoisted`). Only the Amplify install
 *   uses it; local installs and CI keep the default.
 * - The server runtime does not see Amplify environment variables on its own, so the build writes the three the
 *   dashboard reads into .env.production, which Next loads at runtime.
 */
export const BUILD_SPEC = `version: 1
applications:
  - appRoot: apps/web
    frontend:
      phases:
        preBuild:
          commands:
            - nvm use 22 || nvm install 22
            - npm install --global bun@1.4.2
            - cd ../..
            - bun install --frozen-lockfile --linker hoisted
            - cd apps/web
        build:
          commands:
            - echo "API_BASE_URL=$API_BASE_URL" >> .env.production
            - echo "API_TOKEN=$API_TOKEN" >> .env.production
            - echo "SITE_PASSWORD=$SITE_PASSWORD" >> .env.production
            - bun run build
      artifacts:
        baseDirectory: .next
        files:
          - '**/*'
      cache:
        paths:
          - ../../node_modules/**/*
`;

export class WebStack extends Stack {
  readonly app: CfnApp;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const branchName = props.branch ?? "main";
    if (props.customDomain) checkCustomDomain(props.customDomain);
    Tags.of(this).add("project", "flakehunter");

    // Passed at deploy time (cdk deploy --parameters), never written to the template or committed.
    const apiToken = new CfnParameter(this, "ApiToken", {
      type: "String",
      noEcho: true,
      minLength: 1,
      description: "The API's read token (the API_TOKEN SSM parameter); server-side only, never sent to browsers",
    });
    const sitePassword = new CfnParameter(this, "SitePassword", {
      type: "String",
      noEcho: true,
      minLength: 8,
      description: "Password for the site-wide Basic auth gate. Production refuses to serve without one.",
    });

    const connected = Boolean(props.repository && props.githubTokenSecretName);
    this.app = new CfnApp(this, "WebApp", {
      name: "flakehunter-web",
      platform: "WEB_COMPUTE",
      buildSpec: BUILD_SPEC,
      ...(connected
        ? {
            repository: props.repository,
            // A CloudFormation dynamic reference to Secrets Manager, resolved at deploy time.
            accessToken: SecretValue.secretsManager(props.githubTokenSecretName as string).unsafeUnwrap(),
          }
        : {}),
      environmentVariables: [
        { name: "AMPLIFY_MONOREPO_APP_ROOT", value: "apps/web" },
        { name: "NEXT_TELEMETRY_DISABLED", value: "1" },
        { name: "API_BASE_URL", value: props.apiUrl },
        { name: "API_TOKEN", value: apiToken.valueAsString },
        { name: "SITE_PASSWORD", value: sitePassword.valueAsString },
      ],
    });

    const branch = new CfnBranch(this, "Branch", {
      appId: this.app.attrAppId,
      branchName,
      stage: "PRODUCTION",
      framework: "Next.js - SSR",
      enableAutoBuild: connected,
    });

    if (props.customDomain) {
      // The logical id "Domain" is what the one-off `cdk import` of a console-made association maps to
      // (docs/deployment.md, "Custom domain"). Without a certificate setting Amplify manages the certificate.
      const domain = new CfnDomain(this, "Domain", {
        appId: this.app.attrAppId,
        domainName: props.customDomain.domainName,
        enableAutoSubDomain: false,
        subDomainSettings: props.customDomain.subDomains.map((prefix) => ({ prefix, branchName })),
      });
      // The branch name is a plain string, so CloudFormation would not otherwise wait for the branch to exist.
      domain.addResourceDependency(branch);
    }

    if (!connected) {
      Annotations.of(this).addWarningV2(
        "flakehunter:web-not-connected",
        "No repository and githubTokenSecretName given, so the Amplify app is not connected to GitHub. Pass " +
          "-c repository=https://github.com/<owner>/<repo> -c githubTokenSecretName=<secret> or connect it in the console.",
      );
    }

    new CfnOutput(this, "AmplifyAppId", { value: this.app.attrAppId });
    new CfnOutput(this, "SiteUrl", {
      value: `https://${branchName}.${this.app.attrDefaultDomain}`,
      description: "The dashboard (asks for the site password)",
    });
  }
}
