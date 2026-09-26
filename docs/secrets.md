# Secrets

API keys, tokens, password hashes: what must never enter git.

**The machine holds them, and nothing else does.** `/etc/sitesolide` on the VM
is the vault, and systemd reads each project's files from it with
`EnvironmentFile=` when the service starts. The dashboard manages every file
there, from its *Secrets* section: you read a value, set or remove a variable,
create a declared file that is missing, restore the previous version, and
restart the service with a verdict.

No copy of production waits on your workstation, in a repository or beside it.
`sitesolide deploy` never pushes a secret: it checks that each file the manifest
declares is on the machine, and when one is not, it stops and names the
dashboard where to create it. By then the manifest is deposited, so the
dashboard already knows the file belongs to the site.

## Where a secret lands, and to whom it belongs

From its name and its site, with no file to keep up to date:

| | |
|---|---|
| Path | `/etc/sitesolide/<name>` |
| Owner | `site-<slug>`, the account the project's service runs as |
| Mode | `0600` for an environment file, `0400` for a file read whole, `0444` for a `.pub` |

A file belongs to a site by its name: `<slug>.env`, `<slug>-<name>`, or
`<slug>-secrets/<name>` in a single-level subdirectory. When two sites could
claim a name, `cms-tool.env` with both `cms` and `cms-tool` deployed, the most
specific one wins. The landing is served from the directory named after the
zone, but its files and its account carry the `landing` label: `landing-mail.env`
is its.

The steward, the root daemon that does the writing, brings two sources
together:

- the `secrets` of an app's `sitesolide.json`: these can be created from the
  dashboard even before they exist;
- the files already present in `/etc/sitesolide` that carry a site's name: that
  is how a site no manifest describes, the landing or a service made by hand,
  keeps its files in the dashboard.

**A file no manifest declares is managed once present, and never created from
the dashboard.** Otherwise a compromised dashboard could lay an environment file
down for a service that does not expect one yet. To add such a file, create it
empty on the machine, then fill it from the dashboard:

```bash
ssh you@your-machine 'sudo install -m 600 -o site-landing -g site-landing /dev/null /etc/sitesolide/landing-mail.env'
```

The owner and mode of a present file are compared exactly: more open, it is no
longer a secret; more closed, its service would stop reading it. Either way it
is listed as unmanaged, with the command that repairs it.

## Three guard rails

| Rule | Files | Why |
|---|---|---|
| **write-only**: replaced, never read back, size not shown | files read whole and closed to other accounts | a private key never comes back to the screen, and its size would already give away its algorithm |
| **Change password only**: never read, never set by hand, never restored, the old one erased | any `PASSWORD_HASH`, in any file | a hash is cracked offline, and restoring would revalidate the password you changed because it had leaked |
| **hash only**: no other variable | `dashboard.env`, `portal.env` | one more variable there would change what the service does: a socket path would send the next password typed to another socket |

**What belongs to no project is not the dashboard's**: `cloudflare.env`, the
token Caddy reads for its certificates, lives in `/etc/caddy` and is changed on
the machine.

No secret is shared, and that is the rule: the shared service `api/` sends no
mail and makes no call. Each file carries its project's name, so that each
project has its own credentials, under its own account, in the same directory
without ambiguity.

## The dashboard's own password

`dashboard.env` belongs to root, `0600`, not to `site-dashboard` like all the
others. The dashboard's service still receives it, since `EnvironmentFile=` is
read by PID 1 as root before the service takes its identity. In exchange, a
compromised dashboard cannot rewrite the hash that unlocks the secrets.

It is the one secret the dashboard cannot create for itself, being what opens
it. On a machine that has none yet:

```bash
bin/dashboard-password.sh
```

It draws a password, shows it once on your terminal, and puts its hash on the
machine straight from memory: nothing is written on the way. Store the password
before closing the terminal. Once the dashboard runs, **its password changes
from the dashboard**, through *Change password* in the dashboard site's own
*Secrets*. If it is lost, `bin/dashboard-password.sh --replace`.

## What your workstation keeps

`~/.config/sitesolide/secrets/` holds what **your workstation itself** presents
to reach production, and only that: the API token a command-line tool sends to
one of your services, for instance. `sitesolide run -- <command>`, from a
project's folder, loads the files its manifest declares from there and runs the
command:

```bash
cd my-tool && sitesolide run -- bun scripts/sync.ts
```

It is not a copy of production. A value only the machine uses stays on the
machine, and one the workstation keeps has two copies to hold equal: change it
in the dashboard, then in that file.

The folder is outside every repository, beside the configuration file, so no
`git add` can ever publish it. Claude Code is denied reading and writing there,
see `.claude/settings.json`.

## Terraform's tokens

The Hetzner and Cloudflare tokens that create the machine and its DNS records
are not the machine's secrets but your workstation's, and they live in
`~/.config/sitesolide/terraform/terraform.tfvars`, beside Terraform's state. See
[infra/README.md](../infra/README.md). The Cloudflare token Terraform uses is
distinct from the one Caddy reads on the machine for its certificates.
