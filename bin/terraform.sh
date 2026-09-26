#!/usr/bin/env bash
#
# Runs Terraform on infra/ with the installation's own values and state, kept
# in ~/.config/sitesolide/terraform/, outside every repository.
#
#   bin/terraform.sh init        once, and after a provider upgrade
#   bin/terraform.sh plan
#   bin/terraform.sh apply
#   bin/terraform.sh <any other terraform command>
#
# infra/ holds the code, which anyone may read. The values name your zone,
# your account and your SSH key, the tokens reach your Hetzner project and your
# Cloudflare zone, and the state carries your machine's address: none of it
# belongs in a repository, not even ignored by one. Terraform only reads a
# *.auto.tfvars from the directory it runs in and keeps its state there, so
# this script tells it where they live instead.
#
# It requires no configuration of the CLI, and must not: it is what creates the
# machine whose address `sitesolide init` then records.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"

DIR="$SITESOLIDE_TERRAFORM_DIR"
VALUES="$DIR/terraform.tfvars"
mkdir -p "$DIR"
chmod 700 "$DIR"

case "${1:-}" in
  "")
    echo "usage: bin/terraform.sh <terraform command> [arguments]" >&2
    exit 2
    ;;
  init)
    shift
    exec terraform -chdir="$REPO_ROOT/infra" init -backend-config="path=$DIR/terraform.tfstate" "$@"
    ;;
  plan | apply | destroy | import | refresh | console)
    if [ ! -f "$VALUES" ]; then
      echo "!! $VALUES is missing" >&2
      echo "   copy infra/terraform.tfvars.example there, then fill it in" >&2
      exit 1
    fi
    command="$1"
    shift
    exec terraform -chdir="$REPO_ROOT/infra" "$command" -var-file="$VALUES" "$@"
    ;;
  *)
    exec terraform -chdir="$REPO_ROOT/infra" "$@"
    ;;
esac
