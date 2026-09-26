# Commands

Every command runs from a project's folder, the one holding its
`sitesolide.json`, except `init`. This is what `sitesolide --help` prints.

```text
sitesolide init                 write ~/.config/sitesolide/config.json
   --server <user@host> --zone <dns.zone> --email <you@example.com>
   --contact <you@example.com>   shown on a locked preview's door
sitesolide deploy               prepare, build, push, install, restart, verify
   --dry-run                    show the unit and the fragment, install nothing
   --force                      switch a hand-written unit to the generated one
sitesolide status               what the server actually runs
sitesolide logs [--follow]      journalctl for this project, every service of it
sitesolide lock   [--dry-run]   close the preview behind a code, or show it
   --status                     wanted / installed / measured, without touching
   --new-code                   replace the code in force by a fresh one
sitesolide unlock [--dry-run]   reopen the preview and drop its code
sitesolide domain               where this project's own domain stands
   --activate [--force]         switch the site onto it, then rebuild the table
   --deactivate                 back to the preview subdomain
sitesolide remove --confirm <slug>
                                take the project off the machine, for good
   --dry-run                    show every step, remove nothing
sitesolide run -- <command>     load the secret from the vault and run
```

`sitesolide run` loads the files the manifest declares from
`~/.config/sitesolide/secrets/`, the few credentials your workstation presents
to production itself, then runs the command. See [secrets.md](secrets.md).
