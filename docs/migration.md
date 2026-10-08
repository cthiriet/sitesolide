# Migrating a machine installed before the rename

**Only for a machine that ran sitesolide before September 2026.** A fresh
install has nothing to do here; the names below are simply what it gets.

The other migration this page describes, [the access
registry](#access-the-registry-made-from-the-stores-before-it), concerns any
machine that ran a release before it, and happens on its own.

Opening the source meant giving everything an English name, and some of those
names are carried by the machine itself: systemd units, `/run` and `/etc`
paths, system accounts. A deploy alone does not rename them, systemd does not
rename a unit, and a reload does not re-read one.

Read the whole thing before starting. Every step is reversible except the last.
The whole sequence took about twenty minutes the one time it was played.

## What changes

| Before | After |
|---|---|
| `sitesolide-secretaire.service` | `sitesolide-steward.service` |
| `sitesolide-portier-on@.service` | `sitesolide-gatekeeper-on@.service` |
| `sitesolide-portier-off@.service` | `sitesolide-gatekeeper-off@.service` |
| `sitesolide-boucle.service` | `sitesolide-loopback.service` |
| `collecteur-etat.service` / `.timer` | `sitesolide-collector.service` / `.timer` |
| `/run/sitesolide-portier/` | `/run/sitesolide-gatekeeper/` |
| `/etc/caddy/verrous/` | `/etc/caddy/locks/` |
| `/etc/caddy/verrous-codes.json` | `/etc/caddy/lock-codes.json` |
| `/usr/local/lib/sitesolide/secretaire.js` | `.../steward.js` |
| `/usr/local/lib/sitesolide/portier.js` | `.../gatekeeper.js` |
| project `portail` | project `portal` |

The `portal` rename is the heaviest: its directory, its system account, its
unit, its secret file and its Caddy block all carry the slug.

## Your own configuration file

This one is on your workstation, not on the machine, and it is the only step
that also concerns an installation that has already been through everything
below. `~/.config/sitesolide/config.json` had French keys; four of them
changed:

| Before | After |
|---|---|
| `serveur` | `server` |
| `courriel` | `email` |
| `coffre` | `vault` |
| `projets` | `projects` |

`zone`, `contact`, `destinations` and `sites` do not move.

Nothing breaks if you do nothing: the CLI still reads the old keys, and says on
its error output that they are outdated. To be done with it, rewrite the file,
which keeps what it already holds and puts it back under the new names:

```bash
sitesolide init
```

The environment variables the scripts of `bin/` share with the CLI took the
`SITESOLIDE_` prefix at the same time, so that they do not collide with
anything in the environment of whoever installs this software. You only have to
care about them if you export one by hand or drive a script from a `cron`:

| Before | After |
|---|---|
| `SERVEUR` | `SITESOLIDE_SERVER` |
| `ZONE` | `SITESOLIDE_ZONE` |
| `COURRIEL` | `SITESOLIDE_EMAIL` |
| `CONTACT` | `SITESOLIDE_CONTACT` |
| `PROJETS_DIR` | `SITESOLIDE_PROJECTS_DIR` |
| `COFFRE` | `SITESOLIDE_VAULT` |
| `DESTINATIONS` | `SITESOLIDE_DESTINATIONS` |
| `SITES_DEPOT` | `SITESOLIDE_SITES_REPO` |
| `PROJET_DIR` | `SITESOLIDE_PROJECT_DIR` |
| `RETIRER` | `SITESOLIDE_REMOVE` |

`SITESOLIDE_ZONE` already existed, read by Caddy from
`/etc/caddy/sitesolide.env`. The two are now one and the same, and that file
holds a single line for it instead of two.

Three services read the zone or the contact address out of their environment,
so the machine has to be told. **In this order**, once the configuration file
is rewritten:

```bash
bin/deploy-api.sh                    # it now reads SITESOLIDE_ZONE, already in the file
bin/deploy-caddy.sh                  # rewrites /etc/caddy/sitesolide.env, dropping ZONE=
(cd dashboard && sitesolide deploy)  # its unit carried ZONE={zone}
(cd portal && sitesolide deploy)     # its unit carried CONTACT={contact}
```

The api comes first because `deploy-caddy.sh` takes the `ZONE=` line out of
`/etc/caddy/sitesolide.env`, and the api in service still reads it: between the
two, its ask endpoint would answer for an empty zone and let a name of the zone
through that the wildcard already covers. The dashboard and the portal carry
their own variable in their own unit, and wait for nothing. Until they are
deployed, the dashboard serves the landing out of a directory named by an empty
zone, and a locked preview shows no address to ask a code from.

Two flags of the password scripts were renamed with the rest, and both run on
the workstation alone, so there is nothing to deploy for them:
`dashboard/scripts/fingerprint.ts --saisir` is now `--typed`, and
`portal/scripts/fingerprint.ts --remplacer` is now `--replace`.

## What the workstation no longer keeps

Earlier versions kept three things on the workstation that now live on the
machine alone, or beside the configuration file:

| Before | Now |
|---|---|
| a projects folder with every generated unit and Caddy block | generated at deploy time, installed on the machine, kept nowhere else |
| `destinations.conf`, saying where each secret landed | follows from the name and the site, see [secrets.md](secrets.md) |
| a vault holding a copy of every secret | `~/.config/sitesolide/secrets/`, for what the workstation itself presents to production, and only that |
| `infra/secrets.auto.tfvars` and `infra/terraform.tfstate` | `~/.config/sitesolide/terraform/`, run through `bin/terraform.sh` |

Nothing changes on the machine for this, apart from the steward, which no
longer embeds a registry. In this order:

```bash
sitesolide init                  # rewrites the configuration without projects and destinations
bin/deploy-steward.sh            # the steward that reads the files present rather than a registry
bin/deploy-gatekeeper.sh         # embeds the block generator, which gained the check against the machine
```

Then move Terraform's values and state out of the repository:

```bash
mkdir -p ~/.config/sitesolide/terraform && chmod 700 ~/.config/sitesolide/terraform
mv infra/secrets.auto.tfvars ~/.config/sitesolide/terraform/terraform.tfvars
bin/terraform.sh init -migrate-state -force-copy
bin/terraform.sh state list      # the same resources as before
```

`init` copies the state to its new place and leaves the old file where it was:
once `state list` answers, move `infra/terraform.tfstate*` aside.

Last, the old vault. Keep the files your workstation presents to production, an
API token a command-line tool sends for instance, and move them to
`~/.config/sitesolide/secrets/`. The rest are copies of values the machine
holds, possibly older ones: delete them. Then drop the `vault` key from the
configuration, or point it at the new folder. The old projects folder and the
old registry can go with them.

## The pieces that have to be deployed together

Three renames cross the line between two deployments: the variables a unit sets
in front of a service, the routes of the steward's socket, and the fields of
the protocol the steward and the gatekeeper exchange. None of them is carried
by the machine, so none of them is fixed by the steps below: each is fixed by
the deployment of the piece that holds it, and the pieces do not negotiate. An
old one in front of a new one starts, answers, and serves nothing.

**The unit variables.** They now read in English, `DOSSIER_X` become `X_FOLDER`
or `X_DIR`, `FICHIER_X` become `X_FILE`, and the rest follow the word they
name:

| Before | After | Read by |
|---|---|---|
| `DOSSIER_SECRETS` | `SECRETS_FOLDER` | steward |
| `DOSSIER_UNITES` | `UNITS_FOLDER` | steward |
| `DOSSIER_ETAT` | `STATE_FOLDER` | steward |
| `DOSSIER_CADDY` | `CADDY_FOLDER` | steward |
| `FICHIER_EMPREINTE` | `HASH_FILE` | steward |
| `FICHIER_COMPTES` | `ACCOUNTS_FILE` | steward |
| `FICHIER_GROUPES` | `GROUPS_FILE` | steward |
| `PRISE` | `SOCKET` | steward |
| `GROUPE_PRISE` | `SOCKET_GROUP` | steward |
| `PROPRIETAIRES` | `OWNERS` | steward |
| `PORTIER_GESTE` | `GATEKEEPER_ACTION` | gatekeeper |
| `DOSSIER_BLOCS` | `BLOCKS_FOLDER` | gatekeeper, collector |
| `FICHIER_ENV_CADDY` | `CADDY_ENV_FILE` | gatekeeper |
| `FICHIER_ENV_ZONE` | `ZONE_ENV_FILE` | gatekeeper |
| `PROPRIETAIRE_BLOC` | `BLOCK_OWNER` | gatekeeper |
| `SONDE_ADRESSE` / `SONDE_PORT` / `SONDE_CA` | `PROBE_ADDRESS` / `PROBE_PORT` / `PROBE_CA` | gatekeeper |
| `UNITE_CADDY` / `UNITE_COLLECTEUR` | `CADDY_UNIT` / `COLLECTOR_UNIT` | gatekeeper |
| `FICHIER_ETAT` | `STATE_FILE` | collector, dashboard |
| `FICHIER_CODES` | `CODES_FILE` | collector, lock generator |
| `FICHIER_DOMAINES` | `DOMAINS_FILE` | collector, shared service |
| `FICHIER_AUDIENCE` | `AUDIENCE_FILE` | collector |
| `FICHIER_HOTES` | `HOSTS_FILE` | collector |
| `PROPRIETAIRE` | `OWNER` | collector |
| `PROPRIETAIRE_HOTES` | `HOSTS_OWNER` | collector |
| `DOSSIER_GARDE` | `DOOR_PAGES_DIR` | lock generator |
| `SECRETAIRE_PRISE` | `STEWARD_SOCKET` | dashboard |
| `PORTAIL_URL` | `PORTAL_URL` | dashboard |
| `FUSEAU` | `TIME_ZONE` | analytics |
| `CORPS_MAX` | `BODY_MAX` | analytics |
| `DUREE_MAX_S` | `MAX_DURATION_S` | analytics |
| `SELS_GARDES` | `SALTS_KEPT` | analytics |
| `VUES_PAR_MINUTE` / `VUES_MAX` | `VIEWS_PER_MINUTE` / `MAX_VIEWS` | analytics |
| `PAS_INSTANTANE_MS` / `PAS_PURGE_MS` | `SNAPSHOT_STEP_MS` / `PURGE_STEP_MS` | analytics |
| `CLASSEMENT_MAX` | `RANKING_MAX` | analytics |
| `URL_PUBLIQUE` | `PUBLIC_URL` | analytics |

Only two of them are set by a unit in service, and they behave differently:

- `GATEKEEPER_ACTION`, set by `Environment=` in each of the two gatekeeper
  templates. It has no default, on purpose: the gatekeeper refuses to start
  without it. An old template in front of the new `gatekeeper.js` therefore
  makes every portal change fail before it touches anything, with no result
  file, and the steward answers a failure. Both come from
  `bin/deploy-gatekeeper.sh`, which installs them in the same run, so they only
  drift if that script is not run at all.
- `DOMAINS_FILE`, set by `sitesolide-api.service`. Its default is the same path,
  `/etc/caddy/domaines.map`, so a stale unit here costs nothing. Redeploy it
  when convenient.

Every other variable in the table is read with its production default, and no
unit sets it. Renaming them changes how a service is launched by hand on the
workstation, and nothing on the machine.

**The steward's routes.** The socket now answers in English:
`/deverrouiller` is `/unlock`, `/verrouiller` is `/lock`, `/valeur` is
`/value`, `/contenu` is `/content`, `/fichier` is `/file`, `/projets` is
`/projects`, `/restaurer` is `/restore`, `/redemarrer` is `/restart`. `/log`,
`/variable`, `/password` and `/portal` do not move. The dashboard's own
`/api/secrets/*` follow the same names, and the page follows them.

The two ends live in two different deployments: the steward is
`/usr/local/lib/sitesolide/steward.js`, installed by `bin/deploy-steward.sh`,
and the relay that calls it travels with the dashboard's code, by an ordinary
`sitesolide deploy`. Deploy one without the other and the steward answers 404
to everything the other asks: the Secrets and Access sections of the dashboard
show a failure on every action, in both directions. Nothing else on the machine
is affected, and nothing is at risk, the steward refusing rather than acting.

**The protocol fields.** The steward and the gatekeeper already had to move
together, for a reason of their own: the fields of the result the gatekeeper
writes in `/run/sitesolide-gatekeeper/<slug>.json`, which the steward reads,
were renamed at the same time as the rest. `bin/deploy-steward.sh`,
`bin/deploy-gatekeeper.sh` and the dashboard's `sitesolide deploy` are
therefore one single deployment in three commands, and this is the only list of
them.

**Caddy's lock.** The lock that the gatekeeper and the workstation's tools
share, `/run/sitesolide-gatekeeper/caddy.lock`, carried French names, and every
one of them changed:

| Before | After | Written by |
|---|---|---|
| the file `caddy.lock/titulaire` | `caddy.lock/holder` | whoever takes the lock |
| the holder `portier` | `gatekeeper` | the gatekeeper |
| the holder `verrou` | `lock` | `bin/lock.sh` |

The lock lives in `/run`, so it does not survive a reboot, and nothing of it is
kept from one deployment to the next. What does cross the deployment is a lock
taken just before it and still held just after: between the moment
`bin/deploy-gatekeeper.sh` installs the new `gatekeeper.js` and the moment the
workstation pulls the new tools, one side writes `titulaire` and the other
reads `holder`, or the other way round.

**Nothing is at risk there, because a holder that cannot be read counts as
held**: the lock directory is still seen, still refuses, and is only taken over
once it is fifteen minutes old, exactly as for any other lock. The only visible
cost is the wording of the refusal, which says that an unidentified holder is
changing Caddy instead of naming the dashboard. It lasts as long as that one
lock, a few minutes at most.

**The protocol's own words.** Three sets of values the protocol carries were in
French and now read in English. They travel in a body, live, between the
steward, the dashboard's relay and the page, so the same pairing as above
applies: the steward and the dashboard deploy together, and an old one in front
of a new one shows a blank verb, a wrong icon or a verdict with no words.

| Where | Before | After |
|---|---|---|
| `Operation`, a journal line's verb | `deverrouillage`, `verrouillage`, `lecture`, `pose`, `retrait`, `creation`, `restauration`, `remplacement`, `motdepasse`, `redemarrage` | `unlock`, `lock`, `read`, `set`, `remove`, `create`, `restore`, `replace`, `password`, `restart` |
| `VerdictKind`, how a restart turned out | `actif`, `boucle`, `programme` | `active`, `looping`, `scheduled` |
| `FileKind`, what a managed file is | `contenu` | `content` |

The journal written by the steward of September 2026 also spells its field
names in French, `fichier` and `resultat`, its results `refus` and `echec`, and
one operation `portail`. They are read back the same way, through
`EARLIER_FIELDS` and `EARLIER_RESULTS`: a first version of the table translated
the operations alone, and the key check refused every earlier line before any
value was looked at.

**The journal's history is kept, and that is the question to ask here.**
`/var/lib/sitesolide-steward/journal.jsonl` is the one thing in this whole
section that remembers from one deployment to the next: it holds the Activity
section's history, and every line written before this rename spells its
operation in French. Those lines are not lost and are not rewritten. Re-reading
puts them under their new names, through a correspondence table in
`dashboard/src/secrets/log.ts`, `EARLIER_OPERATIONS` and `EARLIER_VERDICTS`.
A restart's verdict is the first word of `detail`, so only that word is
translated and the systemd state after it is left exactly as written.

The table is applied on reading and never on writing: `encodeEntry` accepts
only the current names, so the file stops taking French lines the moment the new
steward starts, and the two spellings sit side by side in it without conflict.
Truncation copies whole lines, so an old line that survives a truncation is
still read the same way. `dashboard/tests/secrets-log.test.ts` checks every
pair, and `tests/secrets-steward.test.ts` checks the whole path, from a line
planted in `journal.jsonl` to what `GET /log` answers.

Nothing has to be migrated on the machine for this, and nothing is at risk if
the deployment is rolled back: an old steward reads its own French lines as it
always did, and ignores the English ones the new one wrote, exactly as it
ignores any line it does not understand.

### Three files the machine keeps, renamed

These are not settings crossing between two pieces but files sitting on disk,
so the deployment writes the new name and leaves the old one behind:

| Before | After | Where |
|---|---|---|
| `etat.json` | `state.json` | `/srv/sites/dashboard/data/` |
| `freinage.json` | `rate-limit.json` | `/var/lib/sitesolide-steward/` |
| `droits.json` | `permissions.json` | under `/run`, inside a backup |

The snapshot is rewritten every minute by the collector, so the dashboard shows
an empty machine for at most that long and then fills again. The rate-limit
counter starts from zero once, which only means the password attempts already
recorded stop counting. The third lives in `/run` and does not survive a reboot,
so it has nothing to migrate.

The old files are not read any more, and they are removed by step 6 rather than
here: leaving them costs a few kilobytes and removing them early would take away
the only thing to fall back on.

### The order

Back to back, in this order, gatekeeper first because the steward reads what it
writes:

```bash
bin/deploy-gatekeeper.sh              # the two templates and gatekeeper.js
bin/deploy-steward.sh                 # steward.js, its routes and its fields
(cd dashboard && sitesolide deploy)   # the relay, the page, and collector.ts
bin/deploy-api.sh                     # DOMAINS_FILE in its unit, at leisure
(cd analytics && sitesolide deploy)   # defaults only, nothing to line up
```

The window between the second command and the third is the one that shows: the
dashboard is up, but its Secrets and Access sections answer an error until the
deploy lands. It lasts as long as one `sitesolide deploy`. Run the two without
pausing in between, and do not start a portal change or a secret write during
it.

`bin/deploy-collector.sh` is not in the list: the collector's unit sets none of
these variables, and `collector.ts` travels with the dashboard's code.

## The procedure

Played on the one machine this was written for, on 23 September 2026, in this
order. Each step ends by probing every site over HTTPS and comparing the codes
with those taken at step 0: move on only when they match, the one expected
difference aside. A fresh install never needs any of it.

Two windows show. Caddy restarts once at step 1, which cuts every site for about
a second. And from step 5 to its last command, a protected site cannot
authenticate anyone; after it, everyone signs in once more, the portal's cookie
having changed its name.

### 0. Before anything

```bash
ssh you@your-machine 'systemctl is-active caddy; sudo ls /run/sitesolide-portier/sauvegardes 2>/dev/null'
```

The old gatekeeper is the one running, so its directory is the one to read. If
that lists anything, a portal change was interrupted: sort it out first.

### 1. The zone variables, then Caddy's unit

Put `/etc/caddy/sitesolide.env` down first, with the four lines
`bin/deploy-caddy.sh` writes (`SITESOLIDE_ZONE`, `SITESOLIDE_ACME_EMAIL`,
`SITESOLIDE_SLUG={labels.N}`, `SITESOLIDE_CONTACT`), root-owned and 0644. Only
then install `infra/caddy/caddy.service.d/override.conf` and restart Caddy: the
override names the file without a `-`, and a missing file would stop Caddy from
starting at all.

```bash
ssh you@your-machine 'sudo systemctl daemon-reload && sudo systemctl restart caddy && systemctl show caddy -p EnvironmentFiles --value'
```

The running Caddyfile still names the zone in full, so nothing changes yet.

### 2. The lock directory, copied

```bash
ssh you@your-machine 'sudo mkdir -p /etc/caddy/locks && sudo cp -a /etc/caddy/verrous/. /etc/caddy/locks/
  sudo test -e /etc/caddy/lock-codes.json || sudo cp -a /etc/caddy/verrous-codes.json /etc/caddy/lock-codes.json'
```

### 3. The steward, beside the old one

**Its state directory moves with its name**, from
`/var/lib/sitesolide-secretaire` to `/var/lib/sitesolide-steward`, and `bin/deploy-steward.sh` does not carry
anything over. That directory holds the Activity history and `precedents/`, the
previous versions of every secret file. Copy it before the new steward first
starts, or it starts empty:

```bash
ssh you@your-machine 'sudo test -e /var/lib/sitesolide-steward || sudo cp -a /var/lib/sitesolide-secretaire /var/lib/sitesolide-steward'
bin/deploy-steward.sh
```

Leave the old steward running. Its socket is in `/run/sitesolide-secretaire`,
the new one's in `/run/sitesolide-steward`: the old dashboard keeps talking to
the old steward until step 6, and nothing ever goes without one.

### 4. The gatekeeper, beside the old one

```bash
bin/deploy-gatekeeper.sh
```

### 5. The portal, and Caddy with it

The blocks in service send `/_portail/*` to the portal, the new ones
`/_portal/*`, and the new portal only answers the second: the portal and every
protected block switch together. The portal also renames its data files, and
**without the renames below every password access is lost**, the new portal
opening an empty `portal.db` beside the old one.

```bash
ssh you@your-machine 'set -e
sudo systemctl stop portail
sudo mv /srv/sites/portail /srv/sites/portal
sudo mv /srv/sites/portal/data/cle /srv/sites/portal/data/key
for s in "" -wal -shm; do
  if sudo test -e "/srv/sites/portal/data/portail.db$s"; then
    sudo mv "/srv/sites/portal/data/portail.db$s" "/srv/sites/portal/data/portal.db$s"
  fi
done
sudo groupmod -n site-portal site-portail
sudo usermod -l site-portal site-portail
sudo mv /etc/sitesolide/portail.env /etc/sitesolide/portal.env
sudo sed -i "s/\"slug\": \"portail\"/\"slug\": \"portal\"/" /srv/sites/portal/sitesolide.json
sudo systemctl disable portail
sudo rm -f /etc/systemd/system/portail.service /etc/caddy/sites/portail.caddy
sudo systemctl daemon-reload'
cd portal && sitesolide deploy && cd ..
```

The UID and GID do not change, so nothing needs a `chown`. Before it, the
secrets registry of the machine's repository must name `portal.env` for the
`site-portal` account, or the deploy refuses the portal.

`sitesolide deploy` lays the new Caddyfile down with every block of the projects
directory, validates, reloads and probes: that is the switch. Check that a sign
in reaches the portal, with no `Origin` so that no attempt is counted:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://a-protected-site.your-zone.tld/_portal/connexion
```

403 is the portal refusing the origin. 401 would be Caddy's guard, meaning the
route does not reach it.

### 6. The dashboard, then the collector

```bash
(cd dashboard && sitesolide deploy --force)
bin/deploy-collector.sh
ssh you@your-machine 'sudo systemctl disable --now collecteur-etat.timer
  sudo rm -f /etc/systemd/system/collecteur-etat.service /etc/systemd/system/collecteur-etat.timer
  sudo systemctl daemon-reload'
```

`--force` because the unit in service lacks `SITESOLIDE_ZONE`: read the
difference it prints before running it. The collector goes after the dashboard,
its unit waiting for the `collector.ts` the dashboard brings.

### 7. The shared service and analytics

```bash
bin/deploy-api.sh
(cd analytics && sitesolide deploy)
```

`deploy-api.sh` now lays down its unit on every run. Before, it deployed the
code alone, and the unit on the machine stayed the one installed by hand: the new
code ran without the zone its ask endpoint checks names against.

### 8. The loopback rule, under its new unit

Do **not** run `systemctl disable --now` on the old unit: its `ExecStop` deletes
the nftables table, which would take the loopback rule off without a word. Load
the same file under the new unit, then drop the old one without stopping it:

```bash
sed "s|@NFT@|/usr/sbin/nft|g" infra/loopback/sitesolide-loopback.service |
  ssh you@your-machine 'sudo install -m 644 /dev/stdin /etc/systemd/system/sitesolide-loopback.service'
ssh you@your-machine 'set -e
sudo cp -a /etc/sitesolide-boucle.nft /etc/sitesolide-loopback.nft
sudo systemctl daemon-reload && sudo systemctl enable --now sitesolide-loopback.service
sudo systemctl disable sitesolide-boucle.service
sudo rm -f /etc/systemd/system/sitesolide-boucle.service
sudo systemctl daemon-reload
systemctl show sitesolide-boucle -p ExecStop --value
sudo nft list table inet sitesolide_boucle | grep -c counter'
```

The file replaces the table atomically, so the rule never lapses. Once the old
unit's file is gone and systemd reloaded, it loses its `ExecStop`: the `show`
above prints nothing, and only then may it be stopped.

### 9. The old units

```bash
ssh you@your-machine 'set -e
sudo systemctl disable --now sitesolide-secretaire.service
sudo systemctl stop sitesolide-boucle.service || true
sudo rm -f /etc/systemd/system/sitesolide-secretaire.service \
           /etc/systemd/system/sitesolide-portier-on@.service \
           /etc/systemd/system/sitesolide-portier-off@.service \
           /usr/local/lib/sitesolide/secretaire.js /usr/local/lib/sitesolide/portier.js
sudo systemctl daemon-reload'
```

Then sign in once on a protected site, and open the dashboard: Activity shows
the history, Secrets answers, and a change of general access goes through.

### 10. Clean up

Once those three are checked, and not before:

```bash
ssh you@your-machine 'set -e
sudo rm -rf /etc/caddy/verrous /etc/caddy/verrous-codes.json /run/sitesolide-portier
ls /srv/sites/dashboard/data/state.json && sudo rm -f /srv/sites/dashboard/data/etat.json
sudo test -s /var/lib/sitesolide-steward/journal.jsonl && sudo rm -rf /var/lib/sitesolide-secretaire'
```

## If something goes wrong

Nothing before step 5 removes anything: the old steward, gatekeeper, collector
and lock directory keep running beside the new ones. Step 5 moves files rather
than deleting them, and every move has an obvious inverse.

`bin/deploy-caddy.sh` keeps a timestamped backup under `/var/backups/caddy/` on
every run and restores it by itself if validation or the probe fails. To go back
by hand:

```bash
ssh you@your-machine 'sudo cp /var/backups/caddy/<timestamp>/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```

Never `caddy stop` or `caddy start`: they talk to the running instance whatever
`--config` you pass.

## Access: the registry made from the stores before it

**Automatic, once, at the first start of the steward that carries the access
registry.** Nothing is typed by hand: `sitesolide upgrade` deploys the
steward, which makes the registry when it starts. This section says what it
reads, what it writes, what it refuses to guess, and how to go back.

Before it, who may do what lived in three places: the dashboard's people and
their roles in the steward's `members.json` (a release that never shipped,
on the machines that ran it), and, in the portal's database, who could open
each site (a mode, a list of people, a list of domains, its `sharing` table)
and the passwords it handed out to people outside the company (its `invites`
table). After it there is one registry, the steward's,
`/var/lib/sitesolide-steward/access.json`, root `0600`, and the portal reads a
projection of it, `/etc/sitesolide-portal/access.json`, `root:site-portal
0640`, which the steward writes after every change.

### What it reads

| Store | Where | How |
|---|---|---|
| the dashboard's people and roles | `/var/lib/sitesolide-steward/members.json` | the steward's own file, read whole |
| who could open each site | the `sharing` table of `/srv/sites/portal/data/portal.db` | a checked copy, see below |
| the passwords handed out | the `invites` table of the same database (`id`, `hote`, `libelle`, `empreinte`, `cree_a`, `expire_a`) | the same copy |

**Why the portal's database is read by root, as a copy, and not asked of the
portal.** The steward is upgraded before the portal, so at its first start
the portal running is the old one, which has no route that hands over
password hashes; and such a route would be one more way in on the loopback,
open long after the one read it was made for. The steward already reads
`/srv` with `CAP_DAC_READ_SEARCH` under `ProtectSystem=strict`, so no
directive of its unit changes. What it never does is let SQLite open a file
another account can change under it: the portal's account owns its data
folder, and could put a link where the database is. `portal.db` and its
`portal.db-wal` are opened without following a link, accepted only as
regular files with a single name owned by the folder's owner, never root,
copied into a folder of the steward's own state directory, checked by SQLite
(`PRAGMA quick_check`), read there, and deleted. A copy that changed while it
was taken, or that does not check out, is taken again, five times at most.

### What becomes an entry

| Before | After |
|---|---|
| a role in `members.json`, on a deployed project or one since removed | the same role on that project, who gave it and when kept |
| the right to create projects | the same right |
| a person the site's list let in (mode `people` or `domain`) | Can open |
| a domain the site's list let in (mode `domain`) | Can open, written `@acme.com` |
| a password handed out | password access, Can open, with its identifier, its SHA-256 and its expiry: the passwords handed out and the cookies in circulation keep opening what they opened |
| one whose label is an email | that email as who it was given to |
| one whose label is a name | that name, kept as it stands ("Client Bob"); two under one name become `Client` and `Client (2)` |
| an expired one | carried with its expiry, and opens nothing, as before |
| a revoked one | nothing: revoking deleted it from the portal's database |

**Conflicts go to the higher role.** Someone both on a site's list and given
a role keeps the role, which includes opening the site. A password handed
out to an email that also holds Viewer, Developer or Admin on that site is
set aside: the role already opens it with their company account. One handed
out to someone the site's list let in joins their entry, which then opens
with either.

### What it refuses to guess

Kept in the registry's `migration.setAside`, each with its reason, and never
given access; past 500, one line says how many more, which stay in the old
stores, read-only:

- **people and domains a site's list kept for later while its mode let them
  out.** The mode `admins` kept both lists, `people` kept its domains. Giving
  them access would open the site to people who could not open it the day
  before;
- a role on one of the platform's projects (the dashboard, the portal, the
  shared service, analytics, the landing);
- a list or a password for a host the zone gives no project.

A store that does not read stops the migration: no registry is written,
every person is refused until it is repaired, the steward's log and every
answer say which store and why, and the next request, or the next start,
tries again. Guessing at who may do what is the one thing not to do. Each of
the portal's two tables is measured before it is read, 16 MB of values at
most, and refused `oversized-table` past it. When the portal's database is
the store that does not read, you may carry the rest over without it:
`sitesolide people --migrate-without-portal`. Who could open which site, and
the passwords handed out, then stay in `portal.db`, read-only, and open
nothing once the portal reads the projection; the registry's `migration`
field says so, and `access.migrate` is journaled under `owner`.

### What widens, by design

Everyone with a role above Can open on a project, Viewer, Developer or Admin,
now opens its site when its general access is restricted: the role includes
it. Before, the dashboard's roles and the portal's lists were separate, and
a Developer of a restricted site needed to be on its list besides. Read the
list of people with access of each restricted site after the upgrade
(`sitesolide share` in its folder) if that matters for one of them.

`X-Sitesolide-Role`, the header a restricted site reads, now carries
the role: `admin` for the owner's password and the admin emails, `visitor`,
`viewer`, `developer` or `admin` for a company account, `visitor` for password
access, which carries no `X-Sitesolide-User`. An app that compared it with
its old values, `member` or `guest`, must be updated before the portal is
deployed.

### Made once

While `access.json` exists, nothing is carried over again, at any start. The
old stores stay where they are, read-only until the next release:
`members.json` is never written again, and the portal never writes its
`sharing` and `invites` tables again. A portal that has not read a projection
yet decides from those tables as it did, so the order of the upgrade opens
and closes nothing; once it has read one, it leaves a mark in its data folder,
`access-from-steward`, and never reads them again.

The steward's access log starts with it. Finding no
`/var/lib/sitesolide-steward/access-log.jsonl`, the steward copies into it
the accepted changes of access its journal already holds, `access.migrate`
among them, so that the journal's rotation, past 1,000 lines, cannot take
them away, and at each start it tops it up with those of the journal it
lacks. It appends every accepted change there and keeps each 180 days,
never pushing one out younger: once it holds 20,000 of them, or 12 MB, a
change that lets more people in is refused until older ones age out.
Refusals stay in the journal.

The tokens are made someone's once too, when the registry first reads, or at
once after `--migrate-without-portal`. A token whose email, what the owner
typed when creating it and shown as its label, is the address of a person
who signs in to the dashboard, a role above Can open or the create right,
becomes that person's, made by the owner: narrowed to their roles from then
on, and revoked when they leave, removed or lowered so that they keep no
role above Can open and no create right. Every other token becomes the
owner's own, its scope unchanged; each one made a person's is journaled as
`token.create`, actor `system`. A shared CI token whose email is a person's
is kept the owner's by making a new one on the *Tokens* page, *Whose token*
set to *Mine*, with the same projects, putting it in the CI, then revoking
the one that became the person's.

### Check

```bash
sitesolide people                                   # everyone, their roles, who may create projects
cd <a restricted project> && sitesolide share       # its people with access, no warning about the portal
ssh you@your-machine 'sudo journalctl -u sitesolide-steward -n 50 | grep access:'
ssh you@your-machine 'sudo curl -s http://127.0.0.1:3026/admin/access'   # {"reading":"steward",...} once the portal is deployed
```

The steward's journal holds one `access.migrate` line, actor `system`, with
the counts: roles, people and domains who could open a site, password
access, who may create projects, and how many were set aside. What was set
aside is in the registry itself:
`ssh you@your-machine 'sudo cat /var/lib/sitesolide-steward/access.json'`,
its `migration` field.

### Going back

Deploy the steward, the dashboard, the installer and the portal of the
commit before, from a checkout of it: `bin/deploy-steward.sh`, then
`sitesolide deploy` in `dashboard/`, then `bin/deploy-installer.sh`, then
`sitesolide deploy --force` in `portal/`. The installer goes back too: this
one reads `access.json`, which nothing writes once the steward is the older
one, and would narrow a person's deployments by a registry frozen at the
rollback. They read
`members.json` and the portal's tables as they stood when the registry was
made: **every change of access made since is lost for them**, and password
access given since does not exist for them. `access.json`, the projection
and `access-log.jsonl` stay beside them, unread; `X-Sitesolide-Role` goes
back to `member` and `guest`.

Upgrading again afterwards keeps the registry as it stood when you went back,
and the changes made under the old code in between are not carried over. To
make it afresh from the old stores instead, delete it before upgrading:
`ssh you@your-machine 'sudo rm /var/lib/sitesolide-steward/access.json'`. The
changes made after the first migration are then lost instead: choose the
side that holds what you want to keep. Within thirty seconds of the rebuild,
the steward revokes the tokens of anyone the rebuilt registry no longer
names, and they stay revoked even if the file is put back: copy
`access.json` first, since the machine's backups do not hold
`/var/lib/sitesolide-steward`.

