# Backups

Every project's data folder, snapshotted every hour, kept by a retention
policy, copied encrypted to a bucket if you configure one, and restored one
project at a time from the dashboard's *Backups* section.

Small software keeps its state in its data folder, mostly SQLite. Before this,
the only backup was the cloud provider's image of the whole machine: getting
one app's data back meant rolling every site back with it.

**Nothing runs until you install it** (see [Deployment](#deployment)). Without
it, the machine behaves exactly as before, and the *Backups* section says the
component is not set up.

## What is saved

`/srv/sites/<folder>/data`, the folder every app's unit hands its service as
`DATA_DIR`, and nothing else: the code and the public files come from your
repositories, and the next deploy puts them back.

- **SQLite databases**, recognised by their header and not by their name, are
  copied with `VACUUM INTO`: a consistent snapshot even while the service writes,
  without blocking a WAL writer. Their `-wal`, `-shm` and `-journal` are not
  archived, the copy holds them. A database the copy cannot read consistently
  (corrupt, locked for more than ten seconds) fails that project's snapshot,
  loudly, rather than archiving a file that may be half written. The one
  exception is the snapshot a restore takes of the data it replaces, its
  services stopped: there, a database that cannot be read consistently is
  saved as raw files, side files included, and said so (below).
- **Every other regular file** is copied as it is. A file that changes while it
  is read is archived padded or cut, as `tar` does, and the archive's
  description names it.
- **Folders** are kept, empty ones included.
- **Symbolic links, sockets, pipes and devices** are left out, and named in the
  archive's description: a link restored as root could point anywhere.

**Left out on purpose**, and said so on the page and in the status file: a
static site (no data folder), an app whose data folder is missing or empty, and
an app whose manifest says `"backup": false` (see
[docs/manifest.md](../../../docs/manifest.md#backup)).

**Refused, rather than half saved**, and said so: a data folder of more than
2,000,000 files and folders (an extraction would refuse its archive, so none
is taken), one that does not fit twice in the disk above its reserve, and one
that grows during its copy past what was measured at its start, by a quarter
and 64 MiB at least (see [Limits](#limits)).

## Where, and how often

| What | Where | Owner, mode |
|---|---|---|
| The snapshots | `/var/backups/sitesolide/<folder>/<folder>-<UTC time>[-pre-restore].tar.gz` | root, 0600, in 0700 folders |
| The status of the last run | `/var/lib/sitesolide-backup/last-run.json` | root, 0644, for the monitor |
| The audit, the bucket's index, the settings | `/var/lib/sitesolide-backup/backup.db` | root, 0600 |
| A restore request, while it waits | `/var/lib/sitesolide-backup/requests/<folder>.json` | root, 0600 |
| A restore's result | `/run/sitesolide-backup/restore/<folder>.json` | root, 0600 |
| The lock shared by a run and a restore | `/run/sitesolide-backup/lock/` | root, 0700 |

A snapshot is a plain `tar.gz`: `data/`, then `sitesolide-backup.json`, which
says of which project and when it was taken, how (`"raw": true` for the raw
files of a restore's own snapshot), what was copied and what was left out.
`tar -xzf` reads it on any machine. It is written beside its final name, read
back entirely, and only then named: an archive that exists under its name is
complete. A restore checks the project and the time it names against the
snapshot it was asked for: an archive copied under another project's name, or
another time's, is refused before anything stops.

`sitesolide-backup.timer` runs every hour, five minutes of random delay at most.
A run missed while the machine was off is made at boot.

### Retention

By default: the newest snapshot of each of the last **24** hours that have one,
of the last **7** days and the last **4** ISO weeks, plus the last **3**
snapshots taken before a restore. "Hours that have one", not hours of the clock:
a machine stopped for three days keeps its history. The newest snapshot is
never deleted, nor any file whose name is not a snapshot's, and pruning only
happens inside a run, under the lock a restore also takes.

The policy lives in one place, [retention.ts](retention.ts), and the unit's
environment overrides it: `BACKUP_KEEP_HOURLY`, `BACKUP_KEEP_DAILY`,
`BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_PRE_RESTORE`. The simplest place for them is
`/etc/sitesolide/dashboard-backup.env` (below), read at every run. The same
policy prunes the bucket.

Count the room it takes: about 38 archives per project. A data folder of
100 MB that compresses to 20 takes about 760 MB. **A run never fills the disk**:
it refuses a snapshot that would leave less than `BACKUP_DISK_RESERVE` bytes
free (1 GiB by default), and stops a copy that would, since one disk carries
every site. Root says how much room the disk has above the reserve; the copy,
which alone sees the data, measures it and refuses what does not fit twice.

### The status file

`/var/lib/sitesolide-backup/last-run.json`, rewritten at the end of every run,
whatever happened:

```json
{ "startedAt": "2026-10-04T13:02:11.000Z", "finishedAt": "2026-10-04T13:02:19.000Z", "ok": true,
  "projects": { "cms": { "ok": true, "snapshot": "cms-20261004T130211Z.tar.gz", "error": null } } }
```

`snapshot: null` with `ok: true` is a project left out on purpose. A project
whose snapshot was taken but whose offsite copy failed is `ok: false` with its
snapshot named. The errors never name a file inside a project's data, never
carry a figure of its size (the file is world-readable, and a project's tree is
its own business) and never carry a credential: the details, paths and figures
included, go to the journal (`journalctl -u sitesolide-backup`).

The file is written whatever happens to a project: whatever one project's
snapshot throws is that project's failure, and the run goes on to the next.
A database of the component that does not open costs the audit, not the
snapshots nor the file; a setting at fault in
`/etc/sitesolide/dashboard-backup.env` writes `ok: false` with no project, and
the reason to the journal.

## Who may touch what

```
sitesolide-backup.timer, every hour
   v
backup.js run                        root, CAP_DAC_READ_SEARCH only, no write outside its folders,
   |                                 /etc/sitesolide hidden
   |-- lists  /srv/sites/*           the projects, their manifests; whether a data folder is
   |                                 empty, asked of `find`, which stops at the first name
   |-- starts, for each project, within its share of the time:
   |     systemd-run --pipe --uid=site-<slug> ... backup.js copy
   |        as the project, /srv an empty mount with its data alone bound back,
   |        no network at all: measures the data, refuses what does not fit,
   |        and the archive comes back on standard output
   |-- writes /var/backups/sitesolide/<folder>/   the archive, read back before it is named
   |-- prunes by the retention policy
   |-- uploads to the bucket, encrypted on the machine, each object sealed for its key
   `-- writes /var/lib/sitesolide-backup/last-run.json, and its audit

dashboard, Backups, an unlocked session, the slug retyped
   v
steward                              checks, writes the request, starts the unit, does not wait
   v
sitesolide-restore@<slug>            root, one-shot, writes only into /srv/sites/<slug>,
   |                                 no network, /etc/sitesolide hidden
   |-- consumes the request, takes the lock
   |-- fetches the snapshot, from the server, or from the bucket through
   |     systemd-run --pipe -p DynamicUser=yes ... backup.js download
   |        a user of its own, the network and the bucket's settings, no project's rights
   |-- measures the current data, AS THE PROJECT, for the room
   |-- extracts it into /srv/sites/<slug>/.restore-incoming, AS THE PROJECT
   |-- stops nothing without the time left for what follows
   |-- marks the services stopped, stops them
   |-- snapshots the current data, `pre-restore`
   |-- swaps the folders by rename
   |-- starts the services, watches them for eight seconds, clears the mark
   `-- running: removes the previous data. Not running: puts it back, starts again
   v
backup.js after-restore              its ExecStopPost: a mark left behind, the restore was
                                     cut short with the services stopped; it repairs what is
                                     certain and starts them again
```

**Root never opens a project's file.** The copy and the extraction run as the
project's own account, through `systemd-run`, in a transient unit with the
confinement of the project's own service ([runner.ts](runner.ts)). Two reasons:
SQLite creates a database's `-shm` when it opens it, and one created by root
would lock the service out of its own database; and a project can put any bytes
in its folder, a forged database included, which is then parsed with that
project's rights, never root's. The archive root receives is read by
[tar.ts](tar.ts), which accepts files and folders only and refuses any path
that is absolute, climbs or is not UTF-8.

**Root lists no data folder, and walks none.** A project can put millions of
names in its folder; root listing them would be killed by its unit's
`MemoryMax` before writing the status, for every project, every hour. Bun has
no way to read a folder one name at a time (measured on 4 October 2026 with
Bun 1.3.11: `opendirSync` reads the whole folder at its first entry, and costs
more than `readdirSync`), so whether a data folder is empty is asked of
`find -quit`, and its weight is measured by the copy, as the project, under
the project's limits. A folder too big for those costs that project its
snapshot, said so, and nothing else.

**`Bun.Archive` was set aside**, measured with Bun 1.3.11: an entry given as
`Bun.file()` was archived empty without an error, the gzip option wrote an
uncompressed archive, and the whole archive lived in memory. The format here
is written and read as a stream, in bounded memory.

## Restoring from the dashboard

A site's *Backups* section, then *Restore* on a snapshot, for the owner or an
Admin of the project. The dashboard asks for its unlock, as for a secret, the
owner's password or the Admin's forced sign-in, then for the slug, retyped.
The dialog lists what the server does, then follows it phase by phase.

- **The current data is saved first**, as a *Before restore* snapshot: restoring
  that one undoes the restore. The last three are kept whatever their age.
- **Nothing changes until the snapshot has been extracted**: an archive that
  does not read stops the restore before the service is stopped.
- **The current data is saved even when a database of it is damaged**, which
  is often why one restores: the services being stopped, a database the copy
  cannot read consistently is saved as raw files, its `-wal` and `-journal`
  beside it, what SQLite itself would recover from. The page says so, the
  audit records it (`preRestoreRaw`), and the snapshot's description says
  `"raw": true`.
- **A service that does not come back gets its previous data back**, and is
  started on it again. The page says so.
- **Nothing is stopped without the time to finish.** Before stopping the
  services, the restore checks that its unit has the time left to save the
  current data, swap and watch, and refuses otherwise, nothing changed.
- **A restore cut short never leaves a site stopped.** It marks the services
  stopped before stopping them, and clears the mark once it has started them
  again. Killed in between, by its timeout or anything else, its unit's
  `ExecStopPost` finds the mark, repairs what is certain and starts them; the
  page says the restore was cut short.
- **The dashboard's own data is not restored from the dashboard**: the page
  doing it would cut itself off. Restore it by hand (below).
- **Nor the portal's**: its data is its audit, its cookie key, and the
  tables from before the access registry, which the steward carried over.
  Who may open which site is not in it any more: it is the steward's
  registry, `/var/lib/sitesolide-steward/access.json`, outside any project's
  data, and the projection the steward writes for the portal. An old copy
  would bring back an old audit, and from before the registry its old tables,
  without the mark that keeps the portal from reading them, nobody deciding
  it. Restore it by hand (below), knowing what it brings back.

Every restore is recorded in the component's audit with who asked, readable in
the section's *Activity*.

### A restore that was cut short

A restore killed in the middle (machine stopped, unit killed) leaves folders
beside `data/`. The next restore repairs what is certain: an extraction never
put in place is removed, a missing data folder is put back from
`.restore-previous`. One case is refused, and the page says so: the restored
data in place **and** the previous one beside it, the service having been
started or not. Decide by hand:

```bash
ssh you@your-machine
ls -la /srv/sites/cms/
systemctl status cms                       # running on the restored data?
# Keep the restored data:
sudo rm -rf /srv/sites/cms/.restore-previous
# Or put the previous data back:
sudo systemctl stop cms
sudo mv /srv/sites/cms/data /srv/sites/cms/.restore-failed
sudo mv /srv/sites/cms/.restore-previous /srv/sites/cms/data
sudo systemctl start cms
sudo rm -rf /srv/sites/cms/.restore-failed
```

## Restoring by hand, when the dashboard does not answer

From the machine's own snapshots. The extraction runs as the project, like the
component's: the archive is read by root and handed over through a pipe.

```bash
ssh you@your-machine
sudo ls -l /var/backups/sitesolide/cms/
SNAP=/var/backups/sitesolide/cms/cms-20261004T130211Z.tar.gz

# 1. The snapshot, extracted beside the data, as the project.
sudo install -d -m 750 -o site-cms -g site-cms /srv/sites/cms/.restore-incoming
sudo cat "$SNAP" | sudo -u site-cms tar -xzf - -C /srv/sites/cms/.restore-incoming --strip-components=1 data

# 2. Stopped, swapped, started.
sudo systemctl stop cms
sudo mv /srv/sites/cms/data /srv/sites/cms/.restore-previous
sudo mv /srv/sites/cms/.restore-incoming /srv/sites/cms/data
sudo systemctl start cms
systemctl is-active cms

# 3. Running as it should: the previous data goes. Not: swap back, as above.
sudo rm -rf /srv/sites/cms/.restore-previous
```

For the landing, the folder is the zone's name, the account `site-landing` and
the unit `sitesolide-landing`. For the dashboard, the unit is `dashboard`; for
the portal, `portal`, and a copy of the portal brings back the audit of its
time, and a copy from before the access registry the old tables of who could
open which site, without the mark `data/access-from-steward`. The portal still
reads the steward's projection while it is there, and leaves the mark again;
only with the projection missing would it decide from those old tables, so
check after the restore that `sudo curl -s http://127.0.0.1:3026/admin/access`
answers `"reading":"steward"`.

From the bucket, on any machine with Bun and a clone of this repository, the
machine itself being gone:

```bash
# Any S3 client fetches the object, the AWS CLI for instance:
aws s3 cp --endpoint-url https://fsn1.your-objectstorage.com \
  s3://my-backups/sitesolide/cms/cms-20261004T130211Z.tar.gz.enc .
cd sitesolide/dashboard && bun install && bun run borrow
bun backup.ts decrypt cms-20261004T130211Z.tar.gz.enc cms.tar.gz   # asks for the passphrase
tar -tzf cms.tar.gz
```

`decrypt` prints the key the object was sealed for, `sealed as
sitesolide/cms/cms-20261004T130211Z.tar.gz.enc`: check it names the project and
the time you meant, whatever the file was called since. An object uploaded
before format 2 names none; `tar -xzOf cms.tar.gz sitesolide-backup.json`
then says what it is.

## The offsite copy

Optional, and off by default: snapshots then stay on the server only, which
dies with the server. Configured, every run uploads each project's new snapshot
and catches up the ones the bucket lacks, then prunes the bucket by the same
policy.

**Encrypted on the machine, before upload**: AES-256-GCM through WebCrypto, by
chunks of 1 MiB so that a file of any size crosses in bounded memory, with the
STREAM construction that `age` uses: a chunk moved, dropped or truncated fails.
The key comes from your passphrase through PBKDF2-SHA256 (600,000 iterations),
then one key per file through HKDF. The bucket's provider stores bytes it
cannot read; a stolen access key yields nothing without the passphrase. The
format is described at the top of [crypto.ts](crypto.ts).

**Each object is sealed for its key** (format 2): `<prefix>/<folder>/<snapshot>.enc`
is written in its header, which every chunk authenticates. Someone who may
write to the bucket cannot copy one project's object under another's name for
an admin to restore into the wrong site: the restore refuses an object sealed
for another key. The objects uploaded before format 2 carry no key; they are
still read, by the restore and by `decrypt`, because they may be the only copy
left, and retention replaces them as it prunes, within its horizon (four weeks
by default). The restore itself has no network: a download child, a user of
its own with the network and no right on any project, fetches and decrypts
the object, within twenty minutes, and stops when the disk comes down to its
reserve.

**The passphrase is the only way back.** Lose it, and every offsite copy is
noise. Put it in your password manager the moment you set it, not later.

### Setting it up

1. **A bucket**, and credentials that may read, write, list and delete in it:
   - Hetzner Object Storage: *Cloud Console > Object Storage*, a bucket in
     `fsn1`, `nbg1` or `hel1`, then *Security > S3 credentials*. The endpoint is
     `https://<location>.your-objectstorage.com`, the region the location.
   - Cloudflare R2: a bucket, then an R2 API token with *Object Read & Write* on
     that bucket only. The endpoint is
     `https://<account-id>.r2.cloudflarestorage.com`, the region `auto`.
   - Any S3: its endpoint, `https://` only, and its region.

   In the bucket, a lifecycle rule that aborts incomplete multipart uploads
   after a day: an upload abandoned at the run's deadline, or a run killed in
   the middle of one, leaves parts behind.
   If the provider offers object versioning or object lock, turn it on: a
   compromised machine holds keys that can delete, and versions survive it.

2. **The file, once, as root** (the dashboard never creates a file no manifest
   declares):

   ```bash
   ssh you@your-machine 'sudo install -m 600 -o root -g root /dev/null /etc/sitesolide/dashboard-backup.env'
   ```

   It belongs to root on purpose: attached to the dashboard site by its name,
   managed from its *Secrets*, but never readable by the dashboard's account.
   **Install the new steward before creating it**: an older steward expects
   `site-dashboard` as its owner and would suggest the `chown` that exposes it.

3. **The values**, from *Sites > dashboard > Secrets > dashboard-backup.env*,
   unlocked:

   | Variable | Example |
   |---|---|
   | `BACKUP_S3_ENDPOINT` | `https://fsn1.your-objectstorage.com` |
   | `BACKUP_S3_BUCKET` | `my-backups` |
   | `BACKUP_S3_REGION` | `fsn1`, `auto`, or absent |
   | `BACKUP_S3_ACCESS_KEY_ID` | the key's id |
   | `BACKUP_S3_SECRET_ACCESS_KEY` | the key's secret |
   | `BACKUP_S3_PREFIX` | `sitesolide` if absent; one per machine sharing a bucket |
   | `BACKUP_ENCRYPTION_PASSPHRASE` | *Generate*, then into your password manager |

   No restart: the next run reads the file. The *Restart pending* mark the page
   puts on it can be ignored, the dashboard's service does not read that file.
   Half a configuration is an error the *Backups* section shows, never a silent
   fallback to local copies.

4. **Check it now** rather than within the hour:

   ```bash
   ssh you@your-machine 'sudo systemctl start sitesolide-backup.service; sudo cat /var/lib/sitesolide-backup/last-run.json'
   ```

## Limits

What one project can cost the others, at most, and what a snapshot can be.

| What | Bound | Where |
|---|---|---|
| Entries of an archive, `data/` and the description counted | 2,000,000: the copy refuses beyond, as the extraction does | `MAX_ENTRIES`, copy.ts |
| Bytes a copy archives | the data measured at its start, plus a quarter and 64 MiB at least, within the room above the reserve | `copyBudget`, copy.ts |
| Room a snapshot needs | twice the data's apparent size (a sparse file counts whole), above `BACKUP_DISK_RESERVE` | child.ts |
| A project's time in a run | its share of what is left of the 25-minute window among the projects still to come, one minute at least, `BACKUP_CHILD_TIMEOUT_MS` (20 minutes) at most; cut short, it is tried again once every other project has had its turn | `projectTime`, run.ts |
| Reading an archive back | the same time, the same entries, no more bytes than the room | `verifyArchive`, snapshot.ts |
| A child past its time | killed (`systemctl kill --signal=SIGKILL`), its unit's `RuntimeMaxSec` and `TimeoutStopSec=15s` as the backstop: a copy stopped by its own service does not hold the run | runner.ts |
| Uploads | none started after 40 minutes, none waited for past 45; the status is written before the unit's 50 | run.ts |
| A restore | 90 minutes in all; a download 20, a measure 10, an extraction and a snapshot 20 each, the swap and the watch 10 | restore.ts, the unit |
| Memory | a run 256M, a child 512M; a data folder too big for its copy's 512M costs that project its snapshot | the units, runner.ts |

**Why not a fresh PID namespace for the copy.** The copy runs under the
project's uid, so the project's service may `SIGSTOP` it. `PrivatePIDs=`
(systemd 257, Debian 13) would not prevent it: a process may signal those of a
descendant PID namespace, and SIGSTOP reaches even a namespace's init when sent
from an ancestor (pid_namespaces(7)). The time bound above is what handles it.

## Deployment

In this order, from the workstation, each step checked before the next. The
privileged commands are the scripts'; nothing here is done by hand on the
machine except reading.

1. **`bin/deploy-backup.sh install`.** Builds `backup.js`, installs it with the
   three units, creates `/var/backups/sitesolide` (0700) and
   `/var/lib/sitesolide-backup`, reloads systemd. It starts nothing and takes no
   snapshot. Check: it ends with *installed and verified, nothing started*, and
   `systemd-analyze verify` said nothing.
2. **`bin/deploy-steward.sh`.** The steward gains the backup routes, and its
   unit makes `/var/lib/sitesolide-backup` writable for it, which only applies
   to a folder that exists when it starts: hence step 1 first. Check: its own
   checks pass, then
   `ssh you@your-machine "sudo -u site-dashboard curl -s --unix-socket /run/sitesolide-steward/secretaire.sock 'http://steward/backups?slug=dashboard'"`
   answers JSON with `"installed":true`.
3. **`bin/deploy-gatekeeper.sh`.** It embeds the manifest's validation: an older
   one refuses to change the portal of a site whose manifest says
   `"backup": false`, as an unknown key.
4. **`cd dashboard && sitesolide deploy`.** The relay and the *Backups*
   section. Before step 2, the section says the steward needs updating, and
   nothing else changes.
5. **`bin/deploy-backup.sh enable`.** A first run by hand, its status printed,
   and only if every project was saved, the hourly timer. A project that failed
   is named with its reason; fix it, run `enable` again.
6. **`bin/deploy-backup.sh state`**, the next day: the timer, the last run, the
   room taken.
7. **A first restore on a site that does not matter**, from the dashboard, then
   its undo from the *Before restore* snapshot it made.

Then, if you want it, [the offsite copy](#setting-it-up).

### Updating

| What changed | The command |
|---|---|
| `backup.ts`, `src/backup/`, `infra/backup/`, `bin/cli/backups.ts` | `bin/deploy-backup.sh install` |
| `src/backup/routes.ts`, `reader.ts`, `request.ts`, `src/secrets/` | `bin/deploy-steward.sh` |
| the page, the relay | `sitesolide deploy` from `dashboard/` |

`install` refuses while a run or a restore is in progress, and keeps the timer
as it was.

**From a version before format 2** (the bounds above, the portal left out of
the dashboard's restores, the objects sealed for their key, the restore
without network): `bin/deploy-backup.sh install`, then `bin/deploy-steward.sh`,
in either order: a steward updated first refuses the portal's restore that an
old one-shot would carry out, and a one-shot updated first refuses it whatever
the steward asks. Check after `install`: `systemd-analyze verify` said nothing,
and the next run's status, or `bin/deploy-backup.sh state`, names every project
as before. The archives already written restore as they did; the bucket's
older objects are read as they were.

### Rolling back

```bash
ssh you@your-machine '
  sudo systemctl disable --now sitesolide-backup.timer
  sudo rm -f /etc/systemd/system/sitesolide-backup.service /etc/systemd/system/sitesolide-backup.timer \
             /etc/systemd/system/sitesolide-restore@.service /usr/local/lib/sitesolide/backup.js
  sudo systemctl daemon-reload
'
```

Then the previous steward and dashboard, from the commit before, with
`bin/deploy-steward.sh` and `sitesolide deploy`. The snapshots stay in
`/var/backups/sitesolide` until you delete them; so does
`/etc/sitesolide/dashboard-backup.env`.

Going back to a version before format 2 keeps the local archives readable,
but not the objects uploaded since: an older `backup.js` says `unknown format
version 2`. Decrypt those with this version of the repository, by hand.

## What only the machine can prove

The tests run everything on the workstation, the copies and extractions as real
child processes, without the isolation. What depends on systemd, Linux or the
provider is to be checked on a machine before trusting it:

```bash
# The units load, and the template through an instance.
sudo systemd-analyze verify /etc/systemd/system/sitesolide-backup.service \
  '/etc/systemd/system/sitesolide-restore@.service:sitesolide-restore@cms.service'

# A run, and what it wrote.
sudo systemctl start sitesolide-backup.service; journalctl -u sitesolide-backup -n 50
sudo cat /var/lib/sitesolide-backup/last-run.json
sudo ls -la /var/backups/sitesolide/*/ /var/cache/sitesolide-backup/

# The copy runs as the project, in its walls: during a run,
systemctl list-units 'sitesolide-backup-copy-*'
systemctl show 'sitesolide-backup-copy-cms-*' -p User -p IPAddressDeny -p ProtectSystem
# and its database's side files still belong to the project afterwards:
sudo ls -l /srv/sites/cms/data/

# systemd-run --pipe hands the archive over: the snapshot reads back.
sudo tar -tzf /var/backups/sitesolide/cms/cms-*.tar.gz | head

# The steward can write a request and read the database under its unit.
sudo -u site-dashboard curl -s --unix-socket /run/sitesolide-steward/secretaire.sock 'http://steward/backups?slug=cms'

# A restore end to end, on a test site, from the dashboard; then:
sudo cat /run/sitesolide-backup/restore/<slug>.json; journalctl -u 'sitesolide-restore@*' -n 50

# The monitor, as its unprivileged user, reads the status.
sudo -u nobody cat /var/lib/sitesolide-backup/last-run.json
```

Also to measure there: the memory of a run and of a copy on the largest site
(`MemoryMax` 256M and 512M), the time a copy takes on it, and that a restore's
`systemctl stop` and `start` act on every unit of a project with several
services.

What the bounds rely on, which the workstation cannot show, on a test machine:

```bash
# EnvironmentFile= is read by PID 1 although /etc/sitesolide is hidden from the units:
sudo systemctl show sitesolide-backup -p InaccessiblePaths -p EnvironmentFiles
sudo systemd-run --wait --pipe -p InaccessiblePaths=-/etc/sitesolide \
  -p EnvironmentFile=/etc/sitesolide/dashboard-backup.env sh -c 'test -n "$BACKUP_S3_BUCKET" && ! ls /etc/sitesolide'

# The run's emptiness test, find inside the unit's walls (CAP_DAC_READ_SEARCH, @system-service):
sudo systemd-run --wait --pipe -p CapabilityBoundingSet=CAP_DAC_READ_SEARCH -p ProtectSystem=strict \
  -p SystemCallFilter=@system-service /usr/bin/find /srv/sites/cms/data -mindepth 1 -maxdepth 1 -print -quit

# A folder of 650,000 long names in a throwaway site's data: the run's memory stays low,
# that site fails or is saved, the others are saved, and the status is written.
sudo -u site-test sh -c 'cd /srv/sites/test/data && mkdir crowd && cd crowd && seq -f "%0240g" 650000 | xargs touch'
sudo systemctl start sitesolide-backup.service
journalctl -u sitesolide-backup -n 3   # "Consumed ... memory peak": far under 256M
sudo cat /var/lib/sitesolide-backup/last-run.json

# A copy stopped by its own service: the run moves on at the site's share.
sudo systemctl start --no-block sitesolide-backup.service; sleep 5
sudo -u site-test pkill -STOP -f 'backup.js copy'
journalctl -u sitesolide-backup -f   # "out of its time, tried again after the others", then the next site

# The restore has no network, and its download child does:
systemctl show 'sitesolide-restore@test.service' -p IPAddressDeny -p RestrictAddressFamilies
systemctl list-units 'sitesolide-backup-download-*'   # during a restore from the bucket only

# A restore cut short with the services stopped is started again by its ExecStopPost:
# a test site, a restore from the dashboard, then, once the page says "Saving the current data first.":
sudo systemctl kill --signal=SIGKILL sitesolide-restore@test.service
systemctl is-active test; sudo cat /run/sitesolide-backup/restore/test.json   # active; "cut short"
```

## Tests

```bash
cd dashboard && bun test tests/backup-
cd bin && bun test tests/cli-backups.test.ts tests/e2e/backups.test.ts
```

Retention, archive names and paths, the tar reader against forged archives and
against `tar` itself, the encryption round trip and its tampering, a snapshot of
WAL databases written to by another process during the copy and restored with
`PRAGMA integrity_check`, a whole run on a throwaway tree, the offsite copy
against a local S3 endpoint, a restore and its rollback with a simulated
systemd, the steward's routes and the relay, the units. And the bounds
(tests/backup-bounds.test.ts): root's memory against a folder of 60,000 long
names, measured on a child's peak, a copy stopped by `SIGSTOP`, a terabyte of
holes grown after the measure, a data folder swapped for a link, the entries
counted alike by the copy and the extraction; a restore cut short and its
cleanup, a stalled download, a damaged database saved raw, an object or an
archive copied under another name.
