---
name: release
description: Cut a release of sitesolide, from the last commit to the workstation's binary. Use when asked to release, tag, publish a version, or write or fix release notes.
when_to_use: Requests such as "release this", "tag 0.4.3", "publish the release", "write the release notes", or "fix the release list". Not for upgrading a machine to a release.
---

# Releasing sitesolide

A release is a tag, `vX.Y.Z`, whose workflow (`.github/workflows/release.yml`)
runs the tests, builds the binaries and publishes them on the tag's GitHub
release. Then come the notes and the workstation's binary. Upgrading a
machine is not part of a release.

## The format

Every release reads alike, from the first to the last.

**The title is the tag, and nothing else**: `v0.4.2`. The workflow sets it, on
a release it creates and on one made by hand beforehand. Never pass `--title`,
never add a product name or a tagline.

**The version** is semantic. Before 1.0: a minor, `0.5.0`, for a new page or
section, a new command, a change in how people use sitesolide, or anything
that asks an operator more than `sitesolide upgrade`; a patch, `0.4.3`, for a
fix or a feature added to an existing page. The precedents are in `gh release
list` and `docs/upgrading.md`. Say which and why in one line; ask the author
only when neither rule decides.

**The notes**, in this order:

1. One sentence for people, starting with the version: `sitesolide 0.4.2
   backs up the machine's own state: ...`. What the release brings, not how.
2. The install and upgrade commands, as they are:

   ````markdown
   ```bash
   curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
   sitesolide upgrade --dry-run
   sitesolide upgrade
   ```
   ````

3. `**Upgrading:**`, a link to the release's section of `docs/upgrading.md`
   at the tag (`https://github.com/cthiriet/sitesolide/blob/vX.Y.Z/docs/upgrading.md#<anchor>`),
   then what to do beyond `sitesolide upgrade`, or `Nothing else to do`.
4. `## ` sections, titled by what changes for the reader, each a short list.
   `## What changes for you` when a behaviour changes or something is
   refused that was accepted; `## Fixes` for the fixes. No section for its
   own sake.
5. Last, alone: `**Full Changelog**: https://github.com/cthiriet/sitesolide/compare/vPREVIOUS...vX.Y.Z`.

The repository's rules hold in the notes as in the files: English only, no em
dash, no machine, domain or address of an installation, no secret.

## The procedure

1. **`main` holds the release.** Everything committed and pushed, and
   `bin/test.sh` green on the workstation. A kit test that refuses to pack
   "what may carry a secret" has found an untracked file of the tree, Terraform's
   state for one: move it out of the tree for the run and back after, never
   read it, never commit it.
2. **Its section of `docs/upgrading.md`** is written and committed before the
   tag, at the top, titled by what the release does: the notes link to it at
   the tag. What `sitesolide upgrade` brings, what changes for the operator,
   and how to go back.
3. **On a test machine first**, when the release changes what runs on a
   machine: `bun bin/sitesolide.ts upgrade` from the checkout, with
   `SITESOLIDE_CONFIG_DIR` naming that machine's configuration, then what
   only a machine proves (systemd, the network, a real bucket).
4. **A rehearsal**, which publishes nothing:

   ```bash
   gh workflow run release.yml --ref main
   gh run watch <run id> --exit-status
   ```

5. **The tag**, once the rehearsal is green:

   ```bash
   git tag -a vX.Y.Z -m "sitesolide X.Y.Z"
   git push origin vX.Y.Z
   gh run watch <run id> --exit-status
   ```

   The release then has its seven files: four binaries, `SHA256SUMS`,
   `install.sh`, `deploy.sh`.
6. **The notes**, written in a file outside the repository, in the format
   above: `gh release edit vX.Y.Z --notes-file <file>`. Check the title still
   reads `vX.Y.Z` and that `gh api repos/cthiriet/sitesolide/releases/latest -q .tag_name`
   names the new tag.
7. **The workstation's binary**: the install line above, then
   `sitesolide --version`. Machines are upgraded from this binary, never
   from the checkout.

Fixing the notes of a release already published changes its body only:
`gh release edit <tag> --notes-file <file>`, the files and the tag untouched.
