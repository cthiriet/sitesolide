/**
 * The port of an app whose manifest declares none.
 *
 * A port is the one value of a manifest nobody can pick well from the
 * workstation: it has to be free on the machine, which only the manifests
 * deposited there know, and an agent writing its first manifest knows none of
 * them. The dashboard's control API therefore picks it when a token deploys
 * (allocatePorts in dashboard/src/control/policy.ts), and `deploy` writes it
 * into the local sitesolide.json and says so: committed, it keeps the next
 * deployment on the same port, which is what keeps the generated unit and
 * block equal to the ones in service.
 *
 * Pure: returns decisions and text, touches nothing.
 */
import { hasServices, isApp, type Manifest } from "./manifest";

/** An app with a single `start` and no `port`: the one shape `deploy` gives a port to. */
export function needsPort(manifest: Manifest): boolean {
  return isApp(manifest) && !hasServices(manifest) && manifest.port === undefined;
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
