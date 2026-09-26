/**
 * What the sites must answer after the reload, judged without a network.
 *
 * The machine questions, this module decides. Two rules, taken from
 * bin/deploy-caddy.sh and from `check` in bin/sitesolide.ts:
 *
 *   - a site answers if it returns 200 or 401, the 401 being the wanted form
 *     of a locked preview as of a site behind the portal;
 *   - a site behind the portal does not answer just any 401, but the portal's,
 *     recognisable by `X-Portal: connexion` (portal/src/gate.ts). A 200 there
 *     would be the worst possible state: a site its owner believes closed.
 *
 * Beyond the targeted site, **every served site** must still answer: a block
 * that claimed another's host by mistake would be enough to cut it off. The
 * comparison is made against a reading taken before the action. A site that
 * already did not answer is no reason to restore, failing which an unrelated
 * outage would block every action on the portal; it is named, and no more.
 *
 * Pure.
 */
import { isValidSlug, PORTAL_SLUG } from "../../borrowed/manifest";

export type ProbeResponse = { code: number; door: boolean; body: string } | { error: string };

/** The portal's 401 and it alone. */
export function fromPortal(response: ProbeResponse): boolean {
  return "code" in response && response.code === 401 && response.door;
}

export function answers(response: ProbeResponse): boolean {
  return "code" in response && (response.code === 200 || response.code === 401);
}

export function describe(response: ProbeResponse): string {
  if ("error" in response) return response.error;
  return response.door ? `${response.code} from the portal` : String(response.code);
}

/**
 * The targeted site, after the action: null if it is in the wanted state,
 * otherwise what is wrong, in English.
 */
export function judgeTarget(active: boolean, host: string, response: ProbeResponse): string | null {
  if (active) {
    return fromPortal(response) ? null : `${host} should answer the portal's 401, got ${describe(response)}`;
  }
  if (fromPortal(response)) return `${host} still answers the portal's 401`;
  return answers(response) ? null : `${host} does not answer, got ${describe(response)}`;
}

/**
 * Is the portal ready to guard a door? `/sante` returns `configure: true` when
 * a hash is in place. A site put behind a stopped portal would be closed with a
 * 502, behind a portal with no hash it would be closed to its owner himself:
 * `requirePortal` of the CLI refuses both, here too.
 */
export function isPortalReady(response: ProbeResponse): boolean {
  if (!("code" in response) || response.code !== 200) return false;
  try {
    return (JSON.parse(response.body) as { configure?: unknown }).configure === true;
  } catch {
    return false;
  }
}

/**
 * The hosts to question: the bare domain and www, served by the landing, then
 * `<slug>.<zone>` for each served directory. The landing's directory is
 * already covered by the bare domain, and a name that is not a slug has no
 * address under the zone.
 */
export function servedHosts(zone: string, slugs: string[]): string[] {
  const hosts = [zone, `www.${zone}`];
  for (const slug of [...slugs].sort()) {
    if (slug === zone || !isValidSlug(slug)) continue;
    hosts.push(`${slug}.${zone}`);
  }
  return [...new Set(hosts)];
}

export function portalHost(zone: string): string {
  return `${PORTAL_SLUG}.${zone}`;
}

/**
 * The hosts that answered before the action and no longer answer, the targeted
 * site aside: it has its own rule. A host the second series did not question
 * counts as lost.
 */
export function regressions(
  before: Map<string, ProbeResponse>,
  after: Map<string, ProbeResponse>,
  target: string,
): string[] {
  const lost: string[] = [];
  for (const [host, response] of before) {
    if (host === target || !answers(response)) continue;
    const now = after.get(host);
    if (now === undefined || !answers(now)) lost.push(host);
  }
  return lost;
}

/** The sites that already did not answer before the action, for the message. */
export function alreadySilent(before: Map<string, ProbeResponse>, target: string): string[] {
  return [...before].filter(([host, response]) => host !== target && !answers(response)).map(([host]) => host);
}
