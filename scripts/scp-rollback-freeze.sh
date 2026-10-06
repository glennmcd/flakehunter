#!/usr/bin/env bash
# Undoes a budget freeze in two steps:
#   1. detaches the FlakeHunterBudgetFreeze SCP from the g26work account       (management account credentials)
#   2. removes the API function's reserved concurrency of 0, set by the budget kill switch, so it runs again
#                                                                               (g26work account credentials)
#
#   aws login --profile g26work-mgmt
#   aws login --profile g26work
#   bash scripts/scp-rollback-freeze.sh --dry-run        # read-only checks in both accounts, then prints the plan
#   bash scripts/scp-rollback-freeze.sh                  # asks before changing anything
#   bash scripts/scp-rollback-freeze.sh --scp-only       # only lift the SCP (needs no flakehunter sign-in)
#   bash scripts/scp-rollback-freeze.sh --concurrency-only
#
# Do this only after fixing whatever caused the spend, or raise monthlyBudgetUsd and redeploy, because the budget will
# stop the API again as soon as it is still over its limit. Every check in both accounts runs before anything changes.
# Only a reserved concurrency of exactly 0 is removed: a larger number is a cap you set with `-c reservedConcurrency=N`
# and stays. Safe to run again. Export FH_MGMT_ACCOUNT_ID and FH_SCP_TARGET_ID (12 digits each) first: the account ids
# are not stored in this repository. Settings are the FH_* variables described in scripts/scp-common.sh, plus
# FH_FREEZE_SCP_NAME (default FlakeHunterBudgetFreeze).

set -euo pipefail

FH_SCRIPT=scp-rollback-freeze
# shellcheck source=scp-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/scp-common.sh"
FH_SCP_NAME=${FH_FREEZE_SCP_NAME:-FlakeHunterBudgetFreeze}

fh_parse_flags "$@"
do_scp=1
do_concurrency=1
for arg in "${FH_REST[@]+"${FH_REST[@]}"}"; do
  case $arg in
    --scp-only) do_concurrency=0 ;;
    --concurrency-only) do_scp=0 ;;
    *) fh_die "unknown argument: $arg (usage: scp-rollback-freeze.sh [--dry-run] [--yes] [--scp-only | --concurrency-only])" ;;
  esac
done
[ "$do_scp" = 1 ] || [ "$do_concurrency" = 1 ] || fh_die "--scp-only and --concurrency-only cannot be used together"

fh_require_config
fh_require_aws

detach=0
reset=0

if [ "$do_scp" = 1 ]; then
  fh_check_management_account
  policy_id=$(fh_find_policy_id)
  attached=$(fh_attached_ids) # its own line: a failure here must stop the script, which an elif condition would hide
  if [ -z "$policy_id" ]; then
    echo "SCP: policy $FH_SCP_NAME does not exist, so there is no freeze to lift."
  elif fh_has_id "$policy_id" "$attached"; then
    detach=1
    echo "SCP: $FH_SCP_NAME ($policy_id) will be detached from $FH_SCP_TARGET_ID."
  else
    echo "SCP: $FH_SCP_NAME ($policy_id) is not attached to $FH_SCP_TARGET_ID."
  fi
fi

if [ "$do_concurrency" = 1 ]; then
  fh_check_app_account
  function_name=$(fh_aws_app cloudformation describe-stacks --stack-name "$FH_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text) ||
    fh_die "could not read stack $FH_STACK_NAME in $FH_APP_REGION"
  { [ -n "$function_name" ] && [ "$function_name" != "None" ]; } ||
    fh_die "stack $FH_STACK_NAME has no FunctionName output"
  concurrency=$(fh_aws_app lambda get-function-concurrency --function-name "$function_name" \
    --query ReservedConcurrentExecutions --output text) || fh_die "could not read the concurrency of $function_name"
  case $concurrency in
    0)
      reset=1
      echo "Concurrency: $function_name is set to 0 (stopped): the limit will be removed."
      ;;
    None | "")
      echo "Concurrency: $function_name has no reserved concurrency, so it is not stopped."
      ;;
    *)
      echo "Concurrency: $function_name is limited to $concurrency, not 0, so the kill switch did not set it: left alone."
      ;;
  esac
fi

if [ "$detach" = 0 ] && [ "$reset" = 0 ]; then
  echo "Nothing to roll back."
  exit 0
fi

fh_confirm "This lifts the freeze on account $FH_SCP_TARGET_ID."

if [ "$detach" = 1 ]; then
  fh_run organizations detach-policy --policy-id "$policy_id" --target-id "$FH_SCP_TARGET_ID"
  [ "$FH_DRY_RUN" = 1 ] || echo "Detached $policy_id from $FH_SCP_TARGET_ID. It can take a few minutes to take effect."
fi
if [ "$reset" = 1 ]; then
  fh_run_app lambda delete-function-concurrency --function-name "$function_name"
  [ "$FH_DRY_RUN" = 1 ] || echo "Removed the concurrency limit of $function_name; the API serves requests again."
fi

echo "If you deployed with -c reservedConcurrency=N, redeploy to put that cap back."
