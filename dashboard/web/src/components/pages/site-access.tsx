import { useCallback, useEffect, useState } from "react"
import { KeyRound } from "lucide-react"
import { GeneralAccessPanel } from "@/components/access-general"
import { PeopleWithAccess } from "@/components/access-people"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { Banner, ErrorState, Panel, PanelSkeleton } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { SitePage } from "@/components/site"
import { readAccess } from "@/lib/api"
import {
  ACCESS_UNREACHABLE,
  emptyListWarning,
  generalLine,
  generalOptions,
  generalState,
  isPlatform,
  mayRenew,
  platformText,
  readingProblem,
  refusalText,
  sharedReason,
  siteAddresses,
  stewardChoices,
  type GeneralReader,
} from "@/lib/access"
import { activityUrl } from "@/lib/audit"
import { isPerson, roleOn } from "@/lib/identity"
import { siteUrl } from "@/lib/pages"
import type { AccessPageResponse, Site } from "@/lib/types"

/** The portal's own project, whose Secrets hold portal.env, where company sign-in is set up. */
const PORTAL_SLUG = "portal"

const LINK =
  "rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; page: AccessPageResponse }

/**
 * Who has access, read when the section opens and again with every snapshot:
 * a change made from another tab, or a password access that just expired,
 * must not stay shown as it was. The owner and everyone with a role from
 * Viewer up read it; only the owner and the project's Admins change it.
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
      const message = status === 502 ? ACCESS_UNREACHABLE : refusalText(status, body)
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

/**
 * A project of the platform, the portal, the dashboard, the landing: nobody
 * is given a role on it, so its Access says how it opens, and why there is
 * nobody to add.
 */
function PlatformContent({ site }: { site: Site }) {
  return (
    <Panel title="General access">
      <div className="grid gap-1.5">
        <p className="text-pretty">{generalLine(generalState(site), site.slug, true)}</p>
        <p className="text-pretty text-muted-foreground">{platformText(site.slug)}</p>
      </div>
    </Panel>
  )
}

function Content({ site }: { site: Site }) {
  const { now, offset, identity, snapshot } = useData()
  const actions = useSecretsActions()
  const serverNow = now + offset
  const slug = site.slug
  const person = isPerson(identity)
  const role = roleOn(identity, slug)
  const admin = !person || role === "admin"
  const reader: GeneralReader = !person ? "owner" : admin ? "admin" : "reader"
  const platform = isPlatform(slug, snapshot?.zone ?? null)
  const { loaded, reload } = useAccess(slug, !platform)
  const page = loaded.state === "ready" ? loaded.page : null

  if (platform) return <PlatformContent site={site} />

  const state = generalState(site)
  const addresses = siteAddresses(site)
  const steward = stewardChoices(page?.general ?? null)
  const options = generalOptions(state, steward, admin)
  const stewardReason = admin ? sharedReason(state, steward) : null
  const problem = page === null ? null : readingProblem(page.portal)

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        Who can open {slug}, and what each person can do with it here. Changes apply from each person's next visit.{" "}
        <InternalLink href={activityUrl({ action: "access", target: slug })} className={LINK}>
          See changes in Activity
        </InternalLink>
      </p>

      {actions.unlockNotice !== null && <Banner tone="error">{actions.unlockNotice}</Banner>}

      {problem !== null && <Banner tone={problem.tone}>{problem.text}</Banner>}

      {page !== null && !person && !page.signIn.configured && (
        <Banner tone="attention" icon={KeyRound}>
          Company sign-in isn't set up on this server, so everyone you add gets password access, and nobody but you signs
          in to the dashboard. Set <code className="font-mono text-xs">OIDC_ISSUER</code>,{" "}
          <code className="font-mono text-xs">OIDC_CLIENT_ID</code> and <code className="font-mono text-xs">OIDC_CLIENT_SECRET</code>{" "}
          in the portal's{" "}
          <InternalLink href={siteUrl(PORTAL_SLUG, "secrets")} className={LINK}>
            portal.env
          </InternalLink>
          , then restart it.
        </Banner>
      )}

      <GeneralAccessPanel
        slug={slug}
        state={state}
        options={options}
        reader={reader}
        renewable={mayRenew(state, steward, admin)}
        stewardReason={stewardReason}
        failedNote={admin && loaded.state === "failed" ? "Shown as last read: it can't change until the server answers." : null}
        addresses={addresses}
        onChoose={(target) =>
          actions.changeAccess(
            slug,
            target,
            state.current,
            target === "restricted" && page !== null ? emptyListWarning(slug, page.entries.length, page.signIn.admins) : null,
            addresses,
          )
        }
      />

      {loaded.state === "loading" ? (
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
    </>
  )
}

/**
 * A site's Access, under `/site/access/?s=<slug>`: its general access, how
 * anyone may open it; then its people with access, each with a role, and the
 * field that adds someone. The owner and the project's Admins change them,
 * under their unlock for what lets more in; a Viewer or a Developer reads
 * both, and whom to ask.
 */
export function AccessSection({ slug }: { slug: string }) {
  const { identity, secrets, snapshot } = useData()
  const admin = !isPerson(identity) || roleOn(identity, slug) === "admin"
  const platform = isPlatform(slug, snapshot?.zone ?? null)
  // The lock appears once the secrets were read: a steward that does not answer would refuse it.
  const actions = admin && !platform && secrets.projects !== null ? <SecretsLockControl quiet /> : undefined
  return (
    <SitePage slug={slug} section="access" actions={actions} skeleton={<PanelSkeleton lines={5} />}>
      {(site) => <Content site={site} />}
    </SitePage>
  )
}
