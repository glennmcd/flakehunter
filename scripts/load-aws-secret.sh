# Loads one FlakeHunter secret from AWS SSM Parameter Store into the current shell's environment.
#
# Source it (a script that is run instead of sourced cannot change its parent shell's environment):
#
#   . scripts/load-aws-secret.sh API_TOKEN
#
# It reads the SecureString parameter <prefix><NAME> (default /flakehunter/demo/API_TOKEN), decrypts it and exports
# it as NAME. Nothing is printed on success, and the value never appears in an error message. You must be signed in
# first (see docs/deployment.md: `aws login --region us-east-2 --profile g26work`).
#
# Override the defaults with environment variables:
#   FH_AWS_PROFILE  AWS CLI profile            (default: g26work)
#   FH_AWS_REGION   Region of the parameters   (default: us-east-2, the project's Region)
#   FH_SSM_PREFIX   parameter path prefix      (default: /flakehunter/demo/, must start and end with /)
#
# Returns 1 (and leaves the variable alone) if the name is invalid, the aws CLI fails or the parameter is empty.

if ! (return 0 2>/dev/null); then
  echo "load-aws-secret: this script must be sourced, not run, or the variable is lost when it exits." >&2
  echo "load-aws-secret: use:  . scripts/load-aws-secret.sh VAR_NAME" >&2
  exit 1
fi

_fh_load_aws_secret() {
  _fh_name=$1
  _fh_prefix=${FH_SSM_PREFIX:-/flakehunter/demo/}

  case $_fh_name in
    '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "load-aws-secret: usage: . scripts/load-aws-secret.sh VAR_NAME (VAR_NAME must be a valid variable name)" >&2
      return 1
      ;;
  esac
  case $_fh_prefix in
    /*/) ;;
    *)
      echo "load-aws-secret: FH_SSM_PREFIX must start and end with /" >&2
      return 1
      ;;
  esac
  if ! command -v aws >/dev/null 2>&1; then
    echo "load-aws-secret: the aws CLI is not installed or not on PATH" >&2
    return 1
  fi

  # MSYS_NO_PATHCONV stops Git Bash from rewriting the leading "/" of the parameter name into a Windows path.
  # Only the CLI's error output is shown on failure: it names the parameter, never its value.
  if ! _fh_value=$(
    MSYS_NO_PATHCONV=1 aws ssm get-parameter \
      --name "$_fh_prefix$_fh_name" --with-decryption \
      --query Parameter.Value --output text \
      --profile "${FH_AWS_PROFILE:-g26work}" --region "${FH_AWS_REGION:-us-east-2}"
  ); then
    echo "load-aws-secret: could not read $_fh_prefix$_fh_name (signed in? try: aws login --profile ${FH_AWS_PROFILE:-g26work})" >&2
    return 1
  fi
  if [ -z "$_fh_value" ] || [ "$_fh_value" = "None" ]; then
    echo "load-aws-secret: $_fh_prefix$_fh_name is empty" >&2
    return 1
  fi

  export "$_fh_name=$_fh_value"
}

_fh_load_aws_secret "$@"
_fh_status=$?
unset -f _fh_load_aws_secret
unset _fh_name _fh_prefix _fh_value
return "$_fh_status"
