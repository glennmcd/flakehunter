# Loads one variable from a dotenv-style file into the current shell's environment.
#
# Source it (a script that is run instead of sourced cannot change its parent shell's environment):
#
#   . scripts/load-env.sh API_TOKEN                    # reads apps/api/.env
#   . scripts/load-env.sh API_BASE_URL apps/web/.env.local
#
# The file is parsed, never executed. The last NAME=value line wins; one pair of surrounding quotes is removed and
# an unquoted value stops at " #". Nothing is printed on success, and the value never appears in an error message.
# Returns 1 (and leaves the variable alone) if the name is invalid, the file is unreadable or the name is not in it.

# Running this file instead of sourcing it would set the variable in a child process that then exits, so fail loudly.
# `(return 0)` succeeds only inside a sourced file.
if ! (return 0 2>/dev/null); then
  echo "load-env: this script must be sourced, not run, or the variable is lost when it exits." >&2
  echo "load-env: use:  . scripts/load-env.sh VAR_NAME [FILE]" >&2
  exit 1
fi

_fh_load_env() {
  _fh_name=$1
  _fh_file=${2:-apps/api/.env}

  case $_fh_name in
    '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "load-env: usage: . scripts/load-env.sh VAR_NAME [FILE] (VAR_NAME must be a valid variable name)" >&2
      return 1
      ;;
  esac
  if [ ! -r "$_fh_file" ]; then
    echo "load-env: cannot read $_fh_file" >&2
    return 1
  fi

  _fh_line=$(tr -d '\r' <"$_fh_file" | grep -E "^[[:space:]]*(export[[:space:]]+)?${_fh_name}=" | tail -n 1)
  if [ -z "$_fh_line" ]; then
    echo "load-env: $_fh_name is not set in $_fh_file" >&2
    return 1
  fi

  _fh_value=${_fh_line#*=}
  case $_fh_value in
    \"*\") _fh_value=${_fh_value#\"}; _fh_value=${_fh_value%\"} ;;
    \'*\') _fh_value=${_fh_value#\'}; _fh_value=${_fh_value%\'} ;;
    *) _fh_value=$(printf '%s' "$_fh_value" | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//') ;;
  esac

  export "$_fh_name=$_fh_value"
}

_fh_load_env "$@"
_fh_status=$?
unset -f _fh_load_env
unset _fh_name _fh_file _fh_line _fh_value
return "$_fh_status"
