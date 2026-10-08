import { useCallback, useEffect, useState } from "react"
import { KeyRound, UsersRound } from "lucide-react"
import { DeployReminder, GeneralAccessPanel } from "@/components/access-general"
import { PeopleWithAccess, RolesPanel } from "@/components/access-people"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { Banner, EmptyState, ErrorState, Panel, PanelSkeleton } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { SitePage } from "@/components/site"
import { readAccess } from "@/lib/api"
import { ROLE_TEXTS, changeTexts, generalOptions, generalState, readingProblem, refusalText, roleLabel } from "@/lib/access"
import { isPerson, roleOn } from "@/lib/identity"
import { siteUrl } from "@/lib/pages"
import type { AccessPageResponse, Site } from "@/lib/types"

/** The portal's own project, whose Secrets hold portal.env, where company sign-in is set up. */
const PORTAL_SLUG = "portal"

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; page: AccessPageResponse }

/**
 * Who has access, read when the section opens and again with every snapshot:
 * a change made from another tab, or a password access that just expired,
 * must not stay shown as it was. Only the owner and the project's Admins
 * read it; the steward refuses anyone else.
 */
function useAccess(slug: string, enabled: boolean) {
  const { generation, sessionExpired } = useData()
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })

  const reload = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoaded({ state: "loading" })
      const { status, body } = await readAccess(slug)
      if (status === 401) return sessionExpired()
      if (status === 200 && body !== null && Array.isArray(body.entries)) return setLoaded({ state: "ready", page: body })
      const message = status === 502 ? "Can't reach the steward." : refusalText(status, body)
      // A list already shown stays: a refresh that fails says so above it.
      setLoaded((previous) => (previous.state === "ready" && !showLoading ? previous : { state: "failed", message }))
    },
    [slug, sessionExpired],
  )

  useEffect(() => {
    if (enabled) void reload()
  }, [reload, generation, enabled])

  return { loaded, reload }
}

function SecretsLink({ children }: { children: string }) {
  return (
    <InternalLink
      href={siteUrl(PORTAL_SLUG, "secrets")}
      className="rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </InternalLink>
  )
}

function Content({ site }: { site: Site }) {
  const { now, offset, identity } = useData()
  const actions = useSecretsActions()
  const serverNow = now + offset
  const slug = site.slug
  const person = isPerson(identity)
  const role = roleOn(identity, slug)
  const admin = !person || role === "admin"
  const { loaded, reload } = useAccess(slug, admin)
  const page = loaded.state === "ready" ? loaded.page : null

  const state = generalState(site)
  const steward = page?.general ?? null
  const options = generalOptions(state, steward === null ? null : { modifiable: steward.modifiable, reason: steward.reason }, admin)
  const stewardReason = steward !== null && !steward.modifiable && state.current !== "code" && steward.reason !== null ? steward.reason : null
  const problem = page === null ? null : readingProblem(page.portal)
  const changed = actions.accessChanged

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        Who can open {slug}, and what each person can do with it here.
        {admin && " A change holds from their next request."}
      </p>

      {actions.unlockNotice !== null && <Banner tone="error">{actions.unlockNotice}</Banner>}

      {changed !== null && (
        <Banner tone="attention">
          <span className="font-medium">{changeTexts(slug, changed.target).succeeded}.</span> The server has it, but not
          your repository yet.
          <div className="mt-2">
            <DeployReminder slug={slug} />
          </div>
        </Banner>
      )}

      {problem !== null && <Banner tone={problem.tone}>{problem.text}</Banner>}

      {page !== null && !person && !page.signIn.configured && (
        <Banner tone="attention" icon={KeyRound}>
          Company sign-in isn't set up on this server, so everyone you add gets password access, and nobody but you signs
          in to the dashboard. Set <code className="font-mono text-xs">OIDC_ISSUER</code>,{" "}
          <code className="font-mono text-xs">OIDC_CLIENT_ID</code> and <code className="font-mono text-xs">OIDC_CLIENT_SECRET</code>{" "}
          in the portal's <SecretsLink>portal.env</SecretsLink>, then restart it.
        </Banner>
      )}

      <div className="grid items-start gap-6 @4xl/body:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 gap-6">
          <GeneralAccessPanel
            slug={slug}
            state={state}
            options={options}
            readOnlyNote={
              !admin
                ? `Only an Admin of ${slug}, or the owner, changes it.`
                : loaded.state === "failed"
                  ? "Shown as the server last served it: it can't change until the steward answers."
                  : null
            }
            stewardReason={stewardReason}
            onChoose={(target) => actions.changeAccess(slug, target)}
          />

          {!admin ? (
            <Panel title="People with access">
              <EmptyState icon={UsersRound} title={`Only the Admins of ${slug} see this list`}>
                {role === null ? `You have no role on ${slug}.` : `You're a ${roleLabel(role)} here: ${ROLE_TEXTS[role].yours}.`} To add
                someone, ask an Admin of {slug}, or the owner.
              </EmptyState>
            </Panel>
          ) : loaded.state === "loading" ? (
            <PanelSkeleton lines={5} />
          ) : page === null ? (
            <Panel title="People with access">
              <ErrorState title="Can't read who has access" onRetry={() => void reload(true)}>
                {loaded.state === "failed" ? loaded.message : null}
              </ErrorState>
            </Panel>
          ) : (
            <PeopleWithAccess page={page} general={state.current} now={serverNow} onChanged={() => void reload()} />
          )}
        </div>

        <div className="grid min-w-0 gap-6">
          <RolesPanel yours={person ? role : "owner"} />
        </div>
      </div>
    </>
  )
}

/**
 * A site's Access, under `/site/access/?s=<slug>`: its general access, how
 * anyone may open it; then its people with access, each with a role, and the
 * field that adds someone; and what each role can do. The owner and the
 * project's Admins change them, under their unlock for what lets more in;
 * everyone else with a role reads how the site opens and what their own role
 * lets them do.
 */
export function AccessSection({ slug }: { slug: string }) {
  const { identity, secrets } = useData()
  const admin = !isPerson(identity) || roleOn(identity, slug) === "admin"
  // The lock appears once the secrets were read: a steward that does not answer would refuse it.
  const actions = admin && secrets.projects !== null ? <SecretsLockControl quiet /> : undefined
  return (
    <SitePage slug={slug} section="access" actions={actions} skeleton={<PanelSkeleton lines={5} />}>
      {(site) => <Content site={site} />}
    </SitePage>
  )
}
