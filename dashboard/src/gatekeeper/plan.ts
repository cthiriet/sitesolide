/**
 * What the gatekeeper must do, decided before touching anything at all.
 *
 * Pure: the dropped manifest and the block in service come in as text, a
 * decision comes out. The transaction executes only this plan, and every
 * refusal is checked here without a disk or Caddy.
 *
 * Three outcomes:
 *
 *   - `refusal`: nothing will be touched, and `message` says why;
 *   - `nothing`: the wanted state is already in place, `ok` answer with no reload;
 *   - `change`: the new manifest, and what must be done with the block.
 *
 * The new block is generated exactly as `sitesolide deploy` generates it, by
 * the same `generateFragment` borrowed from bin/cli/fragment.ts: the next
 * deployment will write the same block, and nothing will diverge.
 */
import { compareDirectives, sameDirectives } from "../../borrowed/comparison";
import { generateFragment } from "../../borrowed/fragment";
import { isProtected, readManifest, setPortal, validate, type Manifest } from "../../borrowed/manifest";
import { fragmentIsProtected } from "../../borrowed/portal";
import { fixedRefusal, actionRefusal } from "./rules";

/** What the machine carries before the action: `null` for a missing file. */
export type Deployed = { manifest: string | null; block: string | null };

export type BlockAction =
  | { kind: "write"; text: string }
  /** A static site that loses its door: `installerFragment` puts no block in place for it. */
  | { kind: "remove" }
  | { kind: "none" };

export type Plan =
  | { kind: "rejects"; message: string }
  | { kind: "nothing"; message: string }
  | { kind: "change"; manifest: string; block: BlockAction };

export type Generator = (manifest: Manifest) => string | null;

function read(raw: string | null): Manifest | null {
  if (raw === null) return null;
  return readManifest(raw).manifest ?? null;
}

/**
 * `generate` exists only for the tests: it lets the block-removal branch be
 * tried out, which no valid manifest reaches as long as `validate()` reserves
 * the portal to app sites.
 */
export function planPortal(
  slug: string,
  active: boolean,
  deployed: Deployed,
  generate: Generator = generateFragment,
): Plan {
  const manifest = read(deployed.manifest);
  const fixed = fixedRefusal(slug, manifest);
  if (fixed !== null || manifest === null || deployed.manifest === null) {
    return { kind: "rejects", message: fixed ?? "no readable sitesolide.json on the server" };
  }

  // The block in service must be the one the current manifest generates. A
  // block touched up by hand carries a decision the manifest knows nothing
  // about, and rewriting it would erase it without anyone having seen it. The
  // directives alone count, as for `sitesolide deploy`: a changed comment is
  // not a touch-up.
  const expected = generate(manifest);
  if (expected === null && deployed.block !== null) {
    return {
      kind: "rejects",
      message: `/etc/caddy/sites/${slug}.caddy exists but sitesolide.json generates no block, fix it by hand first`,
    };
  }
  if (expected !== null && deployed.block === null) {
    return {
      kind: "rejects",
      message: `/etc/caddy/sites/${slug}.caddy is missing, redeploy the site first`,
    };
  }
  if (expected !== null && deployed.block !== null && !sameDirectives(deployed.block, expected)) {
    const { lost, added } = compareDirectives(deployed.block, expected);
    return {
      kind: "rejects",
      message: `the Caddy block in service differs from what sitesolide.json generates (${lost.length} line(s) not generated, ${added.length} missing), redeploy the site first`,
    };
  }

  // Already in the wanted state: nothing to do, even for an action the rules
  // would refuse in the other direction. Taking away the door of a static site
  // that has none is not an error.
  if (isProtected(manifest) === active) {
    return { kind: "nothing", message: active ? "already behind the portal" : "already open, no portal" };
  }

  const refusal = actionRefusal(manifest, active);
  if (refusal !== null) return { kind: "rejects", message: refusal };

  // The rewritten text is re-read and judged again: it is the one that goes
  // onto the disk, and it must say exactly what `actionRefusal` judged on the
  // object.
  const newRaw = setPortal(deployed.manifest, active);
  const newManifest = read(newRaw);
  if (newManifest === null) return { kind: "rejects", message: "the rewritten sitesolide.json is unreadable" };
  const errors = validate(newManifest);
  if (errors.length > 0 || isProtected(newManifest) !== active) {
    return { kind: "rejects", message: `the rewritten sitesolide.json is invalid: ${errors[0] ?? "portal"}` };
  }

  const block = generate(newManifest);

  // The last lock: a manifest that asks for the door must generate a block
  // that carries it. The day `validate()` would admit a static site behind the
  // portal without the generator knowing how to close it, the gatekeeper would
  // write `portal: true` for a site served in the clear, the worst possible
  // state.
  if (fragmentIsProtected(block ?? "") !== active) {
    return {
      kind: "rejects",
      message: active
        ? "the generated Caddy block would not carry the portal guard"
        : "the generated Caddy block would still carry the portal guard",
    };
  }

  let action: BlockAction;
  if (block !== null) action = { kind: "write", text: block };
  else if (deployed.block !== null) action = { kind: "remove" };
  else action = { kind: "none" };

  return { kind: "change", manifest: newRaw, block: action };
}

/** What the machine carries, read as the dashboard reads it. */
export function portalState(deployed: Deployed): { requested: boolean; installed: boolean } {
  const manifest = read(deployed.manifest);
  return {
    requested: manifest !== null && isProtected(manifest),
    installed: deployed.block !== null && fragmentIsProtected(deployed.block),
  };
}
