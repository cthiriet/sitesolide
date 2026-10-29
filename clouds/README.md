# clouds

The cloud providers sitesolide orders its machine from, as a package of their own: Hetzner,
Scaleway (instances and Elastic Metal), Google Cloud, AWS, Azure, DigitalOcean, Linode and
Vultr, each through its public API with `fetch`, no SDK and no dependency.

A provider creates a machine, finds it again, lists the machines it created, destroys one with
what was created for it alone, and says where and what it sells. What the machine is for stays
with the program that asks: who owns it, which ports open, which key or user-data reaches it.

```ts
import { ownerNamed, realClock, WEB_SERVER } from "./src/provider";
import { HETZNER } from "./src/hetzner";

const provider = HETZNER.open({
  owner: ownerNamed("sitesolide"),
  credentials: { HCLOUD_TOKEN: token },
  environment: process.env,
  fetcher: fetch,
  clock: realClock,
  secret: (value) => scrub.add(value),
});
await provider.create({ name: "web", type: "cx23", location: "fsn1", image: "debian-13",
  backups: false, key, inbound: WEB_SERVER }, (line) => console.log(line));
```

## The contract

`src/provider.ts` holds it, and its comments are the reference. In short:

- **An owner.** Every resource carries `managed-by=<owner>` and `<owner>-machine=<name>`, as
  labels or tags. A provider lists, changes and deletes nothing that lacks its owner's label, so
  two programs sharing one cloud account never touch each other's machines.
- **A request that says everything.** The firewall is `inbound`, rule by rule; `key` may be null
  when the user-data carries the only key; `userData`, `disk`, `nestedVirtualization` and `login`
  where the provider can honour them. `checkRequest` refuses, before anything leaves, what a
  provider cannot do: an ignored field would be a machine unlike the one asked for.
- **Failures with a code.** A provider throws a `ProviderError` whose code is in
  `FAILURE_CODES`; a program explains them (sitesolide's `bin/cli/hints.ts` is checked against
  the list).
- **Credentials never printed.** A secret obtained along the way goes to `context.secret` before
  it is used, so the program scrubs it from every line.

What each provider takes beyond the common fields:

| Provider | key null | any inbound | userData | disk | nested virtualization | login |
|---|---|---|---|---|---|---|
| Hetzner | yes | yes | yes | | | |
| Scaleway | yes | yes | yes | yes | | |
| Google Cloud | | yes | yes | yes | yes | yes |
| AWS, Azure, DigitalOcean, Linode, Vultr | | `WEB_SERVER` only | | | | |

Scaleway also orders Elastic Metal, the types named `EM-...`: physical servers, `/dev/kvm`
included, with no firewall of Scaleway's in front of them, hence ordered only with
`hostFirewall` (the user-data writes the rules on the host).

## Tests

`fakes/` holds a local fake of each API, listening on the loopback, which the tests and the
programs using the package point the providers at; nothing here talks to a real cloud.

```bash
bun install
bun run check      # the tests, then tsc
```

## Used elsewhere by copy

Another program may copy this folder rather than depend on a published package: the copy is
taken at a pinned commit, with this folder's `LICENSE`, and checked file by file against that
commit by the program's own checks. Changes are made here, never in a copy, and reach the copy
when it is taken again.
