/**
 * Turning a project off, on, and removing it from the dashboard: what each
 * one asks of the project the machine carries.
 *
 * A project turned off keeps everything, its code, its data, its store of
 * secrets, its account, its units, its people with access and its tokens: its
 * services are stopped and disabled, and every address it has answers a 503
 * that says it is off (disabledFragment in fragment.ts). Its manifest carries
 * `disabled`, which the machine writes, as it writes `lock`: a deployment, a
 * change of general access and a rename are refused while it is off, since
 * each would lay its own block back and serve it. Turned on, its own block
 * and its services are back.
 *
 * Removed from the dashboard, it goes as `sitesolide remove` takes it: its
 * units, its folder and data, its store, its account and its block; its
 * people with access and the token that created it let go of it; its backup
 * snapshots stay.
 *
 * Pure, and borrowed by the dashboard: the steward and the machine's run
 * judge with this one copy. The run itself is dashboard/src/installer/lifecycle.ts.
 */
import { readManifest } from "./manifest";
import { UNRENAMABLE, type Deposited } from "./rename";

export type Lifecycle = "disable" | "enable" | "remove";

export const LIFECYCLES: readonly Lifecycle[] = ["disable", "enable", "remove"];

export function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === "string" && (LIFECYCLES as readonly string[]).includes(value);
}

/** The refusal a disabled project gives to what would serve it again, for deploy, the gatekeeper and a rename. */
export function disabledRefusal(slug: string): string {
  return `${slug} is turned off on the machine: turn it on first, from its Overview in the dashboard or with sitesolide enable`;
}

/** Why `action` cannot be done to `slug` on a machine carrying `deposited`, null when it can. */
export function lifecycleRefusal(action: Lifecycle, slug: string, deposited: Deposited, zone: string): string | null {
  if ((UNRENAMABLE as readonly string[]).includes(slug) || (zone !== "" && slug === zone)) return `${slug} is the platform's own: it is never turned off nor removed from here`;
  const raw = deposited.get(slug);
  if (raw === undefined) return `the machine carries no project named ${slug}`;
  const { manifest, errors } = readManifest(raw);
  if (manifest === undefined || manifest.slug !== slug) {
    return `/srv/sites/${slug}/sitesolide.json does not read as ${slug}'s (${errors.join("; ") || "another slug"}): the owner must look at it`;
  }
  const off = manifest.disabled === true;
  if (action === "disable" && off) return `${slug} is already turned off`;
  if (action === "enable" && !off) return `${slug} is already on`;
  // The code lives in the preview locks, which the gatekeeper alone writes:
  // removed with the folder, it would stay in force for a name nobody holds.
  if (action === "remove" && manifest.lock === true) {
    return `${slug} opens with a code: choose Public or Restricted in its Access section first, then remove it`;
  }
  return null;
}
