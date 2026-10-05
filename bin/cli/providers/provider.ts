/**
 * What `sitesolide machine` asks of a cloud provider: create a machine ready
 * for `sitesolide setup`, list the ones sitesolide created, destroy one.
 *
 * Hetzner is the only implementation (hetzner.ts). DigitalOcean and Scaleway
 * are meant to follow behind this same interface, which is why it says what a
 * machine is in the words every provider has (a name, a size, a place, two
 * addresses) and leaves the rest, the firewall and the key included, to each
 * implementation.
 *
 * Every resource a provider creates carries two labels, or tags where the
 * provider has no labels: `managed-by=sitesolide`, which is what lets `list`
 * find them and `destroy` refuse anything else, and `sitesolide-machine=<name>`,
 * which says what they were created for. A machine without the first is
 * somebody else's, and is never adopted, changed or deleted.
 *
 * The provider never reads the workstation and never prints: it reports its
 * steps through `report`, in the shape of the CLI's lines (`-> ` opens a step,
 * an indented line says something about it), and fails by throwing a
 * ProviderError whose `failure` carries a code bin/cli/hints.ts knows.
 *
 * The token it is given is never part of a message, an URL or an argument.
 */
import type { Failure } from "../remote";

/** The two labels every created resource carries. */
export const MANAGED_LABEL = "managed-by";
export const MANAGED_VALUE = "sitesolide";
export const MACHINE_LABEL = "sitesolide-machine";

export function labelsFor(name: string): Record<string, string> {
  return { [MANAGED_LABEL]: MANAGED_VALUE, [MACHINE_LABEL]: name };
}

export function isManaged(labels: Record<string, string> | undefined | null): boolean {
  return labels?.[MANAGED_LABEL] === MANAGED_VALUE;
}

/** An OpenSSH public key, as the `.pub` file holds it. */
export type PublicKey = {
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`... */
  algorithm: string;
  /** The base64 of the key itself, which is what two copies of a key share. */
  blob: string;
  /** The free text after the key, often `user@host`; may be empty. */
  comment: string;
  /** MD5 of the key, colon separated hex: what Hetzner shows, and what `ssh-keygen -E md5 -l` prints. */
  fingerprint: string;
};

export type CreateRequest = {
  name: string;
  type: string;
  location: string;
  image: string;
  backups: boolean;
  key: PublicKey;
};

/** A machine, as `list` shows it and `create` and `destroy` report it. */
export type Machine = {
  provider: string;
  id: string;
  name: string;
  type: string;
  location: string;
  /** The provider's own word: `running`, `initializing`, `off`... */
  status: string;
  ipv4: string | null;
  /** The address a DNS AAAA record points at, when the provider routes a network. */
  ipv6: string | null;
  /** The network the provider routes to the machine, `2001:db8::/64`; null without IPv6. */
  ipv6Network: string | null;
  /** What it costs a month at its location, as the provider says it; null when it does not. */
  monthlyPrice: { net: string; gross: string; currency: string | null } | null;
  backups: boolean;
  /** Carries `managed-by=sitesolide`: created by this command, and the only kind it destroys. */
  managed: boolean;
  labels: Record<string, string>;
};

/** A price as providers write it, `4.9900000000`, said for a person. */
export function formatPrice(net: string | number, currency: string | null): string {
  return `${Number(net).toFixed(2)}${currency === null ? "" : ` ${currency}`} a month before VAT`;
}

/** One resource a step created or found, by its name at the provider. */
export type Resource = { kind: string; name: string; id: string; reused: boolean };

export type CreateOutcome = {
  machine: Machine;
  /** False when a machine of that name, created by sitesolide, was already there. */
  created: boolean;
  resources: Resource[];
};

export type DestroyOutcome = {
  /** What was deleted, said for a person: `server web (203.0.113.10)`. */
  removed: string[];
  /** What was left on purpose, with the reason. */
  kept: string[];
};

/** A line of progress, in the CLI's shape: `-> step`, `   detail`, `!! warning`. */
export type Report = (line: string) => void;

/** Time, injected so that tests neither wait nor depend on the wall clock. */
export type Clock = { now: () => number; sleep: (milliseconds: number) => Promise<void> };

export const realClock: Clock = { now: () => Date.now(), sleep: (milliseconds) => Bun.sleep(milliseconds) };

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Provider {
  readonly name: string;
  /** The machine of that name, ours or not, or null when the project has none. */
  find(name: string): Promise<Machine | null>;
  /**
   * Creates the machine, or finds it already created by sitesolide, and
   * returns once the provider says it runs. Each step is idempotent: a run
   * interrupted anywhere is finished by running it again.
   */
  create(request: CreateRequest, report: Report): Promise<CreateOutcome>;
  /** The machines carrying `managed-by=sitesolide`. */
  list(): Promise<Machine[]>;
  /** Deletes a machine `find` returned as managed, then what was created for it alone. */
  destroy(machine: Machine, options: { deleteKey: boolean }, report: Report): Promise<DestroyOutcome>;
}

export type ProviderContext = {
  token: string;
  environment: Record<string, string | undefined>;
  fetcher: Fetch;
  clock: Clock;
};

/** What the command knows of a provider before it has a token: its name, and where the token comes from. */
export type ProviderEntry = {
  /** As a person writes it: `Hetzner`. */
  title: string;
  /** The environment variable the provider's own tools read the token from. */
  tokenVariable: string;
  /** Where a token is made, and with which permission, one line each. */
  tokenHelp: string[];
  open: (context: ProviderContext) => Provider;
};

/** Thrown by a provider: `failure.error` is a code of REMOTE_HINTS in bin/cli/hints.ts. */
export class ProviderError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}
