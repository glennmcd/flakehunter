# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on
[glennmcd/flakehunter](https://github.com/glennmcd/flakehunter/security). Do not open a public issue.

## How FlakeHunter is protected

### Untrusted input

FlakeHunter's riskiest job is processing what CI sends it, so all of it is treated as hostile.

- **Webhooks are verified.** Every GitHub delivery's `X-Hub-Signature-256` is checked against the exact raw body
  before anything else happens.
- **Only trusted runs are ingested.** Whoever writes a run's code controls its test-result artifact, so FlakeHunter
  skips runs from forks and runs started by triggers that often relay fork code (`pull_request_target`,
  `workflow_run`, `issue_comment`). Only `push`, `pull_request`, `merge_group`, `schedule` and `workflow_dispatch` are
  accepted.
- **The repo comes from the database, never the payload.** The webhook looks the repo up by GitHub repo id; an
  upload's repo comes from its token.
- **Zip bombs are stopped.** Artifacts are streamed and only `.xml` entries are inflated. The number of entries is
  capped, and extraction stops as soon as the actual decompressed XML reaches 11 MB; the sizes the archive claims are
  not trusted. Zips over 10 MB are refused outright.
- **Gzip bombs are stopped.** The 11 MB upload limit applies after decompression and is enforced while streaming.
  Bad gzip data gets a `400`, and any encoding other than gzip is rejected.
- **Every request and response is checked against a schema.** Zod validates all `/api` input and output.
- **Duplicate deliveries are ignored.** Webhooks are keyed on the delivery id, and uploads on run, attempt and report
  key, so a replay never counts results twice.

### Authentication and access

- **Upload tokens are per repo.** A leaked CI secret can write only to its own repo. Only a sha256 hash of each token
  is stored, tokens can be revoked, and the token check runs before the body is parsed.
- **Rate limits apply per IP and per token.** Counting by IP is what stops a flood of invented tokens. On Lambda the
  counters live in DynamoDB, and the API refuses to start there without that table. Only a hash of the token is
  stored.
- **API Gateway throttles everything** to 10 requests per second.
- **The dashboard password fails closed.** In production, a missing `SITE_PASSWORD` means a 503, not an open site.
  The password is compared in constant time, and the gate covers every path, including static assets.
- **The read token never reaches the browser.** The dashboard calls the API from the server, so there is no CORS
  setup and no token in client-side code.
- **The auth hook allows by exception.** It runs on every request; only `/health`, the webhook and `/api/reports`
  (which checks its own token) are exempt.

### Secrets

- **No secrets in code or CloudFormation.** The API's four secrets are SSM SecureString parameters, read when the
  Lambda starts. The dashboard's token and password are NoEcho parameters, and the GitHub token is a Secrets Manager
  dynamic reference.
- **Errors never leak secrets.** Environment-variable errors name the variable, never its value. API errors share one
  fixed format. Raw error text goes only to the logs; the dashboard and `webhook_events.processing_error` get fixed
  text. The MCP server's error results carry only the API's error code and message, and anything unexpected
  becomes fixed text; no stack traces or tokens reach the model.
- **Git history was cleaned before publishing.** Account ids and personal email addresses were rewritten out of
  history, and account ids now come from environment variables.

### AWS

- **Least-privilege IAM** in the CDK stacks, with every regional resource in one Region (us-east-2).
- **Organization guardrails (SCPs)** in [`infra/scp/`](../infra/scp/README.md): a Region lock, an allow-list of the
  services FlakeHunter uses, a block on multi-Region features and on long-lived IAM credentials (IAM users and access
  keys), and protection for the budget kill switch.
- **Cost protection.** A $30 monthly budget (created when `alertEmail` is passed at deploy) sends alerts, and at
  100% sets the API's concurrency to 0, which refuses every request. A separate freeze SCP that blocks new resources and deploys is attached once you approve it. The
  policies are validated with IAM Access Analyzer, and the apply and rollback scripts are tested against a fake `aws`.

### Engineering process

- **Tests drive the safety rules.** Every route and function ships with tests, which run against an in-memory database
  with no network.
- **CI checks every change** with lint, typecheck, tests, the dashboard build and the CDK synth.
- **Workflow permissions are explicit** (`contents: read`), here and in the test-fixture repo.

## Known gaps

These are accepted for a demo-sized deployment and are the next things to fix.

1. **The read token is shared.** One static `API_TOKEN` serves the dashboard, the MCP server and every read client.
   There are no per-user accounts or audit trail, and rotation is manual.
2. **`GITHUB_PAT` is a classic token** with `repo` and `workflow` scopes, broader than FlakeHunter needs. A
   fine-grained token or a GitHub App, read-only on artifacts and limited to registered repos, would shrink that.
3. **Webhooks are processed during the request.** Large artifacts can exceed GitHub's 10-second timeout and tie up
   Lambda. The planned fix is a queue (SQS).
4. **Reads have no per-client rate limit.** Only API Gateway's account-wide throttle applies, and there is no WAF in
   front.
5. **Basic auth is weak protection for the dashboard.** It's fine for a demo, but there's no lockout, no MFA and no
   per-user access.
6. **SCPs only protect once applied.** The policies in `infra/scp/` take effect only after they are attached with the
   scripts there; check them after every policy change.
7. **Dependencies are not scanned automatically.** Neither Dependabot nor a dependency audit runs in CI.
