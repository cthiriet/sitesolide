#!/usr/bin/env bash
# The PostgreSQL recipe of docs/manifest.md, proved on the workstation, in a
# throwaway Debian 13 container: a project's postgres service declares a
# `backup` command, the real backup component takes a scheduled snapshot
# while rows are being written, the real restore puts it back, and PostgreSQL
# must start on the restored folder with every row committed before the
# backup, no transaction caught in the middle, and pg_amcheck satisfied. The
# snapshots are stored by Debian's restic, in a repository of the container's.
#
#   dashboard/scripts/postgres-backup-proof.sh
#
# Needs Docker and the network: the image installs Debian's PostgreSQL 17,
# the way the recipe says (postgresql-common first, no shared cluster), and
# Debian's restic, and downloads the Bun release this workstation runs. Nothing touches a machine
# of the installation: the container is the only server, and it is removed.
#
# What runs is what a machine runs: backup.js built from dashboard/backup.ts
# exactly as bin/deploy-backup.sh builds it. With BACKUP_ISOLATION=none, its
# children (the backup command, the copy, the discard, the measure, the
# extraction) are plain children rather than transient units: the identity
# and the walls are systemd's, which no container here has, and
# dashboard/src/backup/README.md lists the commands that check them on a
# machine. Everything else runs as the project's account, site-proof, never
# as root: PostgreSQL, the run and the restore. The secret file the unit
# would read is stood for by the run's environment, which a child inherits
# with no isolation.
#
# The container is stopped and removed by its own id, whatever happens.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKER="${DOCKER:-docker}"
IMAGE="sitesolide-postgres-backup-proof:local"
command -v "$DOCKER" > /dev/null || { echo "!! Docker is needed: set DOCKER to its path" >&2; exit 2; }

BUN_VERSION="$(bun --version)"
case "$("$DOCKER" version --format '{{.Server.Arch}}')" in
  arm64 | aarch64) BUN_ARCH=aarch64 ;;
  amd64 | x86_64) BUN_ARCH=x64 ;;
  *) echo "!! a Docker server of an architecture Bun has no Linux build for" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
CID=""
cleanup() {
  if [ -n "$CID" ]; then "$DOCKER" rm -f "$CID" > /dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "-> the image: Debian 13, PostgreSQL 17 with no shared cluster, Debian's restic, Bun $BUN_VERSION"
"$DOCKER" build -q -t "$IMAGE" - > /dev/null <<DOCKERFILE
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
 && apt-get install -y --no-install-recommends postgresql-common ca-certificates curl unzip \\
 && sed -i 's/^#\\? *create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \\
 && apt-get install -y --no-install-recommends postgresql-17 restic \\
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$BUN_ARCH.zip \\
 && unzip -q /tmp/bun.zip -d /tmp && install -m 755 /tmp/bun-linux-$BUN_ARCH/bun /usr/local/bin/bun && rm -rf /tmp/bun*
RUN useradd --system --create-home --shell /usr/sbin/nologin site-proof
DOCKERFILE

echo "-> backup.js, built as bin/deploy-backup.sh builds it"
(cd "$REPO_ROOT/dashboard" && bun run borrow > /dev/null && bun build backup.ts --target=bun --outfile "$WORK/backup.js" > /dev/null)

mkdir -p "$WORK/app"
# The recipe of docs/manifest.md, as it is written there.
cat > "$WORK/app/postgres.sh" <<'SCRIPT'
#!/bin/sh
# PostgreSQL as one of the project's services: Debian's binaries, this project's own cluster in
# DATA_DIR (the only writable path in the sandbox), TCP on the loopback only, no unix socket and
# no /dev/shm (the sandbox's private /dev has none to share).
set -eu
PG_MAJOR=17
BIN="/usr/lib/postgresql/$PG_MAJOR/bin"
if [ ! -x "$BIN/postgres" ]; then
  echo "PostgreSQL $PG_MAJOR is not installed on this machine (apt install postgresql-$PG_MAJOR)" >&2
  exit 1
fi
PGDATA="$DATA_DIR/postgres"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  umask 077
  pwfile="$DATA_DIR/.initdb-pw"
  printf '%s' "$POSTGRES_PASSWORD" > "$pwfile"
  "$BIN/initdb" -D "$PGDATA" -U app --pwfile="$pwfile" -A scram-sha-256 -E UTF8 --no-locale
  rm -f "$pwfile"
  echo "CREATE DATABASE app;" | "$BIN/postgres" --single -D "$PGDATA" -c dynamic_shared_memory_type=mmap postgres > /dev/null
fi
if [ "$(cat "$PGDATA/PG_VERSION")" != "$PG_MAJOR" ]; then
  echo "The cluster in $PGDATA is PostgreSQL $(cat "$PGDATA/PG_VERSION"), not $PG_MAJOR: upgrade it with pg_upgrade first" >&2
  exit 1
fi
exec "$BIN/postgres" -D "$PGDATA" \
  -c listen_addresses=127.0.0.1 -c port="$PORT" -c unix_socket_directories='' \
  -c dynamic_shared_memory_type=mmap -c shared_buffers=128MB -c max_connections=40
SCRIPT
cat > "$WORK/app/postgres-backup.sh" <<'SCRIPT'
#!/bin/sh
# The backup command of the postgres service: a consistent copy of the running cluster, which
# PostgreSQL starts on as it is once restored. pg_basebackup reaches the server on the loopback
# as its superuser, and streams the WAL written meanwhile into the copy.
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
exec /usr/lib/postgresql/17/bin/pg_basebackup -h 127.0.0.1 -p "$PORT" -U app --no-password \
  -D "$BACKUP_DIR" -X stream -c fast
SCRIPT
cat > "$WORK/sitesolide.json" <<'MANIFEST'
{
  "slug": "proof",
  "publicDir": "public",
  "services": {
    "postgres": {
      "start": "/bin/sh /srv/sites/proof/app/postgres.sh",
      "port": 3081,
      "internal": true,
      "memory": "512M",
      "backup": { "folder": "postgres", "command": "/bin/sh /srv/sites/proof/app/postgres-backup.sh" }
    }
  },
  "secrets": ["proof.env"]
}
MANIFEST

# The same project before it declared its backup command.
grep -v '"backup"' "$WORK/sitesolide.json" | sed 's/"memory": "512M",/"memory": "512M"/' > "$WORK/sitesolide-undeclared.json"

# What runs inside, as root only to lay the tree.
cat > "$WORK/proof.sh" <<'PROOF'
#!/bin/sh
set -eu
PROOF=/proof
BUN=/usr/local/bin/bun
PG=/usr/lib/postgresql/17/bin
U=site-proof
SITE=/srv/sites/proof
WORK=/var/tmp/proof
PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
as() { setpriv --reuid="$U" --regid="$U" --init-groups -- "$@"; }
sql() { PGPASSWORD="$PW" "$PG/psql" -h 127.0.0.1 -p 3081 -U app -d app -v ON_ERROR_STOP=1 -tAq -c "$1"; }
step() { echo; echo "== $*"; }
COMMON="SITES_DIR=/srv/sites BACKUP_FOLDER=$WORK/backups BACKUP_STATE_FOLDER=$WORK/state BACKUP_RUN_FOLDER=$WORK/run BACKUP_STAGING_FOLDER=$WORK/staging BACKUP_REPOSITORY=$WORK/repository BACKUP_REPOSITORY_KEY=$WORK/key BACKUP_RESTIC=/usr/bin/restic BACKUP_RESTIC_CACHE=$WORK/cache ACCOUNTS_FILE=/etc/passwd BACKUP_ISOLATION=none BACKUP_DISK_RESERVE=0 SITESOLIDE_ZONE=test-zone.invalid"
# restic on the repository, as the project's account here, which holds it in this container.
restic_as() { as env RESTIC_REPOSITORY="$WORK/repository" RESTIC_PASSWORD_FILE="$WORK/key" RESTIC_CACHE_DIR="$WORK/cache" TZ=UTC /usr/bin/restic "$@"; }

step "the tree, as deploy lays it"
mkdir -p "$SITE/app" "$SITE/public" "$SITE/data" "$WORK/backups" "$WORK/state" "$WORK/run" "$WORK/staging" "$WORK/cache"
cp "$PROOF/app/postgres.sh" "$PROOF/app/postgres-backup.sh" "$SITE/app/"
cp "$PROOF/sitesolide.json" "$SITE/sitesolide.json"
head -c 48 /dev/urandom | base64 -w0 > "$WORK/key"
chown -R "$U:$U" "$SITE" "$WORK"
chmod 750 "$SITE/data"
chmod 600 "$WORK/key"
restic_as init -q > /dev/null
echo "Bun $("$BUN" --version), $("$PG/postgres" --version), $(/usr/bin/restic version)"
grep -E '^create_main_cluster' /etc/postgresql-common/createcluster.conf
if [ -n "$(pg_lsclusters -h)" ]; then pg_lsclusters; echo "FAIL: Debian created a shared cluster"; exit 1; fi
echo "pg_lsclusters lists none: no shared cluster"

start_pg() {
  # setpriv directly, not through a function, so that $! is postgres itself:
  # setpriv, env and the script's last line each exec the next.
  setpriv --reuid="$U" --regid="$U" --init-groups -- env DATA_DIR="$SITE/data" PORT=3081 POSTGRES_PASSWORD="$PW" sh "$SITE/app/postgres.sh" > "$1" 2>&1 &
  PG_PID=$!
  for i in $(seq 1 60); do
    "$PG/pg_isready" -q -h 127.0.0.1 -p 3081 && return 0
    sleep 0.5
  done
  cat "$1"; echo "FAIL: postgres did not start"; exit 1
}
stop_pg() {
  kill -INT "$PG_PID"
  wait "$PG_PID" || true
}

step "initdb as $U with scram-sha-256, then the server on 127.0.0.1:3081"
start_pg /var/tmp/pg-first.log
sql "SELECT 'password_encryption ' || current_setting('password_encryption') || ', wal_level ' || current_setting('wal_level') || ', max_wal_senders ' || current_setting('max_wal_senders')"

step "data: 100 accounts of 100, 300000 padded rows, and a writer that does not stop"
sql "CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL); INSERT INTO accounts SELECT g, 100 FROM generate_series(1, 100) g;"
sql "CREATE TABLE padding (id int PRIMARY KEY, body text NOT NULL); INSERT INTO padding SELECT g, repeat(md5(g::text), 6) FROM generate_series(1, 300000) g;"
sql "CREATE TABLE ticks (n bigint PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());"
# One session, one transaction per tick: a transfer between two accounts and
# the tick's number, in order. A restored cluster must hold ticks 1..M, no
# gap, and accounts that still sum to 10000.
awk 'BEGIN { for (i = 1; i <= 5000000; i++) printf "BEGIN; UPDATE accounts SET balance = balance - 1 WHERE id = %d; UPDATE accounts SET balance = balance + 1 WHERE id = %d; INSERT INTO ticks (n) VALUES (%d); COMMIT;\n", i % 100 + 1, (i * 7) % 100 + 1, i }' \
  | PGPASSWORD="$PW" "$PG/psql" -h 127.0.0.1 -p 3081 -U app -d app -q > /dev/null 2>&1 &
# The pipeline's last command, psql: stopped, awk ends on its next write.
WRITER=$!
until [ "$(sql "SELECT count(*) FROM ticks")" -gt 2000 ]; do sleep 0.2; done
A="$(sql "SELECT max(n) FROM ticks")"
echo "committed before the run: ticks 1..$A"

step "without a backup command, the run refuses the running cluster rather than copy its files"
cp "$PROOF/sitesolide-undeclared.json" "$SITE/sitesolide.json"
as env $COMMON POSTGRES_PASSWORD="$PW" "$BUN" "$PROOF/backup.js" run > /dev/null || true
cat "$WORK/state/last-run.json"; echo
grep -q 'a running PostgreSQL keeps its files in the data' "$WORK/state/last-run.json" || { echo "FAIL: the undeclared cluster was not refused"; exit 1; }
if grep -q 'postgres"' "$WORK/state/last-run.json"; then echo "FAIL: the status file names the folder"; exit 1; fi
if restic_as snapshots --json -q | grep -q '"/proof.tar"'; then echo "FAIL: a snapshot was taken"; exit 1; fi
echo "refused, no snapshot taken, no folder named"
cp "$PROOF/sitesolide.json" "$SITE/sitesolide.json"

step "the scheduled run, as $U: the backup command, the copy, the discard"
as env $COMMON POSTGRES_PASSWORD="$PW" "$BUN" "$PROOF/backup.js" run || true
B="$(sql "SELECT max(n) FROM ticks")"
echo "committed by the end of the run: ticks 1..$B, $((B - A)) written meanwhile"
cat "$WORK/state/last-run.json"; echo
SNAP="$(grep -o '"snapshot": "proof-[^"]*"' "$WORK/state/last-run.json" | sed 's/.*: "//; s/"$//')"
[ -n "$SNAP" ] || { echo "FAIL: no snapshot"; exit 1; }
restic_as snapshots --path /proof.tar
restic_as dump --tag scheduled --path /proof.tar latest /proof.tar > "$WORK/snapshot.tar"
DESCRIPTION="$(tar -xOf "$WORK/snapshot.tar" sitesolide-backup.json)"
echo "$DESCRIPTION" | grep -A2 fromBackupCommand | tr -s ' '
echo "$DESCRIPTION" | tr -d ' \n' | grep -q '"fromBackupCommand":\["postgres"\]' || { echo "FAIL: the description does not name the command's folder"; exit 1; }
tar -tvf "$WORK/snapshot.tar" | grep -E ' data/postgres/?$| data/postgres/(backup_label|backup_manifest)$'
if tar -tf "$WORK/snapshot.tar" | grep -q 'data/postgres/postmaster.pid'; then echo "FAIL: the live postmaster.pid is in the archive"; exit 1; fi
echo "no postmaster.pid: the archive holds the command's copy, not the live files"
[ -z "$(ls -A "$WORK/staging/proof" 2>/dev/null)" ] || { echo "FAIL: the command's copy was left in the staging folder"; exit 1; }
echo "the staging folder is empty: the command's copy was discarded"

step "the service stopped, then the restore, as $U"
kill "$WRITER" 2>/dev/null || true
wait "$WRITER" 2>/dev/null || true
LIVE="$(sql "SELECT max(n) FROM ticks")"
echo "the live cluster had ticks 1..$LIVE when stopped"
stop_pg
# No systemd here: the project's units are unknown, so the restore stops and
# starts none, and this script starts PostgreSQL itself.
printf '#!/bin/sh\necho not-found\n' > /usr/local/bin/fake-systemctl
chmod 755 /usr/local/bin/fake-systemctl
mkdir -p "$WORK/state/requests"
printf '{"nonce":"0123456789abcdef","snapshot":"%s","actor":"owner","requestedAt":%s}\n' "$SNAP" "$("$BUN" -e 'console.log(Date.now())')" > "$WORK/state/requests/proof.json"
chown -R "$U:$U" "$WORK/state/requests"
as env $COMMON SYSTEMCTL=/usr/local/bin/fake-systemctl "$BUN" "$PROOF/backup.js" restore sitesolide-restore@proof.service
grep -q '"state":"ok"' "$WORK/run/restore/proof.json" || { cat "$WORK/run/restore/proof.json"; echo "FAIL: the restore did not succeed"; exit 1; }
PRE="$(grep -o '"preRestore":"[^"]*"' "$WORK/run/restore/proof.json" | sed 's/.*:"//; s/"$//')"
restic_as dump --tag pre-restore --path /proof.tar latest /proof.tar | tar -xOf - sitesolide-backup.json | tr -d ' \n' | grep -q '"stopped":true.*"liveAsFiles":\["postgres"\]' || { echo "FAIL: the before-restore snapshot does not say it saved the stopped cluster as files"; exit 1; }
echo "before-restore snapshot $PRE: stopped, the cluster saved as files, and said so"

step "the restored folder: the mode and owner PostgreSQL requires"
stat -c '%a %U:%G %n' "$SITE/data/postgres" "$SITE/data/postgres/PG_VERSION" "$SITE/data/postgres/global"
[ "$(stat -c '%a %U' "$SITE/data/postgres")" = "700 $U" ] || { echo "FAIL: the restored cluster is not 0700 and the project's"; exit 1; }

step "PostgreSQL on the restored folder"
start_pg /var/tmp/pg-restored.log
grep -E "backup recovery|consistent recovery|ready to accept" /var/tmp/pg-restored.log | sed 's/^.*LOG: *//'
M="$(sql "SELECT max(n) FROM ticks")"
COUNT="$(sql "SELECT count(*) FROM ticks")"
FIRST="$(sql "SELECT min(n) FROM ticks")"
SUM="$(sql "SELECT sum(balance) || ' over ' || count(*) FROM accounts")"
PAD="$(sql "SELECT count(*) FROM padding")"
echo "restored: ticks $FIRST..$M, $COUNT rows; accounts $SUM; padding $PAD rows"
OK=1
[ "$FIRST" = 1 ] && [ "$COUNT" = "$M" ] || { echo "FAIL: the ticks have a gap"; OK=0; }
[ "$M" -ge "$A" ] || { echo "FAIL: ticks committed before the run are missing"; OK=0; }
[ "$M" -le "$B" ] || { echo "FAIL: ticks from after the run are there"; OK=0; }
[ "$M" -lt "$LIVE" ] || { echo "FAIL: the restore did not replace the live data"; OK=0; }
[ "$SUM" = "10000 over 100" ] || { echo "FAIL: a transfer was caught in the middle"; OK=0; }
[ "$PAD" = 300000 ] || { echo "FAIL: padded rows are missing"; OK=0; }

step "pg_amcheck, every database, heap and indexes"
if PGPASSWORD="$PW" "$PG/pg_amcheck" -h 127.0.0.1 -p 3081 -U app --install-missing --heapallindexed --all; then echo "no corruption found"; else echo "FAIL: pg_amcheck"; OK=0; fi
stop_pg

step "verdict"
[ "$OK" = 1 ] || { echo "PROOF FAILED"; exit 1; }
echo "PROOF PASSED: committed before the run 1..$A, restored 1..$M, committed by its end 1..$B"
PROOF

echo "-> the proof, in a container of its own"
CID="$("$DOCKER" run -d -v "$WORK:/proof:ro" "$IMAGE" sh /proof/proof.sh)"
CODE="$("$DOCKER" wait "$CID")"
"$DOCKER" logs "$CID" 2>&1
exit "$CODE"
