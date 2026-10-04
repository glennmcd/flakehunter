# Shared by scp-apply-guardrails.sh and scp-rollback-guardrails.sh. Sourced, never run on its own.
#
# Everything here talks to AWS Organizations, so it must run with credentials for the MANAGEMENT account (SCPs can only
# be created and attached there).
#
# Two AWS account ids are REQUIRED. They are not stored in this repository; export them before running a script:
#   export FH_MGMT_ACCOUNT_ID=<management-account-id>    the management account, checked before anything changes
#   export FH_SCP_TARGET_ID=<flakehunter-account-id>     the account the policy is attached to
# Each must be 12 digits. A script stops with a message naming the variable if one is missing or malformed.
#
# Everything else has a default that an environment variable overrides:
#   FH_MGMT_PROFILE     AWS CLI profile of the management account   (default: flakehunter-mgmt)
#   FH_MGMT_REGION      Region to pass to the CLI; unset uses the profile's own (Organizations is global, us-east-1)
#   FH_SCP_NAME         the policy's name                          (default: FlakeHunterGuardrails)
#   FH_SCP_FILE         the policy document            (default: infra/scp/flakehunter-guardrails.json in this repo)

FH_MGMT_PROFILE=${FH_MGMT_PROFILE:-flakehunter-mgmt}
FH_SCP_NAME=${FH_SCP_NAME:-FlakeHunterGuardrails}
FH_SCP_FILE=${FH_SCP_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/scp/flakehunter-guardrails.json}
# Only scp-rollback-freeze.sh also touches the flakehunter account itself (the API function's concurrency):
#   FH_APP_PROFILE      AWS CLI profile of the flakehunter account  (default: flakehunter)
#   FH_APP_REGION       Region of the stack                         (default: us-east-2)
#   FH_APP_ACCOUNT_ID   the flakehunter account id, checked first   (default: FH_SCP_TARGET_ID, the same account)
#   FH_STACK_NAME       the API stack whose FunctionName output names the function (default: FlakeHunterApi)
FH_APP_PROFILE=${FH_APP_PROFILE:-flakehunter}
FH_APP_REGION=${FH_APP_REGION:-us-east-2}
FH_STACK_NAME=${FH_STACK_NAME:-FlakeHunterApi}
FH_SCP_LIMIT=5 # AWS allows at most 5 SCPs attached directly to one account
FH_ASSUME_YES=0
FH_DRY_RUN=0

fh_die() {
  echo "$FH_SCRIPT: $*" >&2
  exit 1
}

# Stops unless the account ids are given, as 12 digits. They come from the environment, never from this repository.
# Call it before anything talks to AWS. FH_APP_ACCOUNT_ID, the flakehunter account, defaults to FH_SCP_TARGET_ID.
fh_require_config() {
  [ -n "${FH_MGMT_ACCOUNT_ID:-}" ] ||
    fh_die "FH_MGMT_ACCOUNT_ID is not set. Set it to the management account's id: export FH_MGMT_ACCOUNT_ID=<12-digit account id>"
  [ -n "${FH_SCP_TARGET_ID:-}" ] ||
    fh_die "FH_SCP_TARGET_ID is not set. Set it to the flakehunter account's id: export FH_SCP_TARGET_ID=<12-digit account id>"
  FH_APP_ACCOUNT_ID=${FH_APP_ACCOUNT_ID:-$FH_SCP_TARGET_ID}

  local name
  for name in FH_MGMT_ACCOUNT_ID FH_SCP_TARGET_ID FH_APP_ACCOUNT_ID; do
    [[ ${!name} =~ ^[0-9]{12}$ ]] || fh_die "$name must be exactly 12 digits"
  done
}

# The aws CLI against the management account. `tr` drops the carriage returns a Windows aws.exe adds to its output.
fh_aws() {
  aws --profile "$FH_MGMT_PROFILE" ${FH_MGMT_REGION:+--region "$FH_MGMT_REGION"} "$@" | tr -d '\r'
}

# The aws CLI against the flakehunter account.
fh_aws_app() {
  aws --profile "$FH_APP_PROFILE" --region "$FH_APP_REGION" "$@" | tr -d '\r'
}

# A change to AWS. With --dry-run it only says which call it would make (never the policy text).
fh_run() {
  if [ "$FH_DRY_RUN" = 1 ]; then
    echo "[dry-run] would run: aws $1 $2"
  else
    fh_aws "$@"
  fi
}

# The same as fh_run, for a change in the flakehunter account.
fh_run_app() {
  if [ "$FH_DRY_RUN" = 1 ]; then
    echo "[dry-run] would run: aws $1 $2"
  else
    fh_aws_app "$@"
  fi
}

# Parses the flags the scripts share. Anything else is left in FH_REST for the caller.
fh_parse_flags() {
  FH_REST=()
  for _fh_arg in "$@"; do
    case $_fh_arg in
      --yes | -y) FH_ASSUME_YES=1 ;;
      --dry-run) FH_DRY_RUN=1 ;;
      *) FH_REST+=("$_fh_arg") ;;
    esac
  done
}

fh_require_aws() {
  command -v aws >/dev/null 2>&1 || fh_die "the aws CLI is not installed or not on PATH"
}

# Refuses to go on unless the credentials belong to the management account, so a mistake in the profile cannot send
# these calls to the flakehunter account, where Organizations calls fail or, worse, target something else.
fh_check_management_account() {
  local account
  account=$(fh_aws sts get-caller-identity --query Account --output text) ||
    fh_die "could not get the caller identity (signed in? try: aws login --profile $FH_MGMT_PROFILE)"
  [ "$account" = "$FH_MGMT_ACCOUNT_ID" ] ||
    fh_die "profile $FH_MGMT_PROFILE is account $account, not the management account $FH_MGMT_ACCOUNT_ID; nothing was changed"
}

# The same check for the flakehunter account, before anything is changed there.
fh_check_app_account() {
  local account
  account=$(fh_aws_app sts get-caller-identity --query Account --output text) ||
    fh_die "could not get the caller identity (signed in? try: aws login --profile $FH_APP_PROFILE)"
  [ "$account" = "$FH_APP_ACCOUNT_ID" ] ||
    fh_die "profile $FH_APP_PROFILE is account $account, not the flakehunter account $FH_APP_ACCOUNT_ID; nothing was changed"
}

# The id of the policy named FH_SCP_NAME, or nothing if it does not exist.
fh_find_policy_id() {
  local id
  id=$(fh_aws organizations list-policies --filter SERVICE_CONTROL_POLICY \
    --query "Policies[?Name=='$FH_SCP_NAME'].Id | [0]" --output text) || fh_die "could not list the SCPs"
  [ "$id" = "None" ] && id=""
  echo "$id"
}

# The ids of the SCPs attached directly to the target account, space separated (AWS-managed ones included).
fh_attached_ids() {
  local ids
  ids=$(fh_aws organizations list-policies-for-target --target-id "$FH_SCP_TARGET_ID" \
    --filter SERVICE_CONTROL_POLICY --query "Policies[].Id" --output text) ||
    fh_die "could not list the SCPs attached to $FH_SCP_TARGET_ID"
  [ "$ids" = "None" ] && ids=""
  # `--output text` separates a list with tabs; use spaces so fh_has_id and the caller's word splitting agree.
  echo "${ids//$'\t'/ }"
}

# Succeeds if policy $1 already holds the JSON text $2. Whitespace is ignored, so reformatting the file is not a change;
# anything else, including the order of keys, is.
fh_policy_unchanged() {
  local current
  current=$(fh_aws organizations describe-policy --policy-id "$1" --query Policy.Content --output text) ||
    fh_die "could not read the current text of policy $1"
  [ "$(printf '%s' "$current" | tr -d ' \t\r\n')" = "$(printf '%s' "$2" | tr -d ' \t\r\n')" ]
}

# Succeeds if $1 is one of the ids in $2 (separated by spaces or tabs).
fh_has_id() {
  local list=" ${2//$'\t'/ } "
  case $list in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Asks before changing anything, unless --yes (or --dry-run, which changes nothing) was given.
fh_confirm() {
  [ "$FH_ASSUME_YES" = 1 ] || [ "$FH_DRY_RUN" = 1 ] && return 0
  [ -t 0 ] || fh_die "no terminal to ask on; re-run with --yes to go ahead (or --dry-run to see the plan)"
  printf '%s Type yes to continue: ' "$1"
  local reply
  read -r reply
  [ "$reply" = yes ] || fh_die "aborted; nothing was changed"
}
