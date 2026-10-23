#!/usr/bin/env bash
#
# Deploys a sitesolide project with a token, over HTTPS, without the CLI: the
# calls `sitesolide deploy` makes through the dashboard's control API, for a
# workstation or a sandbox that holds a token and nothing else.
#
#   export SITESOLIDE_API=https://dashboard.<zone>
#   read -rs SITESOLIDE_TOKEN && export SITESOLIDE_TOKEN   # typed, kept out of the history
#   bash deploy.sh [folder]
#   bash deploy.sh --archive <file> [folder]   build, write the archive, send nothing
#
# The folder is the one holding sitesolide.json, the current one by default.
# The run is the CLI's, step for step: the manifest goes first, so that the
# machine judges it and the token's scope before anything is built; then the
# build, here, never on the machine; then the archive, the code in app/ and
# the publicDir in public/, exactly what the CLI would send; then the
# machine's log, followed to the end. It exits 0 once the machine says the
# deployment succeeded, and non-zero otherwise. Kept outside the project, or
# the archive carries it.
#
# bash 3.2 or later, curl, tar (GNU or bsdtar), gzip, find, mktemp, and one
# JSON reader among jq, node, bun and python3, the first found: what a Mac or
# a Linux that builds a project already carries. No rsync, no Bun required.
#
# The token is a password. It never goes into an argument, which `ps` shows
# to every user of the machine: curl reads its header from a file descriptor.
# The build, which is the project's own code and its dependencies', runs
# without it in its environment, but as you all the same, with what you may
# read: a process of yours that holds the token in its own environment is
# one of them on Linux. Deploy, and run `--archive`, which builds too, only a
# project whose build you would run yourself.
#
# The archive's rules are bin/cli/remote.ts and bin/cli/bundle.ts, and
# bin/tests/deploy-script.test.ts holds this script to them: change one, and
# that test says whether the other followed.

# bash, whatever started it: `sh deploy.sh` is bash in POSIX mode on macOS
# and dash elsewhere, and neither reads what follows; macOS's would even exit
# 0 on the first line it cannot read, having done nothing.
if [ -z "${BASH_VERSION:-}" ] || [ -n "${POSIXLY_CORRECT:-}" ] || case ":${SHELLOPTS:-}:" in *:posix:*) true ;; *) false ;; esac; then
  if [ -n "${SITESOLIDE_DEPLOY_BASH:-}" ] || [ ! -f "$0" ]; then
    echo "deploy.sh: run it with bash: bash deploy.sh" >&2
    exit 1
  fi
  exec env -u SHELLOPTS -u POSIXLY_CORRECT SITESOLIDE_DEPLOY_BASH=1 bash "$0" "$@"
fi
set -euo pipefail
# A trace would print the token; a CDPATH would make `cd` print the folder
# it lands in, into the value of `$(cd ... && pwd -P)`.
case "$-" in *x*) set +x && echo "deploy.sh: tracing turned off, it would print the token" >&2 ;; esac
unset CDPATH

TOKEN_SHAPE='^sst_[A-Za-z0-9_-]{43}$'
HTTPS_ORIGIN='^https://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?$'
LOOPBACK_ORIGIN='^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$'
# What never leaves the workstation, whatever the manifest says, at any depth
# (NEVER_SENT in bin/cli/manifest.ts), and the folders of dependencies a
# project must exclude by name, since the machine installs its own
# (DEPENDENCIES there).
NEVER_SENT=(.git '.env*')
DEPENDENCIES=(node_modules .venv venv __pycache__)
# What the machine accepts (LIMITS in bin/cli/remote.ts).
MAX_ENTRIES=20000
MAX_EXTRACTED=$((512 * 1024 * 1024))
MAX_COMPRESSED=$((100 * 1024 * 1024))

fail() {
  echo "deploy.sh: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Deploys the sitesolide project in [folder], the current one by default, with a token.

  export SITESOLIDE_API=https://dashboard.<zone>
  read -rs SITESOLIDE_TOKEN && export SITESOLIDE_TOKEN   # typed, kept out of the history
  bash deploy.sh [folder]
  bash deploy.sh --archive <file> [folder]   build, write the archive, send nothing

SITESOLIDE_API   the dashboard's address, https://dashboard.<zone>
SITESOLIDE_TOKEN the token, sst_ then 43 characters, from the dashboard's Tokens page

Needs bash, curl, tar, gzip, find, mktemp, and one of jq, node, bun or python3.
EOF
}

archive_to=""
folder=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --archive)
      [ "$#" -ge 2 ] || fail "--archive takes the file to write"
      archive_to="$2"
      shift 2
      ;;
    -*) fail "unknown option $1: see bash deploy.sh --help" ;;
    *)
      [ -z "$folder" ] || fail "one folder at most: see bash deploy.sh --help"
      folder="$1"
      shift
      ;;
  esac
done
folder="${folder:-.}"
[ -d "$folder" ] || fail "no such folder: $folder"
folder="$(cd "$folder" && pwd -P)"
[ -f "$folder/sitesolide.json" ] || fail "sitesolide.json not found in $folder: run this from the project's folder, or name it"
if [ -n "$archive_to" ]; then
  case "$archive_to" in /*) ;; *) archive_to="$PWD/$archive_to" ;; esac
fi

# --- the tools -----------------------------------------------------------------

missing=()
for tool in tar gzip find mktemp; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[ -n "$archive_to" ] || command -v curl >/dev/null 2>&1 || missing+=(curl)
[ "${#missing[@]}" -eq 0 ] || fail "missing: ${missing[*]}"

# GNU tar and bsdtar say the same things with different words, and BusyBox's
# says too little: it reads no NUL-separated list.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  TAR_OPTIONS=(--format=pax --pax-option=delete=atime,delete=ctime,delete=mtime --owner=0 --group=0 --numeric-owner)
elif tar --version 2>/dev/null | grep -q 'bsdtar'; then
  TAR_OPTIONS=(--format=paxr --no-xattrs --no-acls --no-fflags --uid 0 --gid 0 --uname root --gname root)
else
  fail "tar is neither GNU tar nor bsdtar: install one of them"
fi

JSON=""
for candidate in jq node bun python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    JSON="$candidate"
    break
  fi
done
[ -n "$JSON" ] || fail "no JSON reader: install jq, or run this where node, bun or python3 is"

work="$(mktemp -d "${TMPDIR:-/tmp}/sitesolide-deploy.XXXXXX")"
# Best effort, and never the run's status: `cp -p` carries a file's flags and
# ACLs on macOS, and a file locked in the Finder would otherwise fail the
# cleanup, and a deployment that succeeded with it.
cleanup() {
  chflags -R nouchg "$work" 2>/dev/null || true
  chmod -R -N "$work" 2>/dev/null || true
  chmod -R u+w "$work" 2>/dev/null || true
  rm -rf "$work" 2>/dev/null || true
}
trap cleanup EXIT

# The value at a dotted path of the JSON on standard input: a string as it
# is, an array one element a line, anything else as JSON, nothing for null,
# an empty array or a path that leads nowhere. With `type` second, its type
# instead: string, number, boolean, array or object. Run from the work
# folder, never the project's, whose bunfig.toml or json.py would otherwise
# be read first. An empty input is no JSON, whatever jq makes of it.
json_get() {
  local path="$1" mode="${2:-value}" input
  input="$(cat; echo .)"
  input="${input%.}"
  [ -n "$input" ] || return 1
  case "$JSON" in
    jq)
      printf '%s' "$input" | (cd "$work" && jq -r --arg p "$path" --arg mode "$mode" '
        ($p | split(".") | map(select(. != ""))) as $k
        | (try getpath($k) catch null)
        | if . == null then empty
          elif $mode == "type" then type
          elif type == "array" then .[] | (if type == "string" then . else tojson end)
          elif type == "string" then .
          else tojson end')
      ;;
    node | bun)
      # The path travels in the environment: a `node` that is Bun under
      # another name, as Bun's own images ship it, numbers its arguments
      # otherwise.
      printf '%s' "$input" | (cd "$work" && SITESOLIDE_JSON_PATH="$path" SITESOLIDE_JSON_MODE="$mode" "$JSON" -e '
        let text = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
          let value = JSON.parse(text);
          for (const key of process.env.SITESOLIDE_JSON_PATH.split(".").filter((key) => key !== "")) {
            const object = value !== null && typeof value === "object" && !Array.isArray(value);
            value = object && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
          }
          if (value === undefined || value === null) return;
          if (process.env.SITESOLIDE_JSON_MODE === "type") {
            process.stdout.write((Array.isArray(value) ? "array" : typeof value) + "\n");
            return;
          }
          if (Array.isArray(value) && value.length === 0) return;
          const show = (item) => (typeof item === "string" ? item : JSON.stringify(item));
          process.stdout.write((Array.isArray(value) ? value.map(show) : [show(value)]).join("\n") + "\n");
        });')
      ;;
    python3)
      printf '%s' "$input" | (cd "$work" && python3 -I -c '
import json, sys
value = json.loads(sys.stdin.buffer.read().decode("utf-8"))
for key in [key for key in sys.argv[1].split(".") if key != ""]:
    value = value.get(key) if isinstance(value, dict) else None
def show(item):
    return item if isinstance(item, str) else json.dumps(item, separators=(",", ":"), ensure_ascii=False)
def kind(item):
    return {bool: "boolean", int: "number", float: "number", str: "string", list: "array", dict: "object"}[type(item)]
if value is not None and sys.argv[2] == "type":
    sys.stdout.write(kind(value) + "\n")
elif value is not None and value != []:
    lines = [show(item) for item in value] if isinstance(value, list) else [show(value)]
    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))' "$path" "$mode")
      ;;
  esac
}

# The request that opens a deployment: the manifest's text, as a JSON string,
# which the machine keeps as it was written, key order and all.
manifest_request() {
  case "$JSON" in
    jq) (cd "$work" && jq -Rs '{manifest: .}') ;;
    node | bun) (cd "$work" && "$JSON" -e 'let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => process.stdout.write(JSON.stringify({ manifest: text })));') ;;
    python3) (cd "$work" && python3 -I -c 'import json, sys; sys.stdout.write(json.dumps({"manifest": sys.stdin.buffer.read().decode("utf-8")}))') ;;
  esac
}

# --- the manifest --------------------------------------------------------------

manifest="$folder/sitesolide.json"
field() { json_get "$@" <"$manifest"; }
field slug >/dev/null 2>&1 || fail "sitesolide.json is not valid JSON"
slug="$(field slug)"
[ -n "$slug" ] || fail "sitesolide.json has no slug"
build="$(field build)"
public_dir="$(field publicDir)"
source_dir="$(field source)"
exclude=()
while IFS= read -r pattern; do exclude+=("$pattern"); done < <(field exclude)
# An app has a `start` that is a string, or `services` with at least one
# (isApp in bin/cli/manifest.ts): anything else sends public/ alone.
is_app=0
if [ "$(field start type)" = string ] && [ -n "$(field start)" ]; then is_app=1; fi
if [ "$(field services type)" = object ] && [ "$(field services)" != "{}" ]; then is_app=1; fi

# The repository holding the manifest: the nearest folder up with a .git, or
# the folder itself (repositoryRoot in bin/cli/source.ts).
repository_root() {
  local current="$1"
  while :; do
    [ -e "$current/.git" ] && { echo "$current"; return; }
    [ "$current" = / ] && { echo "$1"; return; }
    current="$(dirname "$current")"
  done
}
inside() {
  [ "$2" = / ] || [ "$1" = "$2" ] || [[ $1 == "$2"/* ]]
}
root="$(repository_root "$folder")"

# `source` and `publicDir`, links and all, stay inside that repository: a
# clone whose `public` was a link to ../../.ssh had the workstation's keys
# served at the site's address (bin/cli/source.ts).
code="$folder"
if [ -n "$source_dir" ]; then
  case "$source_dir" in /*) code="$source_dir" ;; *) code="$folder/$source_dir" ;; esac
  [ -d "$code" ] || fail "source not found: $source_dir"
  code="$(cd "$code" && pwd -P)"
  inside "$code" "$root" || fail "source leads outside the repository holding sitesolide.json: $code is not under $root"
fi

if [ "$is_app" = 1 ]; then
  forgotten=()
  for dependency in "${DEPENDENCIES[@]}"; do
    [ -e "$code/$dependency" ] || [ -L "$code/$dependency" ] || continue
    declared=0
    for pattern in ${exclude[@]+"${exclude[@]}"}; do [ "$pattern" = "$dependency" ] && declared=1; done
    [ "$declared" = 1 ] || forgotten+=("$dependency")
  done
  if [ "${#forgotten[@]}" -gt 0 ]; then
    list=""
    for name in "${forgotten[@]}"; do list="${list:+$list, }\"$name\""; done
    fail "exclude: ${forgotten[*]} present on disk and not excluded; add \"exclude\": [$list] to the manifest"
  fi
fi

# --- the API -------------------------------------------------------------------

API=""
PROTOCOL=""
PROXY=()
if [ -z "$archive_to" ]; then
  API="${SITESOLIDE_API:-}"
  API="${API%/}"
  [ -n "$API" ] || fail "SITESOLIDE_API is not set: the dashboard's address, https://dashboard.<zone>"
  if [[ $API =~ $HTTPS_ORIGIN ]]; then
    PROTOCOL="=https"
  elif [[ $API =~ $LOOPBACK_ORIGIN ]]; then
    PROTOCOL="=http"
    # In clear, a proxy would read the bearer; the loopback needs none.
    PROXY=(--noproxy '*')
  else
    fail "SITESOLIDE_API must be the dashboard's address alone, https://dashboard.<zone>: $API"
  fi
  [ -n "${SITESOLIDE_TOKEN:-}" ] || fail "SITESOLIDE_TOKEN is not set: the token, sst_ then 43 characters"
  [[ $SITESOLIDE_TOKEN =~ $TOKEN_SHAPE ]] || fail "SITESOLIDE_TOKEN is not a sitesolide token: it starts with sst_ and is 47 characters long"
fi

# One call: the answer's body in $work/answer, its status in STATUS. Non-zero
# when nothing came back. `-q` leaves ~/.curlrc unread, which could turn the
# certificate's check off; no redirect is followed, the token going to the
# dashboard and nowhere else; `-g` reads brackets in the address as brackets.
STATUS=""
call() {
  local method="$1" path="$2"
  shift 2
  STATUS="$(curl -q -sS -g --proto "$PROTOCOL" ${PROXY[@]+"${PROXY[@]}"} --connect-timeout 20 -X "$method" \
    -H @<(printf 'Authorization: Bearer %s\n' "$SITESOLIDE_TOKEN") \
    -o "$work/answer" -w '%{http_code}' "$@" "$API$path")" || return 1
}

# What the API said when it refused, then the end of the run.
refused() {
  local error message
  if ! error="$(json_get error <"$work/answer" 2>/dev/null)" || [ -z "$error" ]; then
    fail "$API answered $STATUS with something that is not the control API"
  fi
  message="$(json_get message <"$work/answer")"
  echo "deploy.sh: $message ($error, $STATUS)" >&2
  json_get details <"$work/answer" | sed 's/^/   /' >&2
  local wait
  wait="$(json_get wait <"$work/answer")"
  [ -z "$wait" ] || echo "   try again in $wait s" >&2
  exit 1
}

succeeded() {
  case "$STATUS" in 2??) return 0 ;; *) return 1 ;; esac
}

# A field of an answer the API accepted, which must be its JSON.
answer() {
  json_get "$1" <"$work/answer" 2>/dev/null || fail "$API answered $STATUS with something that is not the control API"
}

# --- the run -------------------------------------------------------------------

if [ -z "$archive_to" ]; then
  echo "-> project $slug, through $API"
  manifest_request <"$manifest" >"$work/request.json"
  call POST /api/v1/deployments --max-time 120 -H 'Content-Type: application/json' --data-binary @"$work/request.json" ||
    fail "$API unreachable"
  succeeded || refused
  deployment="$(answer deployment.id)"
  [[ $deployment =~ ^[A-Za-z0-9_-]+$ ]] || fail "$API answered $STATUS without a deployment"
  if [ "$(answer deployment.creating)" = true ]; then
    echo "   deployment $deployment, a new project"
  else
    echo "   deployment $deployment"
  fi
fi

if [ -n "$build" ]; then
  echo "-> build ($build)"
  (cd "$code" && env -u SITESOLIDE_TOKEN sh -c "$build") || fail "build failed: $build"
fi

if [ -n "$public_dir" ]; then
  [ -d "$code/$public_dir" ] || fail "publicDir not found: $public_dir (did the build run?)"
  public="$(cd "$code/$public_dir" && pwd -P)"
  inside "$public" "$root" || fail "publicDir leads outside the repository holding sitesolide.json: $public is not under $root"
  [ -n "$(ls -A "$public")" ] || fail "publicDir is empty: $public_dir"
fi

# --- the archive ---------------------------------------------------------------

# rsync's reading of an exclude pattern (isExcluded in bin/cli/bundle.ts), in
# three arrays: whether it matches the whole path, its end on a component
# boundary, or the last name alone; whether it wants a directory; and the
# extended regular expression its wildcards make.
PATTERN_KIND=()
PATTERN_DIRECTORY=()
PATTERN_REGEX=()

# A wildcard pattern as an extended regular expression, in REGEX: `*` stops
# at a slash, `**` does not, `?` is one character but a slash, `[...]` a class.
# Where the CLI and this differ, the cases are rare enough to name: `?` or a
# class against a name that is not ASCII, which this reads by the locale's
# characters (bytes, under C) and the CLI by UTF-16 units, and a class that
# holds `[:alpha:]` or starts with `]`, which the two read otherwise.
glob_regex() {
  local pattern="$1" i=0 character rest inner
  REGEX="^"
  while [ "$i" -lt "${#pattern}" ]; do
    character="${pattern:$i:1}"
    case "$character" in
      '*')
        if [ "${pattern:$((i + 1)):1}" = '*' ]; then
          REGEX+='.*'
          i=$((i + 1))
        else
          REGEX+='[^/]*'
        fi
        ;;
      '?') REGEX+='[^/]' ;;
      '[')
        rest="${pattern:$((i + 1))}"
        if [[ $rest == *']'* ]]; then
          inner="${rest%%]*}"
          i=$((i + ${#inner} + 1))
          [[ $inner == '!'* ]] && inner="^${inner:1}"
          REGEX+="[$inner]"
        else
          REGEX+='\['
        fi
        ;;
      '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '\') REGEX+="\\$character" ;;
      *) REGEX+="$character" ;;
    esac
    i=$((i + 1))
  done
  REGEX+='$'
}

compile() {
  PATTERN_KIND=()
  PATTERN_DIRECTORY=()
  PATTERN_REGEX=()
  local pattern wanted directory kind
  for pattern in "$@"; do
    wanted="${pattern#"${pattern%%[![:space:]]*}"}"
    wanted="${wanted%"${wanted##*[![:space:]]}"}"
    [ -n "$wanted" ] || continue
    directory=0
    if [[ $wanted == */ ]]; then
      directory=1
      while [[ $wanted == */ ]]; do wanted="${wanted%/}"; done
    fi
    if [[ $wanted == /* ]]; then
      kind=whole
      wanted="${wanted:1}"
    elif [[ $wanted == */* || $wanted == *'**'* ]]; then
      kind=end
    else
      kind=name
    fi
    glob_regex "$wanted"
    PATTERN_KIND+=("$kind")
    PATTERN_DIRECTORY+=("$directory")
    PATTERN_REGEX+=("$REGEX")
  done
}

# Does a compiled pattern leave out this path, relative to the tree's root?
excluded() {
  local path="$1" directory="$2" i tail
  for ((i = 0; i < ${#PATTERN_REGEX[@]}; i++)); do
    [ "${PATTERN_DIRECTORY[$i]}" = 1 ] && [ "$directory" = 0 ] && continue
    case "${PATTERN_KIND[$i]}" in
      whole) [[ $path =~ ${PATTERN_REGEX[$i]} ]] && return 0 ;;
      name) [[ ${path##*/} =~ ${PATTERN_REGEX[$i]} ]] && return 0 ;;
      end)
        tail="$path"
        while :; do
          [[ $tail =~ ${PATTERN_REGEX[$i]} ]] && return 0
          [[ $tail == */* ]] || break
          tail="${tail#*/}"
        done
        ;;
    esac
  done
  return 1
}

# One tree copied into the stage, $work/stage/<tree>, as the CLI reads it: a
# directory made before what it holds, the files of each directory copied by
# `cp -p`, which keeps their modes and dates and copies a file with hard links
# apart, since the CLI sends each name as a file and the machine refuses a
# link. What a pattern excludes is not read at all; a link or a special file
# is refused, as the machine refuses them, and named in $work/refused.
#
# cp rather than a tar into another tar: macOS's tar drops a path longer than
# ustar holds with a warning and a success, and writes a name it reads back
# from a pax record decomposed, `café.txt` reaching the machine as another
# name than the one the site links to.
ENTRIES=0
walk() {
  local root="$1" relative="$2" tree="$3" path name inner directory start=0
  local files=()
  for path in "$root${relative:+/$relative}"/*; do
    name="${path##*/}"
    inner="${relative:+$relative/}$name"
    directory=0
    if [ ! -L "$path" ] && [ -d "$path" ]; then directory=1; fi
    excluded "$inner" "$directory" && continue
    if [ -L "$path" ]; then
      echo "$tree/$inner is a symbolic link" >>"$work/refused"
    elif [ "$directory" = 1 ]; then
      ENTRIES=$((ENTRIES + 1))
      mkdir "$work/stage/$tree/$inner"
      walk "$root" "$inner" "$tree"
    elif [ -f "$path" ]; then
      ENTRIES=$((ENTRIES + 1))
      files+=("$path")
    else
      echo "$tree/$inner is not a regular file" >>"$work/refused"
    fi
  done
  while [ "$start" -lt "${#files[@]}" ]; do
    cp -p "${files[@]:$start:500}" "$work/stage/$tree${relative:+/$relative}/"
    start=$((start + 500))
  done
}

echo "-> archive"
shopt -s dotglob nullglob
: >"$work/refused"
trees=()
if [ "$is_app" = 1 ]; then
  patterns=(${exclude[@]+"${exclude[@]}"} "${NEVER_SENT[@]}" sitesolide.json)
  [ -z "$public_dir" ] || patterns+=("$public_dir")
  compile "${patterns[@]}"
  mkdir -p "$work/stage/app"
  walk "$code" "" app
  trees+=(app)
fi
if [ -n "$public_dir" ]; then
  compile "${NEVER_SENT[@]}"
  mkdir -p "$work/stage/public"
  walk "$public" "" public
  trees+=(public)
fi
shopt -u dotglob nullglob
[ "${#trees[@]}" -gt 0 ] || fail "nothing to send: a project without start or services declares publicDir"
if [ -s "$work/refused" ]; then
  echo "deploy.sh: the machine refuses links and special files in the archive" >&2
  head -n 10 "$work/refused" | sed 's/^/   /' >&2
  echo "   replace them with the files they point to, or exclude them in sitesolide.json" >&2
  exit 1
fi

entries=$((ENTRIES + ${#trees[@]}))
files="$(find "$work/stage" -type f | wc -l | tr -d ' ')"
bytes="$(find "$work/stage" -type f -print0 | xargs -0 cat | wc -c | tr -d ' ')"
if [ "$entries" -gt "$MAX_ENTRIES" ] || [ "$bytes" -gt "$MAX_EXTRACTED" ]; then
  fail "$entries entries, $bytes bytes: over what the machine accepts ($MAX_ENTRIES entries, 512 MiB); exclude dependencies and caches in sitesolide.json: the machine installs dependencies itself"
fi
# pax, which carries any path the machine accepts, in an extended header only
# for the entries that need one, as the CLI writes it: a header for every
# entry would take the machine's room for 20,000 of them. Without a word about
# the workstation either: no extended attributes, flags, ACLs, access or
# change times, and root as the owner. Any warning of tar's stops the run,
# since a tar that leaves a file out may still succeed.
if ! (cd "$work/stage" && COPYFILE_DISABLE=1 tar -czf "$work/bundle.tar.gz" "${TAR_OPTIONS[@]}" "${trees[@]}") 2>"$work/tar.err" ||
  [ -s "$work/tar.err" ]; then
  echo "deploy.sh: tar could not write the archive" >&2
  sed 's/^/   /' "$work/tar.err" >&2
  exit 1
fi
compressed="$(wc -c <"$work/bundle.tar.gz" | tr -d ' ')"
[ "$compressed" -le "$MAX_COMPRESSED" ] || fail "the archive is $compressed bytes compressed, over 100 MiB"
echo "   $files file(s), $bytes bytes, $compressed compressed"

if [ -n "$archive_to" ]; then
  cp "$work/bundle.tar.gz" "$archive_to"
  echo "-> written to $archive_to, nothing sent"
  exit 0
fi

echo "-> upload"
call PUT "/api/v1/deployments/$deployment/bundle" -H 'Content-Type: application/gzip' -H 'Expect:' --upload-file "$work/bundle.tar.gz" ||
  fail "$API unreachable during the upload: run this again, deployment $deployment expires on its own"
succeeded || refused

# The machine's log, as it is written, until the end. A lost answer is asked
# again, for two minutes; the deployment goes on on the machine whatever
# happens here.
next=0
lost=""
while :; do
  if ! call GET "/api/v1/deployments/$deployment?after=$next" --max-time 30; then
    lost="${lost:-$SECONDS}"
    [ $((SECONDS - lost)) -lt 120 ] || fail "$API unreachable for two minutes: deployment $deployment goes on on the machine, GET /api/v1/deployments/$deployment says how it ends"
    sleep 1
    continue
  fi
  lost=""
  succeeded || refused
  answer deployment.log
  next="$(answer deployment.next)"
  state="$(answer deployment.state)"
  case "$state" in
    succeeded)
      answer deployment.allocated >"$work/allocated"
      while IFS= read -r chosen; do
        [ -n "$chosen" ] || continue
        port="$(printf '%s' "$chosen" | json_get port)"
        service="$(printf '%s' "$chosen" | json_get service)"
        echo "   the machine chose port $port${service:+ for $service}: write it in sitesolide.json to keep it explicit"
      done <"$work/allocated"
      exit 0
      ;;
    failed)
      code="$(answer deployment.error.code)"
      message="$(answer deployment.error.message)"
      fail "${message:-the deployment ended failed} (${code:-failed})"
      ;;
    expired)
      fail "$(answer deployment.error.message) (expired): run this again"
      ;;
  esac
  sleep 1
done
