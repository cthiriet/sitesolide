/**
 * Scaleway Elastic Metal: a physical server, ordered through the Elastic
 * Metal API v1 (`/baremetal/v1/zones/{zone}/...`) rather than the Instance
 * API, and still the provider `scaleway`: scaleway.ts orders one when the
 * type is an offer's name, every one of which starts `EM-`.
 * https://www.scaleway.com/en/developers/api/elastic-metal/
 *
 * This file says what the answers mean: which offer a name stands for, which
 * system an image names, the machine a server is, and the key it is installed
 * with. The calls are scaleway.ts's, which shares its client, its errors and
 * its owner's checks with the instances.
 *
 * What differs from an instance, each forced by the product:
 *
 *   - every offer is published twice under one name, billed by the hour and
 *     by the month; the monthly one bills a month of rent up front as a
 *     commitment fee, so only the hourly one is ever ordered;
 *   - there is no security group: the machine is ordered only when the
 *     request's user-data writes its firewall on the host (`hostFirewall`);
 *   - the system is installed on delivery, 15 to 40 minutes after the order,
 *     and only with at least one SSH key registered in IAM. IAM refuses a
 *     second key of one fingerprint, so a program that reaches its machines
 *     through the user-data's key registers a throwaway one instead, whose
 *     private half is never kept, and deletes it with the server;
 *   - the user-data travels base64-encoded in the order, as cloud-init's.
 */
import { formatPrice, labelsOfTags, ProviderError, type Machine, type Owner } from "./provider";

/** Where Elastic Metal is sold, the zones the API serves: none at fr-par-3, nl-ams-3 or pl-waw-1, which sell Instances. */
export const METAL_ZONES = ["fr-par-1", "fr-par-2", "nl-ams-1", "nl-ams-2", "pl-waw-2", "pl-waw-3"] as const;

/** Every Elastic Metal offer is named `EM-...`, and no Instance type is. */
export function isMetal(type: string): boolean {
  return type.startsWith("EM-");
}

/** The tag that says an offer installs systems that read a user-data. */
export const CLOUD_INIT_TAG = "cloud-init";

/** Scaleway's monthly prices are its hourly ones times 730 hours. */
const HOURS_A_MONTH = 730;

// --- the API's objects, as far as this file reads them ---------------------------------

/** `units` and `nanos` of a currency, as the API gives every price. */
export type Money = { currency_code?: string; units?: number | string; nanos?: number };

export type MetalOffer = {
  id: string;
  name: string;
  stock: "empty" | "low" | "available";
  enable: boolean;
  subscription_period: string;
  price_per_hour?: Money | null;
  fee?: Money | null;
  tags?: string[] | null;
  incompatible_os_ids?: string[] | null;
  cpus?: { name: string; core_count: number; thread_count: number }[] | null;
  /** In bytes. */
  memories?: { capacity: number }[] | null;
  /** In bytes. */
  disks?: { capacity: number; type: string }[] | null;
};

export type MetalOs = { id: string; name: string; version: string; enabled: boolean; allowed: boolean; cloud_init_supported: boolean; license_required?: boolean };

export type MetalServer = {
  id: string;
  name: string;
  /** `delivering`, `ready`, `deleting`, `error`, `out_of_stock`, `locked`... */
  status: string;
  offer_id: string;
  offer_name: string;
  tags: string[];
  ips?: { id: string; address: string; version: string }[] | null;
  zone: string;
  /** `to_install`, `installing`, `completed`, `error`; `user` is the account the key logs into. */
  install?: { os_id: string; hostname: string; ssh_key_ids: string[]; status: string; user?: string } | null;
};

// --- what the answers mean ---------------------------------------------------------------

export function amount(money: Money | null | undefined): number {
  return Number(money?.units ?? 0) + Number(money?.nanos ?? 0) / 1e9;
}

export function hourlyPrice(offer: MetalOffer): number {
  return amount(offer.price_per_hour);
}

/** `4 threads, 32 GB RAM, 2 disks of 960 GB`: memory and disks in GB as Scaleway counts them, by 10^9. */
export function describeOffer(offer: MetalOffer): string {
  const threads = (offer.cpus ?? []).reduce((sum, cpu) => sum + cpu.thread_count, 0);
  const memory = Math.floor((offer.memories ?? []).reduce((sum, bank) => sum + bank.capacity, 0) / 1e9);
  const disks = offer.disks ?? [];
  // Scaleway installs on two disks in RAID 1 by default: the smallest is the room there is.
  const smallest = disks.length === 0 ? 0 : Math.floor(Math.min(...disks.map((disk) => disk.capacity)) / 1e9);
  return `${threads} threads, ${memory} GB RAM, ${disks.length} ${disks.length === 1 ? "disk" : "disks"} of ${smallest} GB`;
}

function priceLine(offer: MetalOffer): string {
  const hourly = hourlyPrice(offer);
  return `${hourly.toFixed(3)} EUR an hour, ${formatPrice(hourly * HOURS_A_MONTH, "EUR")}`;
}

/** Whether an offer may be ordered at all: by the hour, sold, no setup fee, a system that reads the user-data. */
function orderable(offer: MetalOffer): boolean {
  return offer.subscription_period === "hourly" && offer.enable && amount(offer.fee) === 0 && (offer.tags ?? []).includes(CLOUD_INIT_TAG);
}

/** The cheapest offers a zone has in stock and that could be ordered instead, one line each. */
export function cheapestOffers(offers: readonly MetalOffer[], zone: string, except: string, count = 6): string[] {
  const lines = offers
    .filter((offer) => offer.name !== except && orderable(offer) && offer.stock !== "empty")
    .sort((a, b) => hourlyPrice(a) - hourlyPrice(b) || a.name.localeCompare(b.name))
    .slice(0, count)
    .map((offer) => `${offer.name.padEnd(20)} ${describeOffer(offer)}, ${priceLine(offer)}${offer.stock === "low" ? ", low stock" : ""}`);
  return lines.length === 0 ? [`Scaleway has no other Elastic Metal by the hour in stock at ${zone}`] : [`the cheapest Elastic Metal Scaleway has in stock at ${zone}, by the hour:`, ...lines];
}

/**
 * The hourly offer of that name, or the refusal that says why there is none
 * to order. The monthly twin is never taken, even when it alone is sold: it
 * bills a month up front, where the request asked for a machine by the hour.
 */
export function chooseOffer(offers: readonly MetalOffer[], name: string, zone: string): MetalOffer {
  const refuse = (error: string, message: string, extra: string[] = []): never => {
    throw new ProviderError({ error, message, details: [...extra, ...cheapestOffers(offers, zone, name), "nothing had been created yet"] });
  };
  const hourly = offers.filter((offer) => offer.name === name && offer.subscription_period === "hourly");
  if (hourly.length === 0) {
    refuse("invalid-server-type", `${name} is not an Elastic Metal Scaleway sells by the hour at ${zone}`, ["an offer billed by the month bills a month up front, and is never ordered here"]);
  }
  const sold = hourly.filter((offer) => offer.enable);
  if (sold.length === 0) refuse("invalid-server-type", `Scaleway no longer sells ${name} at ${zone}`);
  const free = sold.filter((offer) => amount(offer.fee) === 0);
  if (free.length === 0) refuse("invalid-server-type", `${name} at ${zone} carries a setup fee of ${amount(sold[0]!.fee).toFixed(2)} EUR, which an order by the hour is not meant to pay`);
  const readable = free.filter((offer) => (offer.tags ?? []).includes(CLOUD_INIT_TAG));
  if (readable.length === 0) refuse("invalid-server-type", `${name} at ${zone} installs no system that reads a user-data: Scaleway does not tag it ${CLOUD_INIT_TAG}`);
  const offer = readable.find((candidate) => candidate.stock !== "empty");
  if (offer === undefined) refuse("type-unavailable", `Scaleway has no ${name} in stock at ${zone}`, ["or try another --location"]);
  return offer!;
}

/** Codenames of the Marketplace's labels, `ubuntu_noble`, for a program that names the same system on both kinds of machine. */
const CODENAMES: Record<string, string> = { noble: "24.04", jammy: "22.04", trixie: "13", bookworm: "12" };

/**
 * The system an image names: `ubuntu-24.04`, `Ubuntu 24.04`, `debian-13`, or
 * a Marketplace label, `ubuntu_noble`. Null for anything else.
 */
export function wantedOs(image: string): { name: string; version: string } | null {
  const label = /^([a-z]+)_([a-z]+)$/.exec(image);
  if (label !== null && CODENAMES[label[2]!] !== undefined) return { name: label[1]!, version: CODENAMES[label[2]!]! };
  const named = /^([A-Za-z]+)[\s_-]+(\d+(?:\.\d+)*)$/.exec(image.trim());
  return named === null ? null : { name: named[1]!.toLowerCase(), version: named[2]! };
}

/**
 * The system to install: the catalogue's entry of that name whose version
 * starts with the one asked, `24.04` taking `24.04 LTS`, that the account may
 * install, that reads a user-data and that the offer takes; or the refusal
 * that says which of those it fails.
 */
export function chooseOs(systems: readonly MetalOs[], image: string, offer: MetalOffer, zone: string): MetalOs {
  const wanted = wantedOs(image);
  const listed = systems.map((os) => `${os.name} ${os.version}`);
  if (wanted === null) {
    throw new ProviderError({ error: "invalid-image", message: `${image} names no system of Scaleway's Elastic Metal catalogue`, details: ["--image takes a name and a version, ubuntu-24.04, or an ID of the catalogue", `the catalogue of ${offer.name} at ${zone}: ${listed.join(", ")}`] });
  }
  const version = new RegExp(`^${wanted.version.replaceAll(".", "\\.")}(?![0-9])`);
  const named = systems.filter((os) => os.name.toLowerCase() === wanted.name && version.test(os.version));
  const usable = named.filter((os) => os.enabled && os.allowed && os.cloud_init_supported && !(offer.incompatible_os_ids ?? []).includes(os.id));
  const chosen = usable.find((os) => os.license_required !== true) ?? usable[0];
  if (chosen !== undefined) return chosen;
  const why =
    named.length === 0
      ? `the catalogue of ${offer.name} at ${zone}: ${listed.join(", ")}`
      : named.some((os) => !os.cloud_init_supported)
        ? "it does not read a user-data (cloud_init_supported is false)"
        : `the account may not install it on ${offer.name}, or Scaleway disabled it`;
  throw new ProviderError({ error: "invalid-image", message: `Scaleway installs no ${wanted.name} ${wanted.version} on ${offer.name} at ${zone} that a machine can be ordered with`, details: [why, "nothing had been created yet"] });
}

/**
 * Where the server stands, in Scaleway's words: its status until it is
 * delivered, then its install's until the system is on its disks.
 */
export function metalStatus(server: MetalServer): string {
  if (server.status === "ready" && server.install !== null && server.install !== undefined && server.install.status !== "completed") return server.install.status;
  return server.status;
}

export function metalMachine(server: MetalServer, offer: MetalOffer | undefined, owner: Owner): Machine {
  const v4 = (server.ips ?? []).find((ip) => ip.version === "IPv4");
  const v6 = (server.ips ?? []).find((ip) => ip.version === "IPv6");
  const monthly = offer === undefined ? null : (hourlyPrice(offer) * HOURS_A_MONTH).toFixed(4);
  return {
    provider: "scaleway",
    id: server.id,
    name: server.name,
    type: server.offer_name,
    location: server.zone,
    status: metalStatus(server),
    ipv4: v4?.address ?? null,
    ipv6: v6?.address ?? null,
    // The API gives the address alone, not the network it is routed in.
    ipv6Network: null,
    // Before VAT only, which depends on the customer: gross repeats net.
    monthlyPrice: monthly === null ? null : { net: monthly, gross: monthly, currency: offer?.price_per_hour?.currency_code ?? "EUR" },
    backups: false,
    managed: owner.manages(labelsOfTags(server.tags)),
    labels: labelsOfTags(server.tags),
    // The account the install created for the keys, `ubuntu` on Ubuntu.
    login: server.install?.user || "root",
  };
}

// --- the install key ---------------------------------------------------------------------

/** The name of the throwaway key a machine is installed with. */
export function installKeyName(owner: Owner, machine: string): string {
  return `${owner.name}-${machine}-install`;
}

function sshString(bytes: Uint8Array): Uint8Array {
  const field = new Uint8Array(4 + bytes.length);
  new DataView(field.buffer).setUint32(0, bytes.length);
  field.set(bytes, 4);
  return field;
}

/**
 * A fresh Ed25519 public key in OpenSSH's form, `ssh-ed25519 AAAA... comment`.
 * The private half is made unexportable and dropped with the pair: nobody can
 * log in with the key, which only lets the install start. The machine is
 * reached through the user-data's key, as every other.
 */
export async function throwawayKey(comment: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const blob = Buffer.concat([sshString(new TextEncoder().encode("ssh-ed25519")), sshString(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}
