/**
 * What the gatekeeper must do, decided before touching anything at all.
 *
 * Pure: what the machine carries comes in as text, a decision comes out. The
 * transaction executes only this plan, and every refusal is checked here
 * without a disk or Caddy.
 *
 * Three outcomes:
 *
 *   - `refusal`: nothing will be touched, and `message` says why;
 *   - `nothing`: the wanted state is already in place, `ok` answer with no reload;
 *   - `change`: the new manifest, what must be done with the block, and with
 *     the preview locks: the codes file and the fragment Caddy imports.
 *
 * A site's general access lives in up to four files, and a switch changes
 * every one it must in the same plan:
 *
 *   /srv/sites/<slug>/sitesolide.json   `portal` or `lock`, never both
 *   /etc/caddy/sites/<slug>.caddy       the portal's guard, for Restricted
 *   /etc/caddy/locks-codes.json         the code, for Anyone with the code
 *   /etc/caddy/locks/verrous.caddy      the stanza that asks for it
 *
 * The new block is generated exactly as `sitesolide deploy` generates it, by
 * the same `generateFragment` borrowed from bin/cli/fragment.ts, and the
 * locks fragment by the same `buildFragment` as before, from api/src/locks.ts:
 * the next deployment writes the same block, and nothing diverges.
 */
import { compareDirectives, sameDirectives } from "../../borrowed/comparison";
import { generateFragment, isEarlierGeneration } from "../../borrowed/fragment";
import { buildFragment, encodeCodes, generateCode, installedCode, isValidCode, previewHost, readCodes, stanzaClosesEveryAddress } from "../../borrowed/locks";
import { isProtected, readManifest, setLock, setPortal, validate, type Manifest } from "../../borrowed/manifest";
import { fragmentIsProtected } from "../../borrowed/portal";
import { targetOf, type Action, type GeneralAccess } from "./instance";
import { fixedRefusal, targetRefusal } from "./rules";

/** What the machine carries before the action: `null` for a missing file. */
export type Deployed = {
  manifest: string | null;
  block: string | null;
  /** `/etc/caddy/locks-codes.json`; an error when it could not be read. */
  codes: string | null | { error: string };
  /** `/etc/caddy/locks/verrous.caddy`, the fragment in service. */
  fragment: string | null;
  /**
   * Every directory of /srv/sites and its manifest's `lock`, as the fragment
   * is generated from them all; an error when one could not be read.
   */
  sites: { slug: string; lock: unknown }[] | { error: string };
};

export type BlockAction =
  | { kind: "write"; text: string }
  /** A static site that loses its door: `installerFragment` puts no block in place for it. */
  | { kind: "remove" }
  | { kind: "none" };

/** The preview locks once the action is done. */
export type LocksChange = {
  /** The codes file, null when it stays as it is. */
  codes: string | null;
  /** The fragment, null when it stays as it is. */
  fragment: string | null;
};

export type Plan =
  | { kind: "rejects"; message: string }
  | { kind: "nothing"; message: string; target: GeneralAccess; code: string | null }
  | {
      kind: "change";
      target: GeneralAccess;
      /** The new manifest, null when it stays as it is. */
      manifest: string | null;
      block: BlockAction;
      /** The portal goes up or comes down: the block may be rewritten for its generation alone. */
      portalChanged: boolean;
      locks: LocksChange | null;
      /** The code in force once done, the one to probe with; null outside the code. */
      code: string | null;
      /** The code the stanza in service carried, which must stop opening the site; null if none. */
      previous: string | null;
      /** The site opened with a code, or its manifest asked for one, and no longer will. */
      leaving: boolean;
    };

export type Generator = (manifest: Manifest) => string | null;

export type PlanOptions = {
  zone: string;
  /** The draw of a code; the tests impose one. */
  draw?: () => string;
  /** Exists only for the tests: it lets the block-removal branch be tried out. */
  generate?: Generator;
  /** Where the door pages live, written into each stanza. */
  doorPagesDir?: string;
};

function read(raw: string | null): Manifest | null {
  if (raw === null) return null;
  return readManifest(raw).manifest ?? null;
}

const ALREADY: Record<GeneralAccess, string> = {
  public: "already public",
  restricted: "already restricted",
  code: "already open with a code",
};

/** Draws a code other than the one in force, so that a new code is never the old one. */
function drawOther(draw: () => string, previous: string | null): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = draw();
    if (isValidCode(code) && code !== previous) return code;
  }
  throw new Error("the draw gave no new valid code");
}

export function planGeneral(slug: string, action: Action, deployed: Deployed, options: PlanOptions): Plan {
  const generate = options.generate ?? generateFragment;
  const draw = options.draw ?? (() => generateCode());
  const target = targetOf(action);

  const manifest = read(deployed.manifest);
  const fixed = fixedRefusal(slug, manifest);
  if (fixed !== null || manifest === null || deployed.manifest === null) {
    return { kind: "rejects", message: fixed ?? "no readable sitesolide.json on the server" };
  }

  // The block in service must be the one the current manifest generates. A
  // block touched up by hand carries a decision the manifest knows nothing
  // about, and rewriting it would erase it without anyone having seen it. The
  // directives alone count, as for `sitesolide deploy`: a changed comment is
  // not a touch-up. Nor is the same block as an earlier release generated it,
  // a protected site deployed before the identity headers: the generator's
  // own, which the new block replaces as `deploy` would.
  const expected = generate(manifest);
  if (expected === null && deployed.block !== null) {
    return {
      kind: "rejects",
      message: `/etc/caddy/sites/${slug}.caddy exists but sitesolide.json generates no block, fix it by hand first`,
    };
  }
  if (expected !== null && deployed.block === null) {
    return { kind: "rejects", message: `/etc/caddy/sites/${slug}.caddy is missing, redeploy the site first` };
  }
  if (
    expected !== null &&
    deployed.block !== null &&
    !sameDirectives(deployed.block, expected) &&
    !isEarlierGeneration(deployed.block, manifest)
  ) {
    const { lost, added } = compareDirectives(deployed.block, expected);
    return {
      kind: "rejects",
      message: `the Caddy block in service differs from what sitesolide.json generates (${lost.length} line(s) not generated, ${added.length} missing), redeploy the site first`,
    };
  }

  const locked = manifest.lock === true;
  if (action === "renew" && !locked) {
    return { kind: "rejects", message: `${slug} does not open with a code: choose Anyone with the code first` };
  }

  // The codes and the other sites' locks only matter when this site's lock is
  // at stake: an unreadable codes file never stops a site that has nothing to
  // do with the locks from being restricted or made public.
  const inService = installedCode(deployed.fragment, slug);
  const codesRead = typeof deployed.codes === "object" && deployed.codes !== null ? null : deployed.codes;
  let codes: Record<string, unknown> | null = null;
  let codesError: string | null = typeof deployed.codes === "object" && deployed.codes !== null ? deployed.codes.error : null;
  if (codesError === null) {
    try {
      codes = readCodes(codesRead);
    } catch (error) {
      codesError = (error as Error).message;
    }
  }
  // A codes file that does not read cannot say whether it holds a code for
  // this site: the stanza in service and the manifest say whether one is at
  // stake, and a stale entry, harmless, waits for the file to read again.
  const hasCode = codes !== null && Object.hasOwn(codes, slug);
  const involved = target === "code" || locked || inService !== null || hasCode;

  // Already in the wanted state: nothing to do, even for an action the rules
  // would refuse in the other direction. Taking away the door of a static site
  // that has none is not an error.
  const current = codes === null ? null : codes[slug];
  const currentCode = isValidCode(current) ? current : null;
  if (action !== "renew" && isProtected(manifest) === (target === "restricted") && locked === (target === "code")) {
    // The code in force, and the stanza that asks for it in service, in the
    // form that closes the site's own domain too: one an earlier release
    // wrote is written again; or, for the other two, neither a code nor a
    // stanza left behind.
    const inPlace =
      target === "code"
        ? currentCode !== null && inService === currentCode && stanzaClosesEveryAddress(deployed.fragment, slug)
        : !hasCode && inService === null;
    if (inPlace) return { kind: "nothing", message: ALREADY[target], target, code: target === "code" ? currentCode : null };
  }

  const refusal = targetRefusal(manifest, target);
  if (refusal !== null) return { kind: "rejects", message: refusal };

  if (involved && codesError !== null) {
    return { kind: "rejects", message: `the codes file on the server does not read (${codesError}), nothing was changed: check /etc/caddy/locks-codes.json` };
  }

  // The rewritten text is re-read and judged again: it is the one that goes
  // onto the disk, and it must say exactly what `targetRefusal` judged on the
  // object. Only the fields that change are rewritten.
  let newRaw: string | null = null;
  let next = deployed.manifest;
  if (isProtected(manifest) !== (target === "restricted")) next = setPortal(next, target === "restricted");
  if (locked !== (target === "code")) next = setLock(next, target === "code");
  if (next !== deployed.manifest) newRaw = next;
  const newManifest = read(next);
  if (newManifest === null) return { kind: "rejects", message: "the rewritten sitesolide.json is unreadable" };
  const errors = validate(newManifest);
  if (errors.length > 0 || isProtected(newManifest) !== (target === "restricted") || (newManifest.lock === true) !== (target === "code")) {
    return { kind: "rejects", message: `the rewritten sitesolide.json is invalid: ${errors[0] ?? "portal or lock"}` };
  }

  // The block follows the manifest: rewritten when the portal changes, as it
  // is the only field of the two the block reads, and when the block in
  // service is the generator's own from an earlier release. The latter is no
  // detail: a site's own domain closes with its preview only in the current
  // generation, and a code set over the earlier block would leave the domain
  // open behind a closed preview, which the probe would then refuse.
  let blockAction: BlockAction = { kind: "none" };
  const portalChanged = isProtected(manifest) !== (target === "restricted");
  if (!portalChanged && expected !== null && deployed.block !== null && !sameDirectives(deployed.block, expected)) {
    const block = generate(newManifest);
    if (block === null || fragmentIsProtected(block) !== (target === "restricted")) {
      return { kind: "rejects", message: "the generated Caddy block does not carry the door the site has" };
    }
    blockAction = { kind: "write", text: block };
  }
  if (portalChanged) {
    const block = generate(newManifest);
    // The last lock: a manifest that asks for the door must generate a block
    // that carries it. The day `validate()` would admit a static site behind
    // the portal without the generator knowing how to close it, the gatekeeper
    // would write `portal: true` for a site served in the clear, the worst
    // possible state.
    if (fragmentIsProtected(block ?? "") !== (target === "restricted")) {
      return {
        kind: "rejects",
        message:
          target === "restricted"
            ? "the generated Caddy block would not carry the portal guard"
            : "the generated Caddy block would still carry the portal guard",
      };
    }
    if (block !== null) blockAction = { kind: "write", text: block };
    else if (deployed.block !== null) blockAction = { kind: "remove" };
  }

  const leaving = target !== "code" && (locked || inService !== null);
  if (!involved) {
    return { kind: "change", target, manifest: newRaw, block: blockAction, portalChanged, locks: null, code: null, previous: null, leaving };
  }

  // The preview locks: this site's code set or taken away, and the fragment
  // generated again from every site, as the generator always did. A site
  // elsewhere that asks for a lock without a code, or the reverse, stops
  // everything here: a fragment written half right would open what its owner
  // believes closed.
  if (!Array.isArray(deployed.sites)) {
    return { kind: "rejects", message: `the sites' manifests do not read (${deployed.sites.error}), nothing was changed` };
  }
  let code: string | null = null;
  try {
    code = target !== "code" ? null : action === "renew" || currentCode === null ? drawOther(draw, currentCode ?? inService) : currentCode;
  } catch (error) {
    return { kind: "rejects", message: `${(error as Error).message}, nothing was changed` };
  }
  const newCodes: Record<string, unknown> = { ...codes };
  if (code === null) delete newCodes[slug];
  else newCodes[slug] = code;
  // Written only when this site's entry changes: a missing file stays missing
  // for a site that has no code to lose.
  const codesChanged = code === null ? hasCode : current !== code;

  const sites = deployed.sites.some((site) => site.slug === slug) ? deployed.sites : [...deployed.sites, { slug, lock: undefined }];
  let fragment: string;
  try {
    fragment = buildFragment(
      sites.map((site) => ({
        slug: site.slug,
        host: previewHost(site.slug, options.zone),
        lock: site.slug === slug ? (target === "code" ? true : undefined) : site.lock,
        code: newCodes[site.slug],
      })),
      options.doorPagesDir === undefined ? {} : { doorPagesDir: options.doorPagesDir },
    );
  } catch (error) {
    return { kind: "rejects", message: `the preview locks cannot be generated: ${(error as Error).message}` };
  }
  // The same last lock for the code: the fragment must carry this site's
  // stanza with the code drawn, or none at all.
  if (installedCode(fragment, slug) !== code) {
    return { kind: "rejects", message: "the generated preview locks would not carry this site's code as wanted" };
  }

  const locks: LocksChange = {
    codes: codesChanged ? encodeCodes(newCodes) : null,
    fragment: fragment !== deployed.fragment ? fragment : null,
  };
  // The probe after a new code: the old one must have stopped opening the site.
  const previous = target === "code" && inService !== null && inService !== code ? inService : null;
  return { kind: "change", target, manifest: newRaw, block: blockAction, portalChanged, locks, code, previous, leaving };
}

/**
 * The site's own domain when it is served, read from the deposited manifest:
 * its name, which the gatekeeper checks beside the preview. Null without one,
 * inactive, or a manifest that does not read.
 */
export function activeDomain(raw: string | null): string | null {
  const domain = read(raw)?.domain;
  return domain?.active === true && typeof domain.name === "string" ? domain.name : null;
}

/** What the machine carries, read as the dashboard reads it. */
export function portalState(deployed: Pick<Deployed, "manifest" | "block">): { requested: boolean; installed: boolean } {
  const manifest = read(deployed.manifest);
  return {
    requested: manifest !== null && isProtected(manifest),
    installed: deployed.block !== null && fragmentIsProtected(deployed.block),
  };
}
