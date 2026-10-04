/**
 * The port of an app whose manifest declares none, chosen by `deploy` from
 * what the machine carries.
 *
 * A port is the one value of a manifest nobody can pick well from the
 * workstation: it has to be free on the machine, which only the manifests
 * deposited there know, and an agent writing its first manifest knows none of
 * them. `deploy` therefore picks it, writes it into the local sitesolide.json,
 * and says so: committed, it keeps the next deployment on the same port, which
 * is what keeps the generated unit and block equal to the ones in service.
 *
 * The choice stays inside the range the loopback rule closes, so that no other
 * project can reach the service, and avoids every port the machine's manifests
 * declare, the ports no manifest declares (RESERVED_PORTS) and those of the
 * platform's own services, even when they are not deployed yet: a project on
 * the portal's port would refuse the portal's first deployment, and be
 * reachable by the dashboard, which the loopback rule lets through to it.
 *
 * Only a project with a single service gets one. The services of a project
 * that declares several call each other on ports their own `env` names, and a
 * port picked here would not be the one written there.
 *
 * Pure: returns decisions and text, touches nothing.
 */
import { hasServices, isApp, mainPort, readManifest, SERVICE_PORTS, servicesOf, type Manifest } from "./manifest";
import { PLATFORM_PORTS, reservedPorts } from "./services";

/**
 * The platform's services, by port. In services.ts, which the dashboard
 * borrows, so that the installer reserves them too: see reservedPorts.
 */
export { PLATFORM_PORTS };

/** An app with a single `start` and no `port`: the one shape `deploy` gives a port to. */
export function needsPort(manifest: Manifest): boolean {
  return isApp(manifest) && !hasServices(manifest) && manifest.port === undefined;
}

export type PortChoice =
  /** `kept`: the port the machine already gives this project; `free`: the lowest one left. */
  | { kind: "kept" | "free"; port: number }
  | { kind: "full" };

/**
 * The port for `slug`, given the manifests deposited on the machine, by folder.
 *
 * A project the machine already carries keeps the port its deposited manifest
 * declares: its unit listens there, and moving it would leave the installed
 * unit, which `deploy` never replaces without --force, on the old port while
 * the new block points at the new one. That happens on every fresh clone of a
 * repository whose chosen port was never committed.
 *
 * Every other project gets the lowest port of the range nothing claims. A
 * deposited manifest that no longer reads still holds the ports it can be read
 * for, as portConflicts in services.ts reads them.
 */
export function choosePort(slug: string, deposited: ReadonlyMap<string, string>): PortChoice {
  const taken = new Set<number>(reservedPorts(slug).keys());
  for (const [folder, raw] of deposited) {
    const { manifest } = readManifest(raw);
    if (manifest === undefined) continue;
    if (folder === slug) {
      const port = hasServices(manifest) ? null : mainPort(manifest);
      if (port !== null && Number.isInteger(port) && port >= 1024 && port <= 65535) return { kind: "kept", port };
      continue;
    }
    for (const service of servicesOf(manifest)) {
      if (typeof service.port === "number") taken.add(service.port);
    }
  }
  for (let port = SERVICE_PORTS.first; port <= SERVICE_PORTS.last; port++) {
    if (!taken.has(port)) return { kind: "free", port };
  }
  return { kind: "full" };
}

/**
 * The manifest rewritten with its `port`, placed right after `start` as the
 * documentation writes it, the rest left as it is, key order included: the
 * file is versioned, and choosing a port must read as one added line.
 */
export function setPort(raw: string, port: number): string {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sitesolide.json must contain an object");
  }
  const entries = Object.entries(parsed as Record<string, unknown>).filter(([key]) => key !== "port");
  const anchor = entries.findIndex(([key]) => key === "start");
  entries.splice(anchor === -1 ? entries.length : anchor + 1, 0, ["port", port]);
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}
