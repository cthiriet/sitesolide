/**
 * A member's own tokens: what a member may mint, and what a token of theirs
 * may do at the moment it is used. Pure: the rights come in as a value, read
 * by the steward from its registry at that moment.
 *
 * **Never stronger than the member.** A token is the CLI's and an agent's
 * tool, and a member mints their own from the dashboard, under their unlock.
 * What it may deploy is what the member's role allows (powers.ts):
 *
 * | Scope | Takes |
 * |---|---|
 * | a project in `slugs` | a Developer or a Project admin there (`deploy`) |
 * | `create` | the create right, which the super admin grants per member |
 * | `public`, `domain`, `outbound` | a Project admin of every project of the token; with `create`, what they create makes them its Project admin |
 *
 * A Viewer everywhere, without the create right, mints nothing. `public` is
 * what opens a door: a new project in the open, paths exempted from the
 * portal. An existing project keeps the door the machine carries, which its
 * Project admin or the owner chose, and a Developer's token deploys it as it
 * stands, in the open if it is (src/control/policy.ts, `decideDoor`).
 *
 * **Narrowed live.** A token's scope is a copy taken when it was minted; the
 * member's roles move after it. So the steward narrows a member's token to
 * the member's rights as its registry reads at each use: when the token
 * authenticates (every request of the control API), when it judges a slug,
 * and again when the installer starts (src/installer/main.ts). A role lowered
 * to Viewer stops that project's deployments at once, the create right taken
 * back stops new projects, and a member removed is refused outright, their
 * tokens revoked with them. The options hold only while the member is
 * Project admin of every project the token reaches: one project lowered turns
 * them off for the whole token, the narrower reading, and the member mints
 * another for what they still administer.
 */
import type { Identity, Scope } from "../control/protocol";
import { may, powerRefusal, type Power } from "./powers";
import type { Role, Roles } from "./protocol";
import { findMember, type Registry } from "./registry";

/** What a member holds now: their roles, and whether they may create projects. */
export type MemberRights = { email: string; roles: Roles; create: boolean };

/** Live tokens one member holds at most: a laptop, a desktop, a few agents. The registry is the team's, not one member's. */
export const MAX_TOKENS_PER_MEMBER = 10;

/** A member's rights as this registry reads, or null when the email is no member. */
export function rightsOf(registry: Registry, email: string): MemberRights | null {
  const member = findMember(registry, email);
  return member === null ? null : { email: member.email, roles: { ...member.roles }, create: member.create };
}

function roleOn(rights: MemberRights, slug: string): Role | null {
  return Object.hasOwn(rights.roles, slug) ? rights.roles[slug]! : null;
}

/** The scope's options, and the power each one takes on a project. */
const OPTIONS: readonly (readonly ["public" | "domain" | "outbound", Power])[] = [
  ["public", "deploy.public"],
  ["domain", "deploy.domain"],
  ["outbound", "deploy.outbound"],
];

const NO_CREATE = "creating projects is a right the super admin grants, from the Members page";

/**
 * Why this member may not mint this scope: every reason at once, each naming
 * the field it is about and saying what the role allows. Empty: they may.
 */
export function mintRefusals(scope: Scope, rights: MemberRights): string[] {
  const { email } = rights;
  const deploys = Object.values(rights.roles).some((role) => may(role, "deploy"));
  if (!deploys && !rights.create) {
    return [`${email} is a viewer on every project and may not create projects: a viewer mints no token`];
  }
  const refusals: string[] = [];
  if (scope.slugs.length === 0 && !scope.create) refusals.push("scope.slugs: choose at least one project, or creating projects");
  for (const slug of scope.slugs) {
    const role = roleOn(rights, slug);
    if (!may(role, "deploy")) refusals.push(`scope.slugs: ${powerRefusal(email, role, slug, "deploy")}`);
  }
  if (scope.create && !rights.create) refusals.push(`scope.create: ${email} may not create projects: ${NO_CREATE}`);
  for (const [option, power] of OPTIONS) {
    if (!scope[option]) continue;
    for (const slug of scope.slugs) {
      const role = roleOn(rights, slug);
      // A project they may not deploy at all is said once, above.
      if (may(role, "deploy") && !may(role, power)) refusals.push(`scope.${option}: ${powerRefusal(email, role, slug, power)}`);
    }
  }
  return refusals;
}

/**
 * A member's token as it stands now: its projects, granted or created, kept
 * where the member may still deploy; `create` while they hold the right; each
 * option while they are Project admin of every project it still reaches.
 * `member` names them, so that every reader of the identity knows whose
 * rights bound it.
 */
export function narrowIdentity(identity: Identity, rights: MemberRights): Identity {
  const deploys = (slug: string) => may(roleOn(rights, slug), "deploy");
  const slugs = identity.scope.slugs.filter(deploys);
  const owned = identity.owned.filter(deploys);
  const create = identity.scope.create && rights.create;
  const reached = [...new Set([...slugs, ...owned])];
  const holds = (power: Power) => (reached.length > 0 || create) && reached.every((slug) => may(roleOn(rights, slug), power));
  return {
    ...identity,
    member: rights.email,
    owned,
    scope: {
      slugs,
      create,
      public: identity.scope.public && holds("deploy.public"),
      domain: identity.scope.domain && holds("deploy.domain"),
      outbound: identity.scope.outbound && holds("deploy.outbound"),
    },
  };
}

/**
 * Why this member may not deploy this slug now, or null. Judged before the
 * token's own rule (src/control/policy.ts, `decideSlug`), which counts a
 * project the token created as its own: for a member's token, the role says,
 * not who created it. An existing project takes a Developer or a Project
 * admin; a new one, the create right.
 */
export function deployRefusal(rights: MemberRights, slug: string, exists: boolean): string | null {
  if (exists) {
    const role = roleOn(rights, slug);
    return may(role, "deploy") ? null : powerRefusal(rights.email, role, slug, "deploy");
  }
  return rights.create ? null : `${rights.email} may not create projects: ${NO_CREATE}`;
}

/**
 * The scope the installer applies to a member's deployment, judged once more
 * when it starts, against the registry as it reads then: the member still
 * there, the create right for a project being created, a Developer or a
 * Project admin role on an existing one, and each option only for a Project
 * admin. The request's scope, already narrowed by the steward, is only ever
 * narrowed further.
 */
export function installScope(scope: Scope, rights: MemberRights | null, slug: string, creating: boolean): { scope: Scope } | { refusal: string } {
  if (rights === null) return { refusal: "the member who holds this token is no longer a member of this dashboard: nothing was changed" };
  if (creating) {
    return rights.create ? { scope } : { refusal: `${rights.email} may no longer create projects: nothing was changed` };
  }
  const role = roleOn(rights, slug);
  if (!may(role, "deploy")) return { refusal: `${powerRefusal(rights.email, role, slug, "deploy")}: nothing was changed` };
  return {
    scope: {
      ...scope,
      public: scope.public && may(role, "deploy.public"),
      domain: scope.domain && may(role, "deploy.domain"),
      outbound: scope.outbound && may(role, "deploy.outbound"),
    },
  };
}

/** A scope in a few words, for the journal: `alpha, beta; create, outbound`. Never more than a line. */
export function scopeText(scope: Scope): string {
  const options = [scope.create ? "create" : null, scope.public ? "public" : null, scope.domain ? "domain" : null, scope.outbound ? "outbound" : null].filter(
    (part): part is string => part !== null,
  );
  const projects = scope.slugs.length === 0 ? "no project" : scope.slugs.join(", ");
  return options.length === 0 ? projects : `${projects}; ${options.join(", ")}`;
}
