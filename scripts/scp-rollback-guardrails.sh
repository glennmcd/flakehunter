#!/usr/bin/env bash
# Detaches the FlakeHunterGuardrails SCP from the flakehunter account, which lifts its restrictions. Run it with
# credentials for the MANAGEMENT account:
#
#   aws login --profile flakehunter-mgmt
#   bash scripts/scp-rollback-guardrails.sh --dry-run    # read-only checks, then prints the plan
#   bash scripts/scp-rollback-guardrails.sh              # asks before changing anything
#   bash scripts/scp-rollback-guardrails.sh --delete     # also deletes the policy afterwards
#
# By default the policy itself is kept, so scripts/scp-apply-guardrails.sh can attach it again. --delete removes it
# for good; AWS refuses that while the policy is still attached to anything else. Stops without changing anything if the
# profile is not the management account. Safe to run again: a policy that is missing or already detached is not an
# error. Settings (profile, ids) are the FH_* variables described in scripts/scp-common.sh.

set -euo pipefail

FH_SCRIPT=scp-rollback
# shellcheck source=scp-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/scp-common.sh"

fh_parse_flags "$@"
delete=0
for arg in "${FH_REST[@]+"${FH_REST[@]}"}"; do
  case $arg in
    --delete) delete=1 ;;
    *) fh_die "unknown argument: $arg (usage: scp-rollback-guardrails.sh [--dry-run] [--yes] [--delete])" ;;
  esac
done

fh_require_aws
fh_check_management_account

policy_id=$(fh_find_policy_id)
if [ -z "$policy_id" ]; then
  echo "Policy $FH_SCP_NAME does not exist, so there is nothing to roll back."
  exit 0
fi
attached=$(fh_attached_ids)

detach=0
if fh_has_id "$policy_id" "$attached"; then
  detach=1
  echo "Policy $FH_SCP_NAME ($policy_id) will be detached from $FH_SCP_TARGET_ID."
else
  echo "Policy $FH_SCP_NAME ($policy_id) is not attached to $FH_SCP_TARGET_ID."
fi
[ "$delete" = 0 ] || echo "The policy will then be deleted."
[ "$detach" = 1 ] || [ "$delete" = 1 ] || exit 0

fh_confirm "This changes the SCPs of account $FH_SCP_TARGET_ID."

if [ "$detach" = 1 ]; then
  fh_run organizations detach-policy --policy-id "$policy_id" --target-id "$FH_SCP_TARGET_ID"
  [ "$FH_DRY_RUN" = 1 ] || echo "Detached $policy_id from $FH_SCP_TARGET_ID. It can take a few minutes to take effect."
fi
if [ "$delete" = 1 ]; then
  fh_run organizations delete-policy --policy-id "$policy_id"
  [ "$FH_DRY_RUN" = 1 ] || echo "Deleted $FH_SCP_NAME ($policy_id)."
fi
