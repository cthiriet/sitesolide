#!/usr/bin/env bash
# The offsite copy proved against a real S3 API, on the workstation: the real
# backup component, built as bin/deploy-backup.sh builds it, runs in a
# throwaway Debian 13 container with Debian's restic, and copies to a bucket
# served by versitygw, an S3 gateway, in a second container. Then a restore
# from the bucket alone, through the download child, and the daily prune and
# check of both repositories.
#
#   dashboard/scripts/s3-backup-proof.sh
#
# Needs Docker and the network: the images are Debian's and versitygw's, the
# image installs Debian's restic and downloads the Bun release this
# workstation runs. MinIO's images could not be pulled when this was written
# (8 October 2026), hence versitygw. Nothing touches a machine of the
# installation: the containers are the only servers, and both are removed,
# each by its own id, whatever happens. The gateway's credentials are drawn
# here, for this proof alone.
#
# With BACKUP_ISOLATION=none, the copy, the extraction and the download are
# plain children rather than transient units: the identity and the walls are
# systemd's, which no container here has (dashboard/src/backup/README.md
# lists the commands that check them on a machine). The download child takes
# the bucket's settings from the restore's environment, as a unit would from
# its file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKER="${DOCKER:-docker}"
IMAGE="sitesolide-s3-backup-proof:local"
GATEWAY_IMAGE="versity/versitygw:latest"
command -v "$DOCKER" > /dev/null || { echo "!! Docker is needed: set DOCKER to its path" >&2; exit 2; }

BUN_VERSION="$(bun --version)"
case "$("$DOCKER" version --format '{{.Server.Arch}}')" in
  arm64 | aarch64) BUN_ARCH=aarch64 ;;
  amd64 | x86_64) BUN_ARCH=x64 ;;
  *) echo "!! a Docker server of an architecture Bun has no Linux build for" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
GATEWAY=""
CID=""
cleanup() {
  if [ -n "$CID" ]; then "$DOCKER" rm -f "$CID" > /dev/null 2>&1 || true; fi
  if [ -n "$GATEWAY" ]; then "$DOCKER" rm -f "$GATEWAY" > /dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "-> the image: Debian 13, Debian's restic, Bun $BUN_VERSION"
"$DOCKER" build -q -t "$IMAGE" - > /dev/null <<DOCKERFILE
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
 && apt-get install -y --no-install-recommends restic ca-certificates curl unzip \\
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$BUN_ARCH.zip \\
 && unzip -q /tmp/bun.zip -d /tmp && install -m 755 /tmp/bun-linux-$BUN_ARCH/bun /usr/local/bin/bun && rm -rf /tmp/bun*
DOCKERFILE

echo "-> backup.js, built as bin/deploy-backup.sh builds it"
(cd "$REPO_ROOT/dashboard" && bun run borrow > /dev/null && bun build backup.ts --target=bun --outfile "$WORK/backup.js" > /dev/null)

echo "-> the S3 gateway, its credentials drawn for this proof"
ACCESS="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SECRET="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
GATEWAY="$("$DOCKER" run -d -e ROOT_ACCESS_KEY_ID="$ACCESS" -e ROOT_SECRET_ACCESS_KEY="$SECRET" --tmpfs /data:size=2g \
  --entrypoint /bin/sh "$GATEWAY_IMAGE" -c 'mkdir -p /data/proofs && exec versitygw posix /data')"
printf '%s' "$ACCESS" > "$WORK/access"
printf '%s' "$SECRET" > "$WORK/secret"

cat > "$WORK/proof.sh" <<'PROOF'
#!/bin/sh
set -eu
PROOF=/proof
BUN=/usr/local/bin/bun
WORK=/var/tmp/proof
SITE=/srv/sites/proof
PASSPHRASE="$(head -c 32 /dev/urandom | base64 -w0)"
BUCKET_REPO="s3:http://127.0.0.1:7070/proofs/sitesolide-restic"
step() { echo; echo "== $*"; }
fail() { echo "FAIL: $*"; exit 1; }
export SITES_DIR=/srv/sites BACKUP_FOLDER="$WORK/backups" BACKUP_STATE_FOLDER="$WORK/state" BACKUP_RUN_FOLDER="$WORK/run" \
  BACKUP_STAGING_FOLDER="$WORK/staging" BACKUP_REPOSITORY="$WORK/repository" BACKUP_REPOSITORY_KEY="$WORK/key" \
  BACKUP_RESTIC=/usr/bin/restic BACKUP_RESTIC_CACHE="$WORK/cache" ACCOUNTS_FILE=/etc/passwd BACKUP_ISOLATION=none \
  BACKUP_DISK_RESERVE=0 SITESOLIDE_ZONE=test-zone.invalid \
  BACKUP_S3_ENDPOINT=http://127.0.0.1:7070 BACKUP_S3_BUCKET=proofs BACKUP_S3_REGION=us-east-1 \
  BACKUP_S3_ACCESS_KEY_ID="$(cat "$PROOF/access")" BACKUP_S3_SECRET_ACCESS_KEY="$(cat "$PROOF/secret")" \
  BACKUP_ENCRYPTION_PASSPHRASE="$PASSPHRASE"
local_restic() { env RESTIC_REPOSITORY="$WORK/repository" RESTIC_PASSWORD_FILE="$WORK/key" RESTIC_CACHE_DIR="$WORK/cache" TZ=UTC /usr/bin/restic "$@" < /dev/null; }
bucket_restic() {
  env RESTIC_REPOSITORY="$BUCKET_REPO" RESTIC_PASSWORD="$PASSPHRASE" AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=us-east-1 TZ=UTC /usr/bin/restic --no-cache "$@" < /dev/null
}

step "the tree, a project with a database and uploads, the server's repository"
mkdir -p "$SITE/data/uploads" "$WORK/backups" "$WORK/state" "$WORK/run" "$WORK/staging" "$WORK/cache"
printf '{"slug":"proof","start":"bun run server.ts","port":3040}' > "$SITE/sitesolide.json"
"$BUN" -e '
  const { Database } = require("bun:sqlite");
  const db = new Database(process.argv[1], { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  const insert = db.query("INSERT INTO notes (body) VALUES (?)");
  db.transaction(() => { for (let i = 0; i < 20000; i++) insert.run("note " + i + " " + "x".repeat(200)); })();
  db.close();
' "$SITE/data/app.db"
head -c 3000000 /dev/urandom > "$SITE/data/uploads/photo.bin"
head -c 48 /dev/urandom | base64 -w0 > "$WORK/key"
chmod 600 "$WORK/key"
local_restic init -q > /dev/null
echo "$(/usr/bin/restic version)"

step "the first run: the bucket's repository initialised with the server's chunker parameters, the snapshot copied"
"$BUN" "$PROOF/backup.js" run | tail -5 || true
cat "$WORK/state/last-run.json"; echo
grep -q '"ok": true' "$WORK/state/last-run.json" || fail "the first run failed"
[ "$(local_restic cat config | grep -o '"chunker_polynomial": *"[0-9a-f]*"')" = "$(bucket_restic cat config | grep -o '"chunker_polynomial": *"[0-9a-f]*"')" ] || fail "the chunker parameters differ"
echo "the same chunker parameters on both sides"
bucket_restic snapshots --path /proof.tar

step "a second run, in the same hour: only what changed goes up, and each side keeps the hour's newest"
sleep 2
"$BUN" -e 'const { Database } = require("bun:sqlite"); const db = new Database(process.argv[1]); db.run("INSERT INTO notes (body) VALUES (?)", ["one more"]); db.close();' "$SITE/data/app.db"
BEFORE="$(bucket_restic stats --mode raw-data --json | grep -o '"total_size":[0-9]*' | cut -d: -f2)"
"$BUN" "$PROOF/backup.js" run > /dev/null || true
grep -q '"ok": true' "$WORK/state/last-run.json" || { cat "$WORK/state/last-run.json"; fail "the second run failed"; }
AFTER="$(bucket_restic stats --mode raw-data --json | grep -o '"total_size":[0-9]*' | cut -d: -f2)"
echo "the bucket grew by $((AFTER - BEFORE)) bytes for a data folder of $(du -sb "$SITE/data" | cut -f1) bytes"
[ "$((AFTER - BEFORE))" -lt 3000000 ] || fail "the uploads went up again"
SECOND="$(grep -o '"snapshot": "proof-[^"]*"' "$WORK/state/last-run.json" | sed 's/.*: "//; s/"$//')"
bucket_restic snapshots --path /proof.tar
[ "$(bucket_restic snapshots --json --path /proof.tar | grep -o '"id"' | wc -l)" = 1 ] || fail "the bucket does not hold the hour's newest alone"
[ "$(local_restic snapshots --json --path /proof.tar | grep -o '"id"' | wc -l)" = 1 ] || fail "the server does not hold the hour's newest alone"

step "a restore from the bucket alone, through the download child"
ID="$(local_restic snapshots --json --path /proof.tar | grep -o '"id":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)"
local_restic forget -q "$ID"
[ "$(local_restic snapshots --json --path /proof.tar | grep -o '"id"' | wc -l)" = 0 ] || fail "the snapshot is still on the server"
echo "changed since" > "$SITE/data/uploads/photo.bin"
printf '#!/bin/sh\necho not-found\n' > /usr/local/bin/fake-systemctl
chmod 755 /usr/local/bin/fake-systemctl
mkdir -p "$WORK/state/requests"
printf '{"nonce":"0123456789abcdef","snapshot":"%s","actor":"owner","requestedAt":%s}\n' "$SECOND" "$("$BUN" -e 'console.log(Date.now())')" > "$WORK/state/requests/proof.json"
chmod 600 "$WORK/state/requests/proof.json"
SYSTEMCTL=/usr/local/bin/fake-systemctl "$BUN" "$PROOF/backup.js" restore sitesolide-restore@proof.service | tail -3
cat "$WORK/run/restore/proof.json"; echo
grep -q '"state":"ok"' "$WORK/run/restore/proof.json" || fail "the restore from the bucket did not succeed"
[ "$(wc -c < "$SITE/data/uploads/photo.bin")" = 3000000 ] || fail "the restored upload is not the snapshot's"
[ "$("$BUN" -e 'const { Database } = require("bun:sqlite"); const db = new Database(process.argv[1], { readonly: true }); console.log(db.query("SELECT count(*) AS n FROM notes").get().n); db.close();' "$SITE/data/app.db")" = 20001 ] || fail "the restored database is not the snapshot's"
echo "restored from the bucket: the upload and the 20001 notes of the snapshot"

step "the daily maintenance, asked at once as bin/deploy-backup.sh check asks it: prune and check, on both repositories"
install -m 600 /dev/null "$WORK/state/maintenance-now"
sleep 2
"$BUN" "$PROOF/backup.js" run > /dev/null || true
cat "$WORK/state/last-run.json"; echo
tr -d ' \n' < "$WORK/state/last-run.json" | grep -q '"checks":{"local":{"at":"[^"]*","ok":true,"error":null},"offsite":{"at":"[^"]*","ok":true,"error":null},' || fail "the checks did not pass on both repositories"
[ ! -e "$WORK/state/maintenance-now" ] || fail "the run left the request for a maintenance in place"
bucket_restic check -q && echo "restic check of the bucket, by hand: no errors"

step "verdict"
echo "PROOF PASSED"
PROOF

echo "-> the proof, in a container sharing the gateway's network"
CID="$("$DOCKER" run -d --network "container:$GATEWAY" -v "$WORK:/proof:ro" "$IMAGE" sh /proof/proof.sh)"
CODE="$("$DOCKER" wait "$CID")"
"$DOCKER" logs "$CID" 2>&1
exit "$CODE"
