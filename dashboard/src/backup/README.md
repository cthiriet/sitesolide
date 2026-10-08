# Backups

Every project's data folder, snapshotted every hour into a restic repository
on the server, kept by a retention policy, copied to a second restic
repository in a bucket if you configure one, and restored one project at a
time from the dashboard's *Backups* section.

Small software keeps its state in its data folder, mostly SQLite. Before this,
the only backup was the cloud provider's image of the whole machine: getting
one app's data back meant rolling every site back with it.

**Storage is restic's**, a standard and audited tool: deduplication, its own
encryption, `forget` and `prune`, `check`, S3 backends. What the component
keeps of its own is everything around it: the copy as the project, the
consistency of the databases, the backup commands, the bounds, the status
file, the restore and its rollback. A snapshot is restored by hand anywhere
with stock restic (see [Restoring by hand](#restoring-by-hand-when-the-dashboard-does-not-answer)).

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
  archive's description: a link restored as root could point anywhere. Each
  list of the description names the first of its kind, 16 KiB of names at
  most, and counts them all (`counts`): a description too big would be
  refused by the extraction, and a snapshot never reported taken that a
  restore refuses.
- **A folder a service keeps live**, a PostgreSQL cluster for one, is never
  archived as its files: the service's manifest declares it with a backup
  command (see
  [docs/manifest.md](../../../docs/manifest.md#a-services-backup-command)),
  run just before the copy, which leaves a consistent copy in an empty
  folder, `BACKUP_DIR`. The archive holds that copy under `data/<folder>`,
  and its description names the folder (`fromBackupCommand`). In the
  snapshot a restore takes, its services stopped, no command runs and the
  folder is saved as its files, named too (`liveAsFiles`).

**Left out on purpose**, and said so on the page and in the status file: a
static site (no data folder), an app whose data folder is missing or empty, and
an app whose manifest says `"backup": false` (see
[docs/manifest.md](../../../docs/manifest.md#backup)).

**Refused, rather than half saved**, and said so: a data folder of more than
2,000,000 files and folders (an extraction would refuse its archive, so none
is taken), one that does not fit twice in the disk above its reserve, and one
that grows during its copy past what was measured at its start, by a quarter
and 64 MiB at least (see [Limits](#limits)). A backup command that exits
non-zero, runs past its time or leaves `BACKUP_DIR` empty fails its project's
snapshot. So does a server database running on files of the data that no
service declares, a PostgreSQL cluster (`postmaster.pid` beside `PG_VERSION`)
or a MongoDB (`mongod.lock` holding a pid beside `WiredTiger`): copied file by
file while it writes, it would be archived in a state no server starts from.
The status file then says to declare a backup command, and names no folder;
in the snapshot a restore takes, the services stopped, such a folder is saved
as files and named in the description. Those two are the servers the copy
knows how to recognise; any other needs its backup command just the same.

## Where, and how often

| What | Where | Owner, mode |
|---|---|---|
| The snapshots, every project's | `/var/backups/sitesolide-restic`, a restic repository | root, 0700 |
| Its password, drawn at install | `/var/backups/sitesolide-restic.key` | root, 0600 |
| restic's cache and temporary packs | `/var/cache/sitesolide-restic` | root, 0700, the units' `CacheDirectory` |
| The archives of the format before restic, until removed | `/var/backups/sitesolide/<folder>/<folder>-<UTC time>[-pre-restore].tar.gz` | root, 0600, in 0700 folders |
| The status of the last run | `/var/lib/sitesolide-backup/last-run.json` | root, 0644, for the monitor |
| The audit, the index of the snapshots, the settings | `/var/lib/sitesolide-backup/backup.db` | root, 0600 |
| A restore request, while it waits | `/var/lib/sitesolide-backup/requests/<folder>.json` | root, 0600 |
| A restore's result | `/run/sitesolide-backup/restore/<folder>.json` | root, 0600 |
| The lock shared by a run and a restore | `/run/sitesolide-backup/lock/` | root, 0700 |

**One repository for every project.** One key, one index, one chunker; what
two projects share is stored once; one prune and one check a day. Each
snapshot holds one file, `/<folder>.tar`, a plain tar: `data/`, then
`sitesolide-backup.json`, which says of which project and when it was taken,
how (`"raw": true` for the raw files of a restore's own snapshot,
`"stopped": true` for that snapshot altogether), what was copied, which
folders came from a backup command (`fromBackupCommand`) or were saved as
files with their server stopped (`liveAsFiles`), and what was left out.
`restic dump` gives it back, and `tar -xf` reads it on any machine.

**A snapshot's name** is drawn from what restic records of it: its path, its
tag, `scheduled` or `pre-restore`, and its time, set to the second the
description carries (`--time`, restic running in UTC), under the host
`sitesolide`, a constant: `cms-20261004T130211Z.tar`,
`cms-20261004T130211Z-pre-restore.tar`. A copy in the bucket keeps all three,
hence the same name. A snapshot restic holds that is not of this shape, one
made by hand for instance, is never the component's, and never forgotten.

**restic runs the copy itself** (`backup --stdin-from-command`), and keeps a
snapshot only if the copy exits 0: a copy that fails, is killed or runs past
its time leaves none, nor does a restic stopped by SIGTERM or SIGKILL
(measured on 0.18.0 and 0.18.1). Fed through a plain pipe instead, restic
would store a stream cut short as a snapshot. Every snapshot is then **read
back at once**, `restic dump` into the same tar reader as the extraction's:
one reported taken has been read back and accepted, which proves the
restore's own path every hour, and one that does not read back is forgotten
on the spot. A restore checks the project and the time the description names
against the snapshot it was asked for: a tar stored under another project's
name, or another time's, is refused before anything stops.

`sitesolide-backup.timer` runs every hour, five minutes of random delay at most.
A run missed while the machine was off is made at boot.

### Retention

By default: the newest snapshot of each of the last **24** hours that have one,
of the last **7** days and the last **4** ISO weeks, plus the last **3**
snapshots taken before a restore. "Hours that have one", not hours of the clock:
a machine stopped for three days keeps its history. The newest snapshot is
never forgotten, nor a snapshot that is not the component's, and retention only
happens inside a run, under the lock a restore also takes.

The policy lives in one place, [retention.ts](retention.ts), and the unit's
environment overrides it: `BACKUP_KEEP_HOURLY`, `BACKUP_KEEP_DAILY`,
`BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_PRE_RESTORE`. The simplest place for them is
`/etc/sitesolide/dashboard-backup.env` (below), read at every run. The same
policy decides for the bucket. **restic only carries it out**: the run tells
it `forget <id>...`, never one of its own `--keep-*` policies, which differ
(they keep "the oldest snapshot additionally" when there are not enough,
and count hours in the machine's zone).

**`prune` runs once a day**, not hourly: a forget costs nothing on disk until
a prune, and a prune holds an exclusive lock. On the server it may repack no
more than a quarter of the room above the reserve; on the bucket it tolerates
10% of unused data, repacking there meaning a download and an upload. See
[maintenance.ts](maintenance.ts).

Count the room it takes: restic stores what changed since the hour before,
compressed. Measured on 8 October 2026 on a data folder of 227 MB (a 77 MB
SQLite database, 140 MB of uploads): an idle hour adds 24 KB, an hour of light
writes 3.7 to 16.6 MB, an hour of heavy writes 17.6 to 28.6 MB, where an
archive of the format before restic took 170 MB every hour. **A database
written in its middle is stored almost whole every hour**: `VACUUM INTO`
rewrites every page after the first row that changed, so a busy database
costs about its compressed size per kept snapshot, as it did before, while a
quiet one costs nothing. **A run never fills the disk**: it refuses a snapshot
that would leave less than `BACKUP_DISK_RESERVE` bytes free (1 GiB by
default), and stops one that would, since one disk carries every site. Root
says how much room the disk has above the reserve; the copy, which alone sees
the data, measures it and refuses what does not fit twice, still the worst
case, a first snapshot or a data folder rewritten whole.

### The status file

`/var/lib/sitesolide-backup/last-run.json`, rewritten at the end of every run,
whatever happened:

```json
{ "startedAt": "2026-10-04T13:02:11.000Z", "finishedAt": "2026-10-04T13:02:19.000Z", "ok": true,
  "projects": { "cms": { "ok": true, "snapshot": "cms-20261004T130211Z.tar", "error": null } },
  "checks": { "local": { "at": "2026-10-04T03:02:30.000Z", "ok": true, "error": null }, "offsite": null,
              "since": "2026-09-30T13:02:11.000Z", "offsiteSince": null } }
```

`snapshot: null` with `ok: true` is a project left out on purpose. A project
whose snapshot was taken but whose offsite copy failed is `ok: false` with its
snapshot named. `checks` is the last daily check of the server's repository
and of the bucket's (null before the first, and without a bucket), and
`since` and `offsiteSince` when checks of each were first due; the monitor
warns when one failed, or none came for three days, counted from the last
check or, before the first, from when checks were first due. The errors never
name a file inside a project's data, never carry a figure of its size (the
file is world-readable, and a project's tree is its own business), never
carry a credential, and never quote restic, whose words may name a
repository's paths: they are fixed sentences chosen by restic's exit code.
The details, paths, figures and restic's own words included, go to the
journal (`journalctl -u sitesolide-backup`).

The file is written whatever happens to a project: whatever one project's
snapshot throws is that project's failure, and the run goes on to the next.
A database of the component that does not open costs the audit, the index and
the import, not the snapshots nor the file; a setting at fault in
`/etc/sitesolide/dashboard-backup.env` writes `ok: false` with no project, and
the reason to the journal; so does a repository that does not open, its
sentence saying what to do.

## Who may touch what

```
sitesolide-backup.timer, every hour
   v
backup.js run                        root, CAP_DAC_READ_SEARCH only, no write outside its folders,
   |                                 /etc/sitesolide hidden
   |-- lists  /srv/sites/*           the projects, their manifests; whether a data folder is
   |                                 empty, asked of `find`, which stops at the first name
   |-- starts, for each project, within its share of the time:
   |     systemd-run --pipe --uid=site-<slug> ... backup.js hook          a service's backup command, if declared
   |        as the project, in its service's walls, its environment, its
   |        secrets read by PID 1, the loopback alone: fills BACKUP_DIR,
   |        /var/cache/sitesolide-backup/<folder>/hooks/<unit>
   |     restic backup --stdin-from-command -- systemd-run --pipe --uid=site-<slug> ... backup.js copy
   |        restic, root, the repository's key, under choom; the copy as the
   |        project, /srv an empty mount with its data alone bound back, no
   |        network at all: measures the data, refuses what does not fit,
   |        archives BACKUP_DIR in place of the live folder, its tar on standard
   |        output, straight into restic
   |     restic dump <id> /<folder>.tar    read back by the tar reader, or forgotten
   |     systemd-run --pipe --uid=site-<slug> ... backup.js discard       whatever happened, 15 s at most
   |        as the project, no network: removes what the commands left, and
   |        what an earlier run left; what it does not finish, the next does
   |-- imports the archives of the format before restic, then removes them seven days on
   |-- restic forget <id>...         what retention decided
   |-- restic copy <id>... to the bucket's repository, its credentials in that call's environment alone
   |-- once a day, or at once on `bin/deploy-backup.sh check`: restic prune, restic check --read-data-subset
   |-- after a failure that left packs behind: restic prune --max-repack-size 0
   `-- writes /var/lib/sitesolide-backup/last-run.json, the index of the snapshots, and its audit

dashboard, Backups, an unlocked session, the slug retyped
   v
steward                              checks against the index, writes the request, starts the unit, does not wait
   v
sitesolide-restore@<slug>            root, one-shot, writes only into /srv/sites/<slug> and the repository,
   |                                 no network, /etc/sitesolide hidden
   |-- consumes the request, takes the lock
   |-- finds the snapshot in the server's repository, or the bucket's
   |-- measures the current data, AS THE PROJECT, for the room
   |-- streams it into /srv/sites/<slug>/.restore-incoming, extracted AS THE PROJECT, from
   |     restic dump <id> /<slug>.tar                  the server's repository
   |     systemd-run --pipe -p DynamicUser=yes ... backup.js download
   |        a user of its own, the network and the bucket's settings, no
   |        project's rights, restic dump --no-cache   the bucket's repository
   |-- stops nothing without the time left for what follows
   |-- marks the services stopped, stops them
   |-- snapshots the current data, `pre-restore`, into the repository
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
project's rights, never root's. restic only chunks, hashes and encrypts the
bytes the copy streams; what root reads back is read by [tar.ts](tar.ts),
which accepts files and folders only and refuses any path that is absolute,
climbs or is not UTF-8.

**restic, and what it is handed.** Every call gets an environment built from
nothing ([restic.ts](restic.ts)): the zone fixed to UTC, `GOMAXPROCS=2`, a
`GOMEMLIMIT`, its cache and temporary packs in `/var/cache/sitesolide-restic`,
on disk (Debian 13 mounts `/tmp` as a tmpfs on new installations, which
would be charged to the unit's memory), the repository and its password.
The bucket's credentials and passphrase reach only the calls to the bucket:
the backup, whose command restic starts with its own environment, never holds
them. Its stdin is never a terminal. Under systemd it runs through `choom`, the
first process the kernel kills if a unit's memory runs out, and the units say
`OOMPolicy=continue`: an overrun costs that step, said so, never the status
file.

**restic's locks.** Every call to restic of this machine runs under the
component's own lock (`lock.ts`), a run's or a restore's, so restic's locks
only ever meet two things. A lock left by a restic killed with SIGKILL (the
OOM killer, a reboot, the run's deadline; SIGTERM removes its own): a backup
goes on beside a shared one, but forget and prune refuse it, and a stale
exclusive one, a prune's or a check's, refuses everything, a listing
included. So a run or a restore that finds locks in the server's repository
first runs `restic unlock`, which removes only stale ones, a dead process of
this machine or a lock older than 30 minutes; every run begins its work on
the bucket with `restic unlock` there too; and a call, a listing included,
that finds a lock anyway removes the stale ones and is tried once more. A
restore from the bucket alone cannot do so: its download child is not root,
and could take a live lock of root's for a dead one; it fails, said so, until
the next run has unlocked the bucket. And a person running restic by hand: a
live lock is never removed, the exclusive steps fail and say "the repository
is locked by another restic process", the snapshots still taken.

**What a failure leaves.** A snapshot that fails once restic has started (a
copy stopped, killed or refused late, the disk at its reserve, a read back
that fails) leaves packs no snapshot uses. A run that saw one ends, still
under the lock, with `restic prune --max-repack-size 0`, which deletes wholly
unused packs and repacks nothing: a project failing late every hour cannot
fill the disk for the others; a restore whose own snapshot failed so has the
next run do it. A snapshot that is not wanted (restic finishing as it was
stopped, a summary that does not read, a read back that fails) is forgotten
at once; one restic would not forget then, a person's live lock in the way,
is recorded in the component's database (`doomed`), kept out of every
listing, index and copy, and forgotten at the next run's start.

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

**The steward never runs restic.** It has neither restic nor the keys, and no
network: the run writes the index of both repositories into the component's
database (`snapshots`), and the restore adds its own snapshot there, which the
steward reads for the page. The repository stays the truth: a restore
resolves its snapshot there, and refuses one the index still listed but
restic no longer has.

## Restoring from the dashboard

A site's *Backups* section, then *Restore* on a snapshot, for the owner or an
Admin of the project. The dashboard asks for its unlock, as for a secret, the
owner's password or the Admin's forced sign-in, then for the slug, retyped.
The dialog lists what the server does, then follows it phase by phase.

- **The current data is saved first**, as a *Before restore* snapshot: restoring
  that one undoes the restore. The last three are kept whatever their age.
- **Nothing changes until the snapshot has been extracted**: a snapshot that
  does not read, or that names another project or another time than the one
  asked for, stops the restore before the service is stopped.
- **A folder a service keeps live is saved as its files**: its services are
  stopped, nothing writes it, and its backup command, which would need its
  server, does not run. The description says so (`liveAsFiles`).
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

From the machine's own repository. restic reads it as root, and the extraction
runs as the project, like the component's: the tar is handed over through a
pipe.

```bash
ssh you@your-machine
sudo -i
export RESTIC_REPOSITORY=/var/backups/sitesolide-restic RESTIC_PASSWORD_FILE=/var/backups/sitesolide-restic.key TZ=UTC
restic snapshots --path /cms.tar                  # the times, the ids, the kinds as tags
ID=<the snapshot's id>

# 1. The snapshot, extracted beside the data, as the project.
install -d -m 750 -o site-cms -g site-cms /srv/sites/cms/.restore-incoming
restic dump "$ID" /cms.tar | sudo -u site-cms tar -xf - -C /srv/sites/cms/.restore-incoming --strip-components=1 data

# 2. Stopped, swapped, started.
systemctl stop cms
mv /srv/sites/cms/data /srv/sites/cms/.restore-previous
mv /srv/sites/cms/.restore-incoming /srv/sites/cms/data
systemctl start cms
systemctl is-active cms

# 3. Running as it should: the previous data goes. Not: swap back, as above.
rm -rf /srv/sites/cms/.restore-previous
```

`restic dump "$ID" /cms.tar | tar -xOf - sitesolide-backup.json` says which
project and which time a snapshot holds, before anything is restored.

For the landing, the folder is the zone's name, the account `site-landing` and
the unit `sitesolide-landing`. For the dashboard, the unit is `dashboard`; for
the portal, `portal`, and a copy of the portal brings back the audit of its
time, and a copy from before the access registry the old tables of who could
open which site, without the mark `data/access-from-steward`. The portal still
reads the steward's projection while it is there, and leaves the mark again;
only with the projection missing would it decide from those old tables, so
check after the restore that `sudo curl -s http://127.0.0.1:3026/admin/access`
answers `"reading":"steward"`.

**From the bucket, the machine itself being gone**, on any machine with stock
restic (any recent version; Debian, Homebrew, or restic's own release), and
nothing of this repository:

```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...       # credentials that may read the bucket
export AWS_DEFAULT_REGION=fsn1                               # BACKUP_S3_REGION, if you set one
export RESTIC_REPOSITORY=s3:https://fsn1.your-objectstorage.com/my-backups/sitesolide-restic
restic snapshots --path /cms.tar                             # asks for the passphrase
restic dump <id> /cms.tar > cms.tar
tar -xOf cms.tar sitesolide-backup.json                      # the project and the time: the one you meant
mkdir cms-data && tar -xf cms.tar -C cms-data --strip-components=1 data
```

The repository's address is `s3:<BACKUP_S3_ENDPOINT>/<BACKUP_S3_BUCKET>/<BACKUP_S3_PREFIX>-restic`,
`sitesolide-restic` with the default prefix. An object of the format before
restic still in the bucket (`<prefix>/<folder>/<archive>.tar.gz.enc`) is read
by this version's `bun backup.ts decrypt <file> <output>`, as before.

## The offsite copy

Optional, and off by default: snapshots then stay on the server only, which
dies with the server. Configured, every run copies to the bucket's repository
each project's new snapshot first, then the older ones it lacks, and applies
the same policy there.

**A restic repository of its own**, `<prefix>-restic` in the bucket, beside
the objects of the format before restic and never among them. It is filled by
`restic copy` from the server's repository, **snapshot by snapshot**: the ones
the server's retention keeps, that the bucket lacks, and that the bucket's
retention would keep too. Never "copy everything": restic copies again a
snapshot the bucket has forgotten, which would have the two fight every hour.
The run initialises it the first time it finds none (restic's exit code 10),
with the server's chunker parameters (`init --copy-chunker-params`), so that
what both hold is cut alike and stored once: an hour copied adds to the bucket
what it added on the server. Any other answer is reported, never a new
repository.

**Encrypted by restic, on the machine, before anything leaves it**: the
bucket's provider stores data it cannot read, and a stolen access key yields
nothing without the passphrase. restic authenticates every file it reads:
someone who may write to the bucket cannot forge a snapshot, nor give one
another project's path or another time, and the restore checks the
description against the name all the same.

**The passphrase is the only way back.** `BACKUP_ENCRYPTION_PASSPHRASE` is the
bucket repository's password: lose it, and every offsite copy is noise. Put it
in your password manager the moment you set it, not later, with the endpoint,
the bucket, the region and the prefix: with those and access to the provider's
account, which mints read credentials, the data comes back on any machine.
The server's own repository has another password, drawn at install, which
only matters while the machine exists.

**Changing the passphrase** in the dashboard alone cuts the bucket off: the
run then says the repository "does not open with BACKUP_ENCRYPTION_PASSPHRASE".
Change it in the repository first, then in the dashboard:

```bash
export RESTIC_REPOSITORY=s3:... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
restic key add                 # asks for the current passphrase, then the new one
restic key list                # the new key's id beside the old one
# Set the new passphrase in the dashboard's Secrets, check the next run, then:
restic key remove <the old key's id>
```

**A second key, kept offline**, is optional: `restic key add` once more, with
a passphrase you write down and keep outside the password manager. Either
opens the repository.

**Versions and deletions.** A compromised machine holds credentials that can
delete in the bucket. If the provider offers object versioning or object
lock, turn it on: versions survive a deletion, and a lock refuses it. On
Backblaze B2, restic's documentation advises the lifecycle rule "keep only the
last version of the file", because its S3 backend only hides the files it
deletes; that would also throw away what versions are for. Keep prior
versions 30 days instead (B2's custom lifecycle rule, "days till hide" left
empty, "days till delete" 30): the bucket holds up to a month of what restic
pruned, which is the price of getting a deleted repository back. Object lock
is stronger still, where the provider has it.

### Setting it up

1. **A bucket**, and credentials that may read, write, list and delete in it:
   - Hetzner Object Storage: *Cloud Console > Object Storage*, a bucket in
     `fsn1`, `nbg1` or `hel1`, then *Security > S3 credentials*. The endpoint is
     `https://<location>.your-objectstorage.com`, the region the location.
   - Cloudflare R2: a bucket, then an R2 API token with *Object Read & Write* on
     that bucket only. The endpoint is
     `https://<account-id>.r2.cloudflarestorage.com`, the region `auto`.
   - Backblaze B2, through its S3 API, which restic recommends over its B2
     backend: a bucket, an application key on it. The endpoint is
     `https://s3.<region>.backblazeb2.com`, the region `<region>`, as the
     bucket's page shows it. The lifecycle rule above.
   - Any S3: its endpoint, `https://` only, and its region.

   In the bucket, a lifecycle rule that aborts incomplete multipart uploads
   after a day, where the provider has one: a copy stopped at the run's
   deadline may leave parts behind.

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

   No restart: the next run reads the file, and the page marks no restart
   pending, since the dashboard's service does not read it.
   Half a configuration is an error the *Backups* section shows, never a silent
   fallback to local copies.

4. **Check it now** rather than within the hour:

   ```bash
   ssh you@your-machine 'sudo systemctl start sitesolide-backup.service; sudo cat /var/lib/sitesolide-backup/last-run.json'
   ```

5. **Recover once**, from a workstation, with the commands of
   [Restoring by hand](#restoring-by-hand-when-the-dashboard-does-not-answer):
   a passphrase never tried is a passphrase you do not have.

## Verification

Every snapshot is read back as it is taken. Once a day, the run prunes and
checks a part of each repository (`restic check --read-data-subset=n/t`): the
server's in seven parts, the whole read every week; the bucket's in
twenty-eight, every pack within the four weeks the policy keeps, a
twenty-eighth of the bucket downloaded a day. A part whose check failed, or
was cut at the run's offsite deadline (45 minutes), is reported failed and
read again the next day; the others follow in turn. The first check comes a
day after the first run. On a day the bucket does not answer, its last check
stays as it was, and its age is the monitor's to judge. The verdict goes into
the status file's `checks`, the page's *Last check*, and the monitor, which
warns on a failed check or none for three days. A check that fails is a
repository to repair by hand, `restic check` then `restic repair` as its
message says, before trusting new snapshots to it.

**Now, rather than within a day**, for a test machine or an operator:

```bash
bin/deploy-backup.sh check
```

It lays `/var/lib/sitesolide-backup/maintenance-now`, root's, and starts a
run: the run's own unit, its walls and its lock, which takes the snapshots as
usual and then prunes and checks both repositories whatever the hour of the
last maintenance, removes the file, and writes `checks`. The script prints
the status and the checks' verdicts, and fails when one failed.

## Limits

What one project can cost the others, at most, and what a snapshot can be.

| What | Bound | Where |
|---|---|---|
| Entries of an archive, `data/` and the description counted | 2,000,000: the copy refuses beyond, as the extraction does | `MAX_ENTRIES`, copy.ts |
| Bytes a copy archives | the data measured at its start, plus a quarter and 64 MiB at least, within the room above the reserve | `copyBudget`, copy.ts |
| Room a snapshot needs | twice the data's apparent size (a sparse file counts whole), above `BACKUP_DISK_RESERVE`: the database copies and the worst case of what restic stores | child.ts |
| A snapshot while restic writes | the repository's disk measured every second, the copy and restic stopped at the reserve | snapshot.ts |
| A project's time in a run | its share of what is left of the 25-minute window among the projects still to come, one minute at least, `BACKUP_CHILD_TIMEOUT_MS` (20 minutes) at most; the copy, restic and the read back share it; cut short, it is tried again once every other project has had its turn | `projectTime`, run.ts |
| A backup command | the project's time, shared with the copy that follows it; its service's `MemoryMax` and 128 MiB for the Bun that runs it; stopped when the disk of the repository or of its `BACKUP_DIR` comes down to the reserve, measured every second; its verdict its exit code alone, what it prints going to the journal, its last 8 KiB | hooks.ts, child.ts |
| Removing what a backup command left | after the snapshot, outside the project's time: 15 seconds, then left to the next run, whose command empties its folder first; a folder a project left read-only is made writable again by its owner, never left to root | `DISCARD_TIMEOUT_MS`, hooks.ts |
| Room a snapshot with a backup command needs | measured once the command is done, its copy already on the disk: twice what the archive holds, the command's copy counted and the live folder not | `measureCopy`, copy.ts |
| Reading a snapshot back | the same time, the same entries, no more bytes than the room | `verifyArchive`, snapshot.ts |
| A child past its time | killed (`systemctl kill --signal=SIGKILL`), its unit's `RuntimeMaxSec` and `TimeoutStopSec=15s` as the backstop: a copy stopped by its own service does not hold the run | runner.ts |
| restic past its time | SIGTERM, which removes its lock and saves nothing, SIGKILL ten seconds later | restic.ts |
| Copies to the bucket | none started after 40 minutes, every call to the bucket stopped at 45; the status is written before the unit's 50 | run.ts |
| The daily prune and check | started only in the first 30 minutes of a run, stopped at 45 with the rest; the prune repacks a quarter of the room above the reserve at most | maintenance.ts |
| The import of the archives of the format before restic | none started after 30 minutes, none running past 40; one archive 20 minutes at most; none started without its size above the reserve, the disk measured every second while restic writes | legacy.ts |
| A restore | 90 minutes in all; a measure 10, the snapshot streamed into the extraction 20 from the server, 20 and 20 from the bucket, a snapshot 20, the swap and the watch 10 | restore.ts, the unit |
| Memory | a run and a restore 512M, Bun and one restic beside it (restic measured at 57 to 174 MiB on two CPUs with Debian's 0.18.0, `GOMAXPROCS=2`, `GOMEMLIMIT=128MiB`, killed first if that is not enough, `OOMPolicy=continue`); a child 512M, a backup command its service's; a data folder too big for its copy's 512M costs that project its snapshot | the units, restic.ts, runner.ts |

**What deduplication saves on a PostgreSQL cluster, measured**, less than
on files. A heap or index page with 64 bytes of free space or more holds a
run of zeros, and restic's chunker cuts on any such run past its 512 KiB
minimum: in a relation file where most pages have one, the chunks fall at a
distance from the previous cut rather than on content, and an entry that
changed size earlier in the tar moves every one of them, for the whole file.
Saved as files, each would be chunked from its own start. Two scheduled runs
of this component an hour of writes apart (Debian 13, PostgreSQL 17,
restic 0.18.0; 36,000 transactions, an hour at ten a second, run in six
minutes), the bytes the second added to the repository, compressed:

| The database | Added by the tar | Had it been files |
|---|---|---|
| An application's, 513 MB: page views that append an event and update their reader, the active readers most often; posts written, recent ones edited | 123 MB (its posts table, 234 MB, re-stored whole; 35 MB of an index whose pages changed by 2 MB) | 67 MB |
| pgbench at scale 20, 307 MB, its rows updated anywhere at random | 21 MB, about all of it | 18 MB |
| A table of identical rows, behind one 1,000 rows longer | 5.7 MB, all of it, its rows compressing to almost nothing | 0.2 MB |

A table whose pages are full (small rows appended, an event log) keeps its
chunks: 8 MB of 228 MB there, 7 MB as files. The cost is the repository's
size, bounded by retention and the daily prune; what a snapshot holds is
unaffected.

**Why not a fresh PID namespace for the copy.** The copy runs under the
project's uid, so the project's service may `SIGSTOP` it. `PrivatePIDs=`
(systemd 257, Debian 13) would not prevent it: a process may signal those of a
descendant PID namespace, and SIGSTOP reaches even a namespace's init when sent
from an ancestor (pid_namespaces(7)). The time bound above is what handles it.

## Deployment

In this order, from the workstation, each step checked before the next. The
privileged commands are the scripts'; nothing here is done by hand on the
machine except reading.

1. **`bin/deploy-backup.sh install`.** Installs restic from Debian's archive
   if it is missing, and refuses one older than 0.18.0 (Debian 13 ships
   0.18.0); builds `backup.js`, installs it with the three units, draws the
   repository's key once, initialises the repository when restic says there
   is none, creates `/var/backups/sitesolide` (0700) and
   `/var/lib/sitesolide-backup`, reloads systemd. It starts nothing and takes
   no snapshot. Check: it ends with *installed and verified, nothing started*,
   and `systemd-analyze verify` said nothing.
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
   repository's size, the archives of the format before restic left. For a
   first check of the repositories without waiting a day,
   [`bin/deploy-backup.sh check`](#verification).
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

**For the services' backup commands** (`backup` under a service, or the
object form of the top-level key), every component that embeds the
manifest's validation must know the key before a project declares one, and
the run must know what to do with it. In this order, from a checkout or with
`sitesolide upgrade`, whose order is the same and which finds each of them out
of date by its fingerprint:

1. `bin/deploy-backup.sh install`. Before it, an older `backup.js` reads the
   key without a word and copies the live folder as files, the very snapshot
   this exists to prevent. From its first run, a project that already runs
   PostgreSQL or MongoDB in its data without declaring it fails its snapshot,
   where it used to be saved in a state that may not restore: the monitor
   says so, and the project is deployed again with its backup command once
   the steps below are done.
2. `sitesolide deploy` from `dashboard/`: its control API judges a token's
   manifest, and an older one refuses the key as unknown. The steward embeds
   the same module but refuses nothing on it, reading the manifests as they
   are; `bin/deploy-steward.sh` brings its copy up to date, which
   `sitesolide upgrade` does before the dashboard.
3. `bin/deploy-gatekeeper.sh`: an older one refuses to change the general
   access of a site whose manifest carries the key, as unknown.
4. `bin/deploy-installer.sh`: an older one refuses the key in a token's
   deployment, and, rebuilding the loopback's project set for any project,
   would drop a project with one `start` and a backup command from it, its
   command then refused its own service's port.
5. The CLI of every workstation that deploys such a project, which validates
   the manifest before anything leaves.

`sitesolide deploy` of a project that declares a backup command searches the
server's `backup.js` for the feature (bin/cli/backups.ts,
`SERVICE_COMMANDS_FEATURE`, which `backup.js features` prints), and warns
when the component predates it or is missing; it refuses nothing, deploying
changing nothing of what the backups do. The installer, which deploys for a
token, does not ask: in the order above it is updated after the component.

The machine's loopback rule must carry the project set
(`bin/deploy-loopback.sh close`): `deploy` refuses a project with a backup
command without it, as it refuses one of several services. Then deploy the
project; its next hourly run takes its first snapshot from the command, and
`bin/deploy-backup.sh state` or the site's *Backups* section says how it went.

### From the archives of the format before restic

A machine that ran the version before has `.tar.gz` archives under
`/var/backups/sitesolide` and, with a bucket, `.enc` objects in it. The new
version writes neither. **Its first runs import them** into the repository
([legacy.ts](legacy.ts)), the newest first, no import started past 30 minutes
into a run nor running past 40, none started without its size above the
disk's reserve, the rest left to the next one:

- an archive on the server is read back by the tar reader, its description
  held to its name, stored by restic at its own time and kind, then proved
  byte for byte: the SHA-256 of `restic dump` must be the SHA-256 of the
  archive decompressed. A copy that differs is forgotten and the archive
  stays, said so in the journal and the audit;
- an object only the bucket holds, the server having been rebuilt, is fetched
  by a download child, decrypted and decompressed, stored the same way, read
  back and held to its name;
- **seven days after its copy was verified**, the copy still in the
  repository, the archive is deleted from the server, and the object from the
  bucket once the bucket's repository holds its copy; in the very run that
  retention forgets the copy, which the version before would have pruned
  too, recorded as it forgets. Never on an absence: a copy merely missing, a
  repository lost and made again for one, deletes nothing, and the archive is
  imported again into the new repository, its seven days counted anew. Until
  then, going back to the version before finds its files.

A request from a steward that predates restic names a `.tar.gz`: the restore
takes its imported copy, or says it has not been imported yet. The next
version removes the import, and its install refuses while an archive remains
or a copy is younger than seven days: upgrade through this one. An archive
that never imports (damaged, or not what its name says) is the author's to
delete by hand, once read.

**The order, for a machine on the version before:** `sitesolide upgrade`
(the backup install, which installs restic and initialises the repository,
then the steward, the dashboard, and the monitor last); then a run by hand,
`ssh you@your-machine 'sudo systemctl start sitesolide-backup.service'`, which
imports and writes the index the new steward reads. Until that run, the page
lists no snapshot, the archives still on the disk.

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
`bin/deploy-steward.sh` and `sitesolide deploy`. The repository, its key and
restic's cache stay until you delete them; so does
`/etc/sitesolide/dashboard-backup.env`.

**Back to the version before restic**: its `bin/deploy-backup.sh install`,
its steward and dashboard. Within seven days of the import, its archives are
still on the disk and its objects in the bucket, and it never sees
`sitesolide-restic`. The snapshots taken since exist only in restic: restore
them by hand (above). Past seven days, it starts with an empty history, and
everything before is restored by hand with restic. Coming forward again
imports what it wrote meanwhile.

## What only the machine can prove

The tests run everything on the workstation, restic included, the copies and
extractions as real child processes, without the isolation. What depends on
systemd, Linux or the provider is to be checked on a machine before trusting
it:

```bash
# The units load, and the template through an instance.
sudo systemd-analyze verify /etc/systemd/system/sitesolide-backup.service \
  '/etc/systemd/system/sitesolide-restore@.service:sitesolide-restore@cms.service'

# A run, and what it wrote.
sudo systemctl start sitesolide-backup.service; journalctl -u sitesolide-backup -n 50
sudo cat /var/lib/sitesolide-backup/last-run.json
sudo env RESTIC_REPOSITORY=/var/backups/sitesolide-restic RESTIC_PASSWORD_FILE=/var/backups/sitesolide-restic.key restic snapshots
sudo ls -la /var/cache/sitesolide-restic /var/cache/sitesolide-backup/

# restic under the run's walls: a Go binary under SystemCallFilter=@system-service,
# no status=31/SYS in the journal, its memory peak far under 512M.
journalctl -u sitesolide-backup -n 5   # "Consumed ... memory peak"

# The copy runs as the project, in its walls: during a run,
systemctl list-units 'sitesolide-backup-copy-*'
systemctl show 'sitesolide-backup-copy-cms-*' -p User -p IPAddressDeny -p ProtectSystem
# and its database's side files still belong to the project afterwards:
sudo ls -l /srv/sites/cms/data/

# restic, started by the run, starts the copy's unit itself: the snapshot reads back.
sudo env RESTIC_REPOSITORY=/var/backups/sitesolide-restic RESTIC_PASSWORD_FILE=/var/backups/sitesolide-restic.key \
  restic dump latest --path /cms.tar /cms.tar | tar -tf - | head

# The steward can write a request and read the database under its unit.
sudo -u site-dashboard curl -s --unix-socket /run/sitesolide-steward/secretaire.sock 'http://steward/backups?slug=cms'

# A restore end to end, on a test site, from the dashboard; then:
sudo cat /run/sitesolide-backup/restore/<slug>.json; journalctl -u 'sitesolide-restore@*' -n 50

# The monitor, as its unprivileged user, reads the status.
sudo -u nobody cat /var/lib/sitesolide-backup/last-run.json
```

A service's backup command, on a test site that declares one, during a run:

```bash
systemctl list-units 'sitesolide-backup-hook-*'
systemctl show 'sitesolide-backup-hook-test-*' -p User -p IPAddressDeny -p IPAddressAllow -p MemoryMax \
  -p BindReadOnlyPaths -p InaccessiblePaths -p EnvironmentFiles -p WorkingDirectory
# Its secrets reach it, /etc/sitesolide hidden from it, and its service's port answers it
# (--expand-environment=no: the shell reads the variable, PID 1 never writes its value
# into the command line):
sudo systemd-run --wait --pipe --expand-environment=no --uid=site-test -p InaccessiblePaths=-/etc/sitesolide \
  -p EnvironmentFile=-/etc/sitesolide/test.env -p IPAddressDeny=any -p IPAddressAllow=localhost \
  sh -c 'test -n "$POSTGRES_PASSWORD" && ! ls /etc/sitesolide && /usr/lib/postgresql/17/bin/pg_isready -h 127.0.0.1 -p 3081'
# Afterwards: nothing left in its staging, the snapshot holds the command's copy.
sudo ls -la /var/cache/sitesolide-backup/test/
```

Also to measure there: the memory of a run and of a copy on the largest site
(`MemoryMax` 512M each), the time a copy and its restic take on it, and that a
restore's `systemctl stop` and `start` act on every unit of a project with
several services.

What the bounds rely on, which the workstation cannot show, on a test machine:

```bash
# EnvironmentFile= is read by PID 1 although /etc/sitesolide is hidden from the units:
sudo systemctl show sitesolide-backup -p InaccessiblePaths -p EnvironmentFiles
sudo systemd-run --wait --pipe -p InaccessiblePaths=-/etc/sitesolide \
  -p EnvironmentFile=/etc/sitesolide/dashboard-backup.env sh -c 'test -n "$BACKUP_S3_BUCKET" && ! ls /etc/sitesolide'

# The run's emptiness test, find inside the unit's walls (CAP_DAC_READ_SEARCH, @system-service):
sudo systemd-run --wait --pipe -p CapabilityBoundingSet=CAP_DAC_READ_SEARCH -p ProtectSystem=strict \
  -p SystemCallFilter=@system-service /usr/bin/find /srv/sites/cms/data -mindepth 1 -maxdepth 1 -print -quit

# restic killed first, and the run going on, when the unit's memory runs out:
# a drop-in setting MemoryMax=96M on sitesolide-backup.service, a run, then the
# drop-in removed; the status is written, the failed projects say restic failed.
journalctl -u sitesolide-backup -n 20 | grep -i oom

# A folder of 650,000 long names in a throwaway site's data: the run's memory stays low,
# that site fails or is saved, the others are saved, and the status is written.
sudo -u site-test sh -c 'cd /srv/sites/test/data && mkdir crowd && cd crowd && seq -f "%0240g" 650000 | xargs touch'
sudo systemctl start sitesolide-backup.service
journalctl -u sitesolide-backup -n 3   # "Consumed ... memory peak": far under 512M
sudo cat /var/lib/sitesolide-backup/last-run.json

# A copy stopped by its own service: the run moves on at the site's share.
sudo systemctl start --no-block sitesolide-backup.service; sleep 5
sudo -u site-test pkill -STOP -f 'backup.js copy'
journalctl -u sitesolide-backup -f   # "out of its time, tried again after the others", then the next site

# The restore has no network, and its download child does, running restic:
systemctl show 'sitesolide-restore@test.service' -p IPAddressDeny -p RestrictAddressFamilies
systemctl list-units 'sitesolide-backup-download-*'   # during a restore from the bucket only

# A restore cut short with the services stopped is started again by its ExecStopPost:
# a test site, a restore from the dashboard, then, once the page says "Saving the current data first.":
sudo systemctl kill --signal=SIGKILL sitesolide-restore@test.service
systemctl is-active test; sudo cat /run/sitesolide-backup/restore/test.json   # active; "cut short"
```

And with a bucket the author creates, B2 for real: a run that initialises its
repository, the copy of every project, a recovery from a workstation with
stock restic, and a passphrase rotation with `restic key add` and `remove`.

## Tests

```bash
cd dashboard && bun test tests/backup-
cd bin && bun test tests/cli-backups.test.ts tests/e2e/backups.test.ts
dashboard/scripts/postgres-backup-proof.sh   # Docker and the network: a real PostgreSQL, saved and restored
dashboard/scripts/s3-backup-proof.sh         # Docker and the network: Debian's restic against an S3 gateway
```

restic is a prerequisite of the tests, like Bun (`brew install restic`,
`apt-get install restic`): without it, the tests that store snapshots are
skipped, and say so. They run it on its local backend, a repository per test
tree copied from one initialised per run, the bucket being another folder.

Retention and its decisions by id, snapshot names, the tar reader against
forged archives and against `tar` itself, restic's environment and command
line, what it answers read back, a copy that fails or is killed leaving no
snapshot, a stale lock removed and an exclusive call tried again, exit codes
10 and 12 in fixed sentences, the copy's report under restic's 64 KiB per
line, a snapshot that does not read back forgotten, a snapshot of WAL
databases written to by another process during the copy and restored with
`PRAGMA integrity_check`, a whole run on a throwaway tree, the copy to the
bucket's repository by id, its initialisation with the server's chunker
parameters, the snapshots the bucket would drop never copied, the daily prune
and check and a damaged repository, a restore and its rollback with a
simulated systemd, from the bucket through a download child, the steward's
routes and the relay, the units. The bounds (tests/backup-bounds.test.ts):
root's memory against a folder of 60,000 long names, measured on a child's
peak, a copy stopped by `SIGSTOP`, a terabyte of holes grown after the
measure, a data folder swapped for a link, the entries counted alike by the
copy and the extraction; a restore cut short and its cleanup, a download past
its time, a damaged database saved raw, a snapshot stored under another
project's name or another time. The services' backup commands
(tests/backup-hooks.test.ts), as before. The import of the archives of the
format before restic (tests/backup-legacy.test.ts): byte for byte, kept seven
days, a mislabelled or damaged archive left alone, an object only the bucket
holds fetched by a download child. `postgres-backup-proof.sh` runs the recipe
of docs/manifest.md in a Debian 13 container with PostgreSQL 17 and Debian's
restic, the real `backup.js` built as `bin/deploy-backup.sh` builds it: a
snapshot taken while rows are written, the cluster refused without its
command, restored, started, every row committed before the backup there,
`pg_amcheck` clean. `s3-backup-proof.sh` runs a whole run, the copy to an S3
bucket served by versitygw, a restore from the bucket through the download
child, a prune and a check, in the same container.
