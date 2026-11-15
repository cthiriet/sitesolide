# SSH access

The owner reaches the machine over SSH, and so does nobody else: `setup`,
`upgrade`, `passkey link` and every script of `bin/` that talks to the machine
go through it. This page covers who may reach port 22, the sshd settings
setup lays, the tailnet that lets port 22 close to the internet, the host key,
and the way back in when that path fails.

## Who reaches port 22

Port 22 is filtered at two places, and each is set by its own command:

| Where | Set by | Read by |
|---|---|---|
| ufw, on the machine | `sitesolide setup` and `sitesolide upgrade` | `sudo ufw status` |
| the provider's firewall, before the machine | `sitesolide machine create` and `sitesolide machine firewall` | the provider's console |

By default both let everyone in, keys only. Three options, of `setup` for a
machine being installed and of `upgrade` for one in service, change that in
ufw:

| Option | ufw lets port 22 in |
|---|---|
| `--ssh-from 203.0.113.0/24,2001:db8::/32` | from these networks alone, twenty at most; an address stands for its /32 or /128 |
| `--ssh-interface tailscale0` | on this interface alone, whatever the source, which is what a tailnet needs |
| `--ssh-public` | from everywhere again: the break-glass |

`--ssh-from` and `--ssh-interface` go together, and the rule then lets in
either. What they give is recorded in `~/.config/sitesolide/config.json`, as
`sshFrom` and `sshInterface`, and `sitesolide init` run again keeps both. Every
later run of `setup` or `upgrade` reads that record: **a run without the
options never widens what is in place**, and only `--ssh-public` opens port 22
to everyone again, which also drops the record. Options given replace the
record as a whole.

The web ports are never touched by any of these: 80 and 443 stay open to all.

### Nothing closes the path it came in by

Restricting port 22 is refused unless the run's own connection arrives by a
path that stays open. Setup, and upgrade alike, read `$SSH_CONNECTION` on the machine, the
client's address and the local one, and the interface that local address sits
on. Connected to the public address from your home, `--ssh-interface
tailscale0` stops at the firewall step:

```text
setup stopped at firewall: public ssh stays open: this connection comes from 198.51.100.2 on eth0, which ssh on tailscale0 only would refuse
```

Nothing has changed at that point. Connect over the path that stays open, the
tailnet name in the configuration's server, and run it again. The restricted
rules are added first and the public ones deleted after, so the connection
running the change never loses its rule; ufw keeps established connections
anyway.

`sitesolide machine firewall` holds to the same rule: before narrowing port 22
at the provider, it logs in to the configuration's server and checks that it
is this machine (one of its addresses is the machine's public one) and that the
connection does not depend on what is being closed.

### At the provider's firewall

```bash
sitesolide machine create --provider hetzner --name web --ssh-from 203.0.113.0/24
sitesolide machine firewall web --provider hetzner --ssh-from 203.0.113.0/24
sitesolide machine firewall web --provider hetzner --ssh-closed
sitesolide machine firewall web --provider hetzner --ssh-public
```

`--ssh-closed` removes the port 22 rule: nobody reaches the public address on
22, and the owner comes in over the tailnet, which needs no inbound port.
`--ssh-public` puts the rule back for everyone and asks for no proof: it is
the way back in.

| Provider | `create --ssh-from` | `machine firewall` |
|---|---|---|
| Hetzner | yes | yes |
| Google Cloud, Scaleway | yes | not yet: their console |
| DigitalOcean, AWS, Azure, Vultr, Linode | refused, nothing ordered | not yet: their console |

For those not covered, restrict ufw with `setup`, and edit the inbound rule for
TCP 22 in the provider's console. A machine `machine create` did not make has
no firewall it may touch: `machine firewall` refuses it, and the console is the
place.

## The sshd settings

Setup writes `/etc/ssh/sshd_config.d/00-sitesolide.conf`, read before every
other file of that folder since sshd keeps the first value it reads:

| Setting | Why |
|---|---|
| `PermitRootLogin no`, `AllowUsers <deploy account>` | one account logs in, and it is the owner's |
| `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `AuthenticationMethods publickey` | keys only |
| `MaxAuthTries 5`, `LoginGraceTime 30` | an attempt is short |
| no X11, agent, TCP or stream forwarding, no tunnel, no user environment | nothing in sitesolide uses them, and each is a way through the machine |
| `PubkeyAuthOptions touch-required` | a security key must be touched for every login |
| `KexAlgorithms`, `Ciphers`, `MACs` | post-quantum key exchange first (`mlkem768x25519-sha256`, `sntrup761x25519-sha512`), then Curve25519; AEAD ciphers first, then AES-CTR, and encrypt-then-MAC MACs alone |

The algorithms are those of OpenSSH 10, Debian 13's; a client older than
OpenSSH 7.4 cannot log in. `sshd -t` checks the drop-in before any reload, a
timer withdraws it two minutes later unless a second new login proves it, and
the drop-in in place before is what the timer puts back. `sitesolide upgrade`
brings the same drop-in to a machine installed by an earlier release, the
component `ssh`, with the configuration's account in `AllowUsers`.

`MaxAuthTries 5` counts every key the agent offers: an agent holding more than
five keys fails before it reaches the right one. Name the key in
`~/.ssh/config`, `IdentityFile` with `IdentitiesOnly yes`.

### A security key

A FIDO2 key keeps the private key on the device, and asks for a touch on
every login:

```bash
ssh-keygen -t ed25519-sk -O resident -O verify-required -C "owner security key"
```

Add the `.pub` to the deploy account's `~/.ssh/authorized_keys`, check that a
login works with it, then remove the plain key. `touch-required` applies to
such keys only; a plain key is not affected. For sshd to demand the PIN as
well as the touch, write `verify-required` before the key on its line of
`authorized_keys`.

## A tailnet

A tailnet is the way to close port 22 to the internet altogether: Tailscale
gives the machine an address only the tailnet's devices reach, over
WireGuard, with no inbound port, and OpenSSH stays the one that authenticates,
on the machine's own keys. **Tailscale SSH is never turned on**: it would move
the decision of who logs in from `authorized_keys` to the tailnet's policy,
and setup checks it is off on every run.

### Before setup: the tailnet's settings

In the tailnet's admin console:

1. **A tag for servers.** In the policy file, `"tagOwners": { "tag:server":
   ["autogroup:admin"] }`. A tagged device's key does not expire, so the
   machine does not drop off the tailnet after 180 days.
2. **A policy that lets your devices reach it, and not the other way round.**
   Tailscale's grants are one-way: let `autogroup:member` reach `tag:server` on
   `tcp:22`, and grant `tag:server` nothing towards your own devices. A
   compromised server then reaches none of them.

   ```json
   "grants": [
     { "src": ["autogroup:member"], "dst": ["tag:server"], "ip": ["tcp:22"] }
   ]
   ```

   Remove the default grant that lets every device reach every other, or the
   server reaches your laptop through it.
3. **Tailnet Lock**, under *Settings*, signs every new device with a key held
   by your own devices: whoever takes over the Tailscale account still cannot
   add a node to the tailnet. Sign the machine's node once it has joined:
   `tailscale lock sign <node key>` from a signing device.
4. **An auth key**, under *Settings*, *Keys*: one use, pre-approved, tagged
   `tag:server`, valid for an hour. It is a credential: it lives in your
   password manager or in the environment of the one command that uses it.

### Setup with `--tailscale`

```bash
TS_AUTHKEY=... sitesolide setup root@203.0.113.10 --zone <your zone> --email <you> --tailscale
op read "op://<vault>/<item>/credential" | sitesolide setup root@203.0.113.10 --zone <your zone> --email <you> --tailscale --tailscale-key-stdin
```

The key comes from `TS_AUTHKEY` or standard input, never from an argument,
where `ps` would show it. It reaches the machine on the ssh session's standard
input, is written to a file in `/run` readable by root alone for `tailscale up
--auth-key=file:...`, and is removed at once; setup prints it nowhere, and a
failure's output has it replaced by `[key]`. The key is asked for only while
the machine is not in a tailnet: a later run needs none.

The step, after the hardening and before Caddy, adds Tailscale's apt
repository, its signing key checked against its published fingerprint, installs
`tailscale`, joins with `--advertise-tags=tag:server` (`--tailscale-tag`
names another), and sets `--ssh=false`, `--accept-dns=false` and
`--accept-routes=false`: the machine keeps its own resolver and routes. The tag
is recorded in the configuration as `tailscale`.

### Closing port 22 to the internet

Joining changes nothing about port 22. Closing it is a second run, over the
tailnet:

```bash
sitesolide init --server deploy@<machine's tailnet name> --zone <your zone> --email <you>
ssh deploy@<machine's tailnet name> true
sitesolide upgrade --ssh-interface tailscale0
sitesolide machine firewall web --provider hetzner --ssh-closed
```

`upgrade` closes it in ufw, `machine firewall` at the provider. Setup given
the tailnet name would only read: its record of the install names the public
address. Then, from a network outside the tailnet, `nc -vz -w 5 203.0.113.10
22` times out.

## The host key

`ssh` accepts a host key it has never seen, on first contact, and refuses a
changed one after: the first contact is the one to check.

- `sitesolide machine create` prints the fingerprints ssh recorded at the first
  login, and the command that prints the machine's own in the provider's
  console, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. Compare them.
- `sitesolide setup --host-key SHA256:...` takes the fingerprint read in the
  console before any login: setup reads the keys the machine presents, refuses
  when none has that fingerprint, and writes the matching one alone into
  `~/.ssh/known_hosts`. A host already in `known_hosts` is left to ssh, which
  compares it on every connection.

A tailnet name is a new host for ssh: its first login over the tailnet records
the same key under the new name, and `ssh-keygen -lF <name>` shows it is the
same fingerprint.

## The way back in

Every change on this page can lock you out if the path that stays open fails:
the tailnet down, its account suspended, the device that held the key lost.
These need no SSH, from the cheapest:

1. **The provider's firewall, from its API.** When port 22 is closed there and
   not in ufw: `sitesolide machine firewall <name> --provider hetzner
   --ssh-public`, or the console's *Firewalls* page, a rule for TCP 22 from
   `0.0.0.0/0` and `::/0`. Hetzner's CLI does the same:

   ```bash
   hcloud firewall add-rule <firewall> --direction in --protocol tcp --port 22 --source-ips 0.0.0.0/0 --source-ips ::/0
   ```

2. **The provider's console**, a terminal on the machine's screen, for ufw or
   sshd. It logs in with a password, and no account setup makes has one: set
   one for root before you need it, over SSH, and keep it in your password
   manager. sshd refuses root and passwords whatever it is.

   ```bash
   ssh deploy@<machine> sudo passwd root
   ```

   Then, in the console, as root: `ufw allow 22/tcp` opens port 22 to all in
   ufw; `rm /etc/ssh/sshd_config.d/00-sitesolide.conf && systemctl reload ssh`
   undoes the drop-in. Once back in, `sitesolide upgrade --ssh-public` makes
   the configuration agree.
3. **The rescue system**, Hetzner's or the provider's equivalent, when the
   console is no help: the machine reboots into a system of the provider's,
   reached with an SSH key given then, and the disk is mounted and edited from
   there. Every site is down meanwhile.

   ```bash
   hcloud server enable-rescue <name> --ssh-key <key name>
   hcloud server reboot <name>
   ```

Try the first two before you close anything, while SSH still works: see
[upgrading.md](upgrading.md#ssh-closes-to-the-internet).
