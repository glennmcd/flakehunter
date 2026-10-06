# Service control policies

Two SCPs for the `flakehunter` member account (`<flakehunter-account-id>`) in the Organization. Neither is created by CDK and
nothing here has been attached: SCPs are managed from the **management account** (`<management-account-id>`), so you run these
commands there. SCPs never apply to the management account itself, and they only restrict; they grant nothing.

Both policies exempt the AWS-managed `/managed/AWSManaged*` roles so the project can still be administered. Validated
with `accessanalyzer validate-policy --policy-type SERVICE_CONTROL_POLICY` (no findings). Each is far under the
10,240-character limit, but an account, OU or root can have **at most 5 SCPs attached**, and the AWS-managed ones
count, so check `aws organizations list-policies-for-target --profile flakehunter-mgmt` first.

## Your account ids

The two AWS account ids are not stored in this repository. Wherever a command here shows `<management-account-id>` or
`<flakehunter-account-id>`, put your own 12-digit id. The scripts in `scripts/` read them from the environment and
refuse to run without them, so export both once per shell, for example in your shell profile.

The management account:

```bash
export FH_MGMT_ACCOUNT_ID=<management-account-id>
```

The `flakehunter` account, the one the policies are attached to:

```bash
export FH_SCP_TARGET_ID=<flakehunter-account-id>
```

`aws sts get-caller-identity --profile flakehunter-mgmt` and `aws sts get-caller-identity --profile flakehunter` print
the ids. The scripts check them against the profile before they change anything, which is what stops a wrong profile.

## 1. `flakehunter-guardrails.json` (attach always)

| Statement | Effect |
| --- | --- |
| `DenyOutsideUsEast2` | Everything outside us-east-2 is denied, except global services (IAM, STS, Budgets, billing, SSO, Route 53 and similar). Route 53 is global, so AWS evaluates its calls as `us-east-1`; without the exemption every DNS call would be denied. |
| `DenyServicesFlakeHunterDoesNotUse` | Only the services the CDK stacks use (plus CDK bootstrap, billing, and Route 53 and ACM for a custom domain) are allowed. Anything else, such as EC2 or RDS, is denied. |
| `DenyMultiRegionAndEdgeFeatures` | No Lambda@Edge replication, StackSets, DynamoDB global tables, S3 replication or multi-Region KMS keys. |
| `DenyLongLivedIamCredentials` | No IAM users, access keys or login profiles. |
| `ProtectBudgetKillSwitch` | Only the CDK's CloudFormation execution role may modify or delete the budget, the stop function or its topic. |

The service allow-list is strict on purpose. **When you add a service to the CDK, add it to the second statement
first**, or the deploy fails with an explicit deny in the CloudFormation execution role.

**Custom domain.** `route53:*` and `acm:*` are allowed so a domain can be pointed at the stack:
- *API (API Gateway):* a Regional custom domain needs an ACM certificate in the same Region as the API, which is
  us-east-2. ACM therefore stays pinned to us-east-2 and is not exempted from the Region lock. Then an alias record in
  Route 53 points the domain at the API.
- *Dashboard (Amplify):* Amplify provisions its own certificate and CloudFront distribution as a service, so your
  principals need only Route 53 for the DNS records.

Two things are deliberately **not** allowed. Registering a domain through AWS needs `route53domains:*` (a global service
that bills you for the registration): add it to both statements if you register here, or buy the domain elsewhere and
point its name servers at a Route 53 hosted zone. And a certificate in us-east-1, which CloudFront-based setups of your
own would need, is denied; it would need `acm:*` added to the first statement too.

Apply the change with `bash scripts/scp-apply-guardrails.sh --dry-run`, then without `--dry-run`. It sees the file now
differs from the attached policy and updates it in place. It takes effect on the account within a few minutes.

The admin role (`AccountFullAccessRole`) is bound by the Region and service rules, which is the point. If you lock
yourself out of something, fix it from the management account (detach the policy below).

```bash
# In the management account
aws organizations create-policy --profile flakehunter-mgmt --type SERVICE_CONTROL_POLICY --name FlakeHunterGuardrails \
  --description "FlakeHunter: us-east-2 only, allow-listed services" \
  --content file://infra/scp/flakehunter-guardrails.json
aws organizations attach-policy --profile flakehunter-mgmt --policy-id <p-id from above> --target-id <flakehunter-account-id>
```

Roll back (management account). First list the policies attached to the account to find the `<p-id>`:

```bash
aws organizations list-policies-for-target --profile flakehunter-mgmt --target-id <flakehunter-account-id> --filter SERVICE_CONTROL_POLICY
```

Then detach it:

```bash
aws organizations detach-policy --profile flakehunter-mgmt --policy-id <p-id> --target-id <flakehunter-account-id>
```

### The same steps as scripts

`scripts/scp-apply-guardrails.sh` and `scripts/scp-rollback-guardrails.sh` do the commands above for you, with the
checks the manual steps leave to you. Sign in to the management account first (`aws login --profile flakehunter-mgmt`).
Both stop without changing anything unless the profile really is the management account (`<management-account-id>`), and the
apply script also stops if the account already has 5 SCPs attached.

See what would happen first. This only reads from AWS:

```bash
bash scripts/scp-apply-guardrails.sh --dry-run
```

Apply the policy. It creates `FlakeHunterGuardrails` or updates it from the JSON file, attaches it, and asks you to
type `yes` first (`--yes` skips the question). Running it again is safe:

```bash
bash scripts/scp-apply-guardrails.sh
```

Roll back by detaching the policy. The policy itself is kept, so applying again is quick:

```bash
bash scripts/scp-rollback-guardrails.sh
```

Add `--delete` to the rollback to delete the policy as well. Settings such as the profile, the target account and the
policy file are `FH_*` environment variables, listed at the top of `scripts/scp-common.sh`. The scripts are tested
against a fake `aws`, not against a real Organization, so run `--dry-run` first.

## 2. `flakehunter-budget-freeze.json` (attached by a budget action, never by hand)

Denies everything except reading, deleting, and the actions needed to recover (STS, billing, `lambda:PutFunctionConcurrency`,
log writes). Reading includes Route 53 and ACM, so a custom domain's records and certificate stay visible, but they
cannot be changed or deleted during a freeze. It stops **cost growth**: no new resources, deploys or updates, by anyone. It does **not** stop the
running API: an SCP only restricts IAM principals, and API Gateway calls Lambda as a service principal. The stop
itself is the kill switch in the CDK (`ApiStack`): at 100% of the monthly budget (default $30) the account budget
publishes to an SNS topic and a small Lambda sets the API function's reserved concurrency to 0, which refuses every
invocation.

So the two budgets play different roles:

| Budget | Where | At 100% actual spend |
| --- | --- | --- |
| `MonthlyBudget` (CDK, `monthlyBudgetUsd`, default 30) | `flakehunter` account | Emails you and **automatically stops the API**. |
| Freeze budget (below, by hand) | management account, filtered to the `flakehunter` account | Asks you to approve attaching the freeze SCP. |

AWS Budgets can only apply an SCP from the management account, so this budget lives there. It uses **manual
approval**: you get an email and approve in the Budgets console. Switch `--approval-model` to `AUTOMATIC` once you
trust it. Budget data refreshes only a few times a day, so neither layer reacts within minutes; the API throttle is
what bounds a flood in the meantime.

Run these in the management account, in this order, each one after the previous.

1. Create the freeze policy and note the policy id (`p-...`) it prints:

   ```bash
   aws organizations create-policy --profile flakehunter-mgmt --type SERVICE_CONTROL_POLICY --name FlakeHunterBudgetFreeze \
     --description "Applied by a budget action: no changes, read and recovery only" \
     --content file://infra/scp/flakehunter-budget-freeze.json
   ```

2. Create the role AWS Budgets assumes to attach the policy. The trusted service is `budgets.amazonaws.com`:

   ```bash
   aws iam create-role --profile flakehunter-mgmt --role-name FlakeHunterBudgetActionRole --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"budgets.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"<management-account-id>"}}}]}'
   ```

3. Allow the role to attach and detach SCPs, and nothing else:

   ```bash
   aws iam put-role-policy --profile flakehunter-mgmt --role-name FlakeHunterBudgetActionRole --policy-name AttachFreezeScp --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["organizations:AttachPolicy","organizations:DetachPolicy"],"Resource":"*"}]}'
   ```

4. Print the role's ARN. It should be `arn:aws:iam::<management-account-id>:role/FlakeHunterBudgetActionRole`, which is the
   value `--execution-role-arn` uses below:

   ```bash
   aws iam get-role --profile flakehunter-mgmt --role-name FlakeHunterBudgetActionRole --query Role.Arn --output text
   ```

   The role is not tested. The `aws:SourceAccount` condition guards against the confused-deputy problem, but if the
   budget action later fails with an assume-role error, remove that condition from the trust policy first. `"*"` in
   step 3 is broad; narrowing it to the freeze policy and the `flakehunter` account needs separate Organizations
   resource ARNs for the policy and the account, so test that on its own.

5. Create the budget:

   ```bash
   aws budgets create-budget --profile flakehunter-mgmt --account-id <management-account-id> --budget '{
     "BudgetName": "flakehunter-freeze", "BudgetType": "COST", "TimeUnit": "MONTHLY",
     "BudgetLimit": {"Amount": "30", "Unit": "USD"},
     "CostFilters": {"LinkedAccount": ["<flakehunter-account-id>"]}
   }'
   ```

6. Create the budget action. Replace the policy id with the one from step 1 and the email with yours:

   ```bash
   aws budgets create-budget-action --profile flakehunter-mgmt --account-id <management-account-id> --budget-name flakehunter-freeze \
     --notification-type ACTUAL --action-type APPLY_SCP_POLICY \
     --action-threshold ActionThresholdValue=100,ActionThresholdType=PERCENTAGE \
     --definition 'ScpActionDefinition={PolicyId=<p-id of the freeze policy>,TargetIds=[<flakehunter-account-id>]}' \
     --execution-role-arn arn:aws:iam::<management-account-id>:role/FlakeHunterBudgetActionRole --approval-model MANUAL \
     --subscribers SubscriptionType=EMAIL,Address=<you@example.com>
   ```

The role and budget commands have not been run; check the syntax against `aws budgets create-budget-action help` and
`aws iam create-role help` first.

### Recovery after a freeze

Management account: lift the freeze. First list the policies attached to the account to find the `<freeze p-id>`:

```bash
aws organizations list-policies-for-target --profile flakehunter-mgmt --target-id <flakehunter-account-id> --filter SERVICE_CONTROL_POLICY
```

Then detach it:

```bash
aws organizations detach-policy --profile flakehunter-mgmt --policy-id <freeze p-id> --target-id <flakehunter-account-id>
```

`flakehunter` account: let the API run again (this also restores normal unreserved concurrency). First look up the
function name, which is the `FunctionName` output of the `FlakeHunterApi` stack:

```bash
aws cloudformation describe-stacks --profile flakehunter --region us-east-2 --stack-name FlakeHunterApi --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text
```

Then remove the concurrency limit, using that name as `<FunctionName output>`:

```bash
aws lambda delete-function-concurrency --profile flakehunter --region us-east-2 --function-name <FunctionName output>
```

Do both only after fixing whatever caused the spend, or raise `monthlyBudgetUsd` and redeploy; the budget resets
on the first of the month.

### The same recovery as a script

`scripts/scp-rollback-freeze.sh` does both steps. Sign in to both accounts first (`aws login --profile flakehunter-mgmt`
and `aws login --profile flakehunter`). It checks both accounts before it changes either, finds the function name
from the stack's `FunctionName` output, and asks you to type `yes` (`--yes` skips the question).

See what it would do. This only reads from AWS:

```bash
bash scripts/scp-rollback-freeze.sh --dry-run
```

Lift the freeze and let the API run again:

```bash
bash scripts/scp-rollback-freeze.sh
```

It only removes a reserved concurrency of exactly 0, which is what the kill switch sets. A larger number is a cap you
chose with `-c reservedConcurrency=N`, so it stays. If only one part applies, `--scp-only` skips the `flakehunter`
account entirely and `--concurrency-only` skips the management account. Like the apply and rollback scripts it is
tested against a fake `aws`, not a real Organization, so run `--dry-run` first.

## Verifying what has not been tested

Claude validated the policy documents (Access Analyzer, no findings) and the CDK output (unit tests, `cdk synth`).
Nothing below has been run against a live account, so do it in this order, cheapest and safest first. `<fn>` means
the `FunctionName` stack output, and `<api>` the `ApiUrl` output.

An SCP denial reads `with an explicit deny in a service control policy`. If a call fails any other way, the SCP is
not the cause. SCP changes can take a few minutes to apply, so wait before concluding a test failed.

### A. Before attaching anything (management account)

| Check | Command | Expect |
| --- | --- | --- |
| You are in the management account | `aws sts get-caller-identity --profile flakehunter-mgmt` | account `<management-account-id>` |
| Room for one more SCP | `aws organizations list-policies-for-target --profile flakehunter-mgmt --target-id <flakehunter-account-id> --filter SERVICE_CONTROL_POLICY` | fewer than 5 policies (AWS-managed ones count) |
| The policy text is still valid | `aws accessanalyzer validate-policy --profile flakehunter-mgmt --policy-type SERVICE_CONTROL_POLICY --policy-document file://infra/scp/<file>.json` | `"findings": []` |
| The budget action syntax is right | `aws budgets create-budget-action help` | the README flags match the installed CLI; fix the README if not |

### B. Guardrails SCP, right after attaching it (from the `flakehunter` account)

1. **You are not locked out.** Run `aws sts get-caller-identity --profile flakehunter` and `aws lambda list-functions --profile flakehunter --region us-east-2`.
   Both must work. If anything essential fails, detach the policy (command above) and read the error.
2. **Region lock:** `aws lambda list-functions --profile flakehunter --region us-west-2` must be denied.
3. **Service allow-list:** `aws ec2 describe-instances --profile flakehunter --region us-east-2` must be denied (EC2 is not on the list).
4. **No IAM users:** `aws iam create-user --profile flakehunter --user-name scp-test` must be denied. If it succeeds, delete the user
   (`aws iam delete-user --profile flakehunter --user-name scp-test`) and re-check which policy is attached.
5. **Kill-switch protection** (test on a throwaway topic, so a failed test deletes nothing real):
   ```bash
   aws sns create-topic --profile flakehunter --region us-east-2 --name FlakeHunterApi-BudgetStopTopicScpTest
   aws sns delete-topic --profile flakehunter --region us-east-2 --topic-arn <the arn it printed>   # must be denied
   ```
   Creating works because only changes are blocked. The throwaway topic matches the same name pattern as the real
   one, so you cannot delete it either until the policy is detached: detach, delete it, re-attach.
6. **The deploy still works.** The CloudFormation execution role is subject to the Region and service rules, so run
   `bun run --cwd infra cdk diff --profile flakehunter` and then a deploy. Any `explicit deny in a service control policy` error names the
   action to add to the allow-list.

If a denial is unclear, find the call and its error in CloudTrail:
`aws cloudtrail lookup-events --profile flakehunter --region us-east-2 --lookup-attributes AttributeKey=EventName,AttributeValue=<EventName> --max-results 5`.

### C. Kill switch in the CDK stack (after deploying with `alertEmail`)

1. **The budget has three notifications, and the last one targets SNS:**
   `aws budgets describe-notifications-for-budget --profile flakehunter --account-id <flakehunter-account-id> --budget-name <name from describe-budgets>`
   then `describe-subscribers-for-notification` (same `--profile` and `--account-id`) for the 100% ACTUAL one. Expect an EMAIL and an SNS subscriber.
2. **The topic reaches the function.** Run `aws sns list-subscriptions-by-topic --profile flakehunter --topic-arn <BudgetStopTopic arn>`:
   one `lambda` subscription, with a confirmed (non-pending) ARN.
3. **The stop function works end to end** (this stops the real API, so do it when nothing depends on it). First look
   up the stop function's name. The stack generates the names of its functions and log groups, so there is no fixed
   `/aws/lambda/<name>` log group to guess:

   ```bash
   aws cloudformation list-stack-resources --profile flakehunter --region us-east-2 --stack-name FlakeHunterApi --query "StackResourceSummaries[?starts_with(LogicalResourceId,'BudgetStopFunction')&&ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text
   ```

   Then ask that function for its log group:

   ```bash
   aws lambda get-function-configuration --profile flakehunter --region us-east-2 --function-name <BudgetStopFunction name> --query LoggingConfig.LogGroup --output text
   ```

   Now run the test, using that log group as `<BudgetStopFunction log group>`:

   ```bash
   aws sns publish --profile flakehunter --region us-east-2 --topic-arn <BudgetStopTopic arn> --message test   # stands in for the budget
   aws lambda get-function-concurrency --profile flakehunter --region us-east-2 --function-name <fn>          # ReservedConcurrentExecutions: 0
   curl -i <api>/health                                                                  # now fails (expect a 5xx)
   aws logs tail --profile flakehunter --region us-east-2 <BudgetStopFunction log group> --since 5m           # "set to 0"
   aws lambda delete-function-concurrency --profile flakehunter --region us-east-2 --function-name <fn>       # undo
   curl -i <api>/health                                                                  # 200 again
   ```

   Publishing yourself works because the function ignores the message and your IAM permissions allow `sns:Publish`.
   If `get-function-concurrency` shows nothing, read that log group for an `AccessDenied` or a quota error. On an
   account whose quota leaves no room to reserve concurrency, setting it can be refused; "Stopping a flood" in
   `docs/deployment.md` explains the fallback.
4. **The real trigger (AWS Budgets publishing to the topic)** cannot be forced. Budget data refreshes only a few
   times a day, and a budget fires when real spend crosses the threshold. To test it once, deploy with
   `-c monthlyBudgetUsd=1` while the account already has more than $1 of month-to-date spend, wait for the next data
   refresh (up to about a day), confirm the function log shows the stop, then undo as above and redeploy at 30.
5. **The topic policy** (Budgets in this account only) is covered by the template tests; to confirm it live, run
   `aws sns get-topic-attributes --profile flakehunter --topic-arn <arn> --query Attributes.Policy` and check the `aws:SourceAccount` condition.

### D. Freeze SCP and the management-account budget

1. **Policy behaviour, attached by hand.** In a quiet moment attach `FlakeHunterBudgetFreeze` to the account
   (`attach-policy` as in step 1), wait a few minutes, then from the `flakehunter` account:
   - `aws lambda list-functions --profile flakehunter --region us-east-2`: works (read).
   - `aws lambda update-function-configuration --profile flakehunter --function-name <fn> --memory-size 1024`: denied (write).
   - `aws lambda put-function-concurrency --profile flakehunter --function-name <fn> --reserved-concurrent-executions 0`: works (the stop).
   - `aws lambda delete-function-concurrency --profile flakehunter --function-name <fn>`: works (recovery).
   - `aws sts get-caller-identity --profile flakehunter`: works.

   Then `detach-policy` and repeat the update call to confirm it is allowed again.
2. **The Budgets role.** Check that the role's trust policy names `budgets.amazonaws.com` and that it allows
   `organizations:AttachPolicy` and `organizations:DetachPolicy`:
   `aws iam get-role --profile flakehunter-mgmt --role-name FlakeHunterBudgetActionRole` and
   `aws iam list-role-policies --profile flakehunter-mgmt --role-name FlakeHunterBudgetActionRole` (the permission is an
   inline policy, so `list-attached-role-policies` would show nothing).
3. **The action exists and is wired as intended:**
   `aws budgets describe-budget-actions-for-budget --profile flakehunter-mgmt --account-id <management-account-id> --budget-name flakehunter-freeze`
   Expect `ActionType: APPLY_SCP_POLICY`, the freeze policy id, target `<flakehunter-account-id>`, `ApprovalModel: MANUAL`,
   threshold 100.
4. **Dry run of the trigger, without applying anything.** Create a copy of the budget at `$0.01` with the same
   action and `MANUAL` approval, wait for a data refresh, and confirm the action shows as **pending approval** in
   the Budgets console. Do not approve it. Delete the test budget afterwards
   (`aws budgets delete-budget --profile flakehunter-mgmt --account-id <management-account-id> --budget-name <test name>`). A pending action with the right
   policy and target is proof the wiring works. To prove the attach itself, approve it against a throwaway member
   account instead of `flakehunter`.
5. **Recovery.** Whenever the freeze has been attached, run the two recovery commands above and confirm a normal
   deploy works. Practise this once while nothing is wrong, so it is not the first time during an incident.

### E. Keeping it true

- After any CDK change to the services or to the Lambda or topic names, rerun B6. The name patterns in
  `ProtectBudgetKillSwitch` (`FlakeHunterApi-BudgetStopFunction*`, `FlakeHunterApi-BudgetStopTopic*`) must still match
  the real names: `aws lambda list-functions --profile flakehunter --query "Functions[].FunctionName"`.
- After changing a policy file, validate it again (A, third row) and update the attached policy with
  `aws organizations update-policy --profile flakehunter-mgmt --policy-id <id> --content file://infra/scp/<policy file>.json`.
