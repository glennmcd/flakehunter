#!/usr/bin/env bash
# Creates (or updates) the FlakeHunterGuardrails SCP from infra/scp/flakehunter-guardrails.json and attaches it to the
# flakehunter account. Run it with credentials for the MANAGEMENT account:
#
#   aws login --profile flakehunter-mgmt
#   bash scripts/scp-apply-guardrails.sh --dry-run     # read-only checks, then prints the plan
#   bash scripts/scp-apply-guardrails.sh               # asks before changing anything
#   bash scripts/scp-apply-guardrails.sh --yes         # no question (for scripts)
#
# Safe to run again: an existing policy is updated only if the file differs from what AWS holds (formatting is
# ignored), and an attachment that already exists is left alone. When there is nothing to change it says so and stops.
# It also stops without changing anything if the profile is not the management account or the account already has the
# maximum 5 SCPs attached. Undo with scripts/scp-rollback-guardrails.sh. Settings (profile, ids, file) are the FH_*
# variables described in scripts/scp-common.sh. Two of them are required, because the account ids are not stored in
# this repository: export FH_MGMT_ACCOUNT_ID and FH_SCP_TARGET_ID (12 digits each) first.

set -euo pipefail

FH_SCRIPT=scp-apply
# shellcheck source=scp-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/scp-common.sh"

fh_parse_flags "$@"
[ "${#FH_REST[@]}" -eq 0 ] || fh_die "unknown argument: ${FH_REST[0]} (usage: scp-apply-guardrails.sh [--dry-run] [--yes])"

fh_require_config
[ -f "$FH_SCP_FILE" ] || fh_die "policy file not found: $FH_SCP_FILE"
fh_require_aws
fh_check_management_account

content=$(cat "$FH_SCP_FILE")
policy_id=$(fh_find_policy_id)
attached=$(fh_attached_ids)

# Work out what has to change: create or update the policy, and attach it.
create=0
update=0
attach=0
if [ -z "$policy_id" ]; then
  create=1
  echo "Policy $FH_SCP_NAME does not exist: it will be created from $FH_SCP_FILE."
elif fh_policy_unchanged "$policy_id" "$content"; then
  echo "Policy $FH_SCP_NAME exists ($policy_id) and already matches $FH_SCP_FILE: no update needed."
else
  update=1
  echo "Policy $FH_SCP_NAME exists ($policy_id) and differs from $FH_SCP_FILE: it will be updated."
fi
if [ -n "$policy_id" ] && fh_has_id "$policy_id" "$attached"; then
  echo "It is already attached to $FH_SCP_TARGET_ID."
else
  attach=1
  # shellcheck disable=SC2086 # word splitting is the point: one word per attached id
  set -- $attached
  [ "$#" -lt "$FH_SCP_LIMIT" ] ||
    fh_die "$FH_SCP_TARGET_ID already has $# SCPs attached (the limit is $FH_SCP_LIMIT); detach one first. Nothing was changed."
  echo "It will be attached to $FH_SCP_TARGET_ID."
fi

if [ "$create" = 0 ] && [ "$update" = 0 ] && [ "$attach" = 0 ]; then
  echo "Nothing to do."
  exit 0
fi

fh_confirm "This changes the SCPs of account $FH_SCP_TARGET_ID."

if [ "$create" = 1 ]; then
  if [ "$FH_DRY_RUN" = 1 ]; then
    fh_run organizations create-policy
    policy_id="<new policy id>"
  else
    policy_id=$(fh_run organizations create-policy --type SERVICE_CONTROL_POLICY --name "$FH_SCP_NAME" \
      --description "FlakeHunter: us-east-2 only, allow-listed services" --content "$content" \
      --query Policy.PolicySummary.Id --output text)
    echo "Created $FH_SCP_NAME ($policy_id)."
  fi
elif [ "$update" = 1 ]; then
  if [ "$FH_DRY_RUN" = 1 ]; then
    fh_run organizations update-policy
  else
    fh_run organizations update-policy --policy-id "$policy_id" --content "$content" >/dev/null
    echo "Updated $FH_SCP_NAME ($policy_id)."
  fi
fi

if [ "$attach" = 1 ]; then
  fh_run organizations attach-policy --policy-id "$policy_id" --target-id "$FH_SCP_TARGET_ID"
  [ "$FH_DRY_RUN" = 1 ] || echo "Attached $policy_id to $FH_SCP_TARGET_ID. It can take a few minutes to take effect."
fi

echo "To undo: bash scripts/scp-rollback-guardrails.sh"
