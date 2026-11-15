import { useCallback, useEffect, useState } from "react"
import { GeneralAccessLine, GeneralAccessPanel } from "@/components/access-general"
import { Guests } from "@/components/access-guests"
import { useData } from "@/components/data"
import { Banner, ErrorState, Panel, PanelSkeleton } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { SitePage } from "@/components/site"
import { readAccess } from "@/lib/api"
import {
  ACCESS_UNREACHABLE,
  emptyListWarning,
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
} from "@/lib/access"
import type { AccessPageResponse, Site } from "@/lib/types"

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; page: AccessPageResponse }

/**
 * The guests, read when the section opens and again with every snapshot: a
 * change made from another tab, or a password access that just expired, must
 * not stay shown as it was.
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
 * A project of the platform, the portal, the dashboard, the landing: it
 * takes no guest, so its Access says how it opens, and why there is nobody
 * to add.
 */
function PlatformContent({ site }: { site: Site }) {
  return (
    <Panel title="General access" full>
      <GeneralAccessLine slug={site.slug} state={generalState(site)} note={platformText(site.slug)} />
    </Panel>
  )
}

function Content({ site }: { site: Site }) {
  const { now, offset, snapshot } = useData()
  const actions = useSecretsActions()
  const serverNow = now + offset
  const slug = site.slug
  const platform = isPlatform(slug, snapshot?.zone ?? null)
  const { loaded, reload } = useAccess(slug, !platform)
  const page = loaded.state === "ready" ? loaded.page : null

  if (platform) return <PlatformContent site={site} />

  const state = generalState(site)
  const addresses = siteAddresses(site)
  const steward = stewardChoices(page?.general ?? null)
  const options = generalOptions(state, steward)
  const stewardReason = sharedReason(state, steward)
  const problem = page === null ? null : readingProblem(page.portal)

  return (
    <>
      {problem !== null && <Banner tone={problem.tone}>{problem.text}</Banner>}

      <GeneralAccessPanel
        slug={slug}
        state={state}
        options={options}
        renewable={mayRenew(state, steward)}
        stewardReason={stewardReason}
        failedNote={loaded.state === "failed" ? "Shown as last read: it can't change until the server answers." : null}
        addresses={addresses}
        locked={!actions.state.open}
        onChoose={(target) =>
          actions.changeAccess(
            slug,
            target,
            state.current,
            target === "restricted" && page !== null ? emptyListWarning(slug, page.entries.length) : null,
            addresses,
          )
        }
      />

      {loaded.state === "loading" ? (
        <PanelSkeleton lines={5} />
      ) : page === null ? (
        <Panel title="Guests">
          <ErrorState title="Can't read the guests" onRetry={() => void reload(true)}>
            {loaded.state === "failed" ? loaded.message : null}
          </ErrorState>
        </Panel>
      ) : (
        <Guests page={page} general={state.current} now={serverNow} onChanged={() => void reload()} />
      )}
    </>
  )
}

/**
 * A site's Access, under `/site/access/?s=<slug>`: its general access, how
 * anyone may open it; then its guests, each with a password of their own,
 * and the field that gives one. What lets more in waits for the unlock,
 * asked for when pressed. Its changes are in Activity, behind the header's
 * History.
 */
export function AccessSection({ slug }: { slug: string }) {
  const { snapshot } = useData()
  const platform = isPlatform(slug, snapshot?.zone ?? null)
  return (
    <SitePage
      slug={slug}
      section="access"
      intro={<p>Who can open {slug}: everyone, whoever has its preview code, or only you and the guests you give a password.</p>}
      history={platform ? undefined : { target: slug, type: "access" }}
      skeleton={<PanelSkeleton lines={5} />}
    >
      {(site) => <Content site={site} />}
    </SitePage>
  )
}
