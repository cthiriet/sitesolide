import { useCallback, useEffect, useState } from "react"
import { KeySquare, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { Banner, EmptyState, ErrorState, PageBody, PageHeader, Panel, PanelSkeleton, Status } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { CreateTokenDialog, RevokeTokenDialog } from "@/components/token-dialogs"
import { readTokens, revokeToken } from "@/lib/api"
import { isPerson } from "@/lib/identity"
import { ago, dateTime } from "@/lib/format"
import { auditLine, deploymentLabel, deploymentTone, isLive, reachedProjects, scopeSummary, tokenStatus } from "@/lib/tokens"
import type { TeamPageResponse, TokenView } from "@/lib/types"

/**
 * The tokens that deploy without SSH, what each may do, and what they did.
 * Machine level, beside People.
 *
 * The page reads `/api/tokens` itself: the tokens are the steward's, and change
 * only through this page. Creating one needs the dashboard unlocked, the
 * header's lock, the same one as the Secrets section; revoking does not, so
 * that a stolen token is closed without looking for a password first.
 *
 * The owner sees every token, a person's own marked with whose it is. A
 * person sees their own alone, mints them under their own unlock, a forced
 * sign-in at their provider, and never beyond their roles.
 */

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; list: TeamPageResponse }

function TokenRow({ token, now, mine, onRevoke }: { token: TokenView; now: number; mine: boolean; onRevoke: (token: TokenView) => void }) {
  const status = tokenStatus(token, now)
  const projects = reachedProjects(token)
  const live = isLive(token, now)
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-medium wrap-anywhere">{token.label}</span>
          {!mine && <span className="text-muted-foreground wrap-anywhere">{token.email}</span>}
          <Status tone={status.tone}>{status.label}</Status>
          {!mine && token.member !== null && <Status tone="neutral">Their own</Status>}
        </div>
        <p className="text-xs text-muted-foreground">{scopeSummary(token.scope, token.member !== null).join(" · ")}</p>
        <p className="text-xs text-muted-foreground">
          {projects.length === 0
            ? "No project yet."
            : projects.map(({ slug, how }, index) => (
                <span key={slug}>
                  {index > 0 && ", "}
                  <span className="text-foreground">{slug}</span>
                  {how === "created" ? " (created)" : ""}
                </span>
              ))}
        </p>
      </div>
      {/* On a phone, one line under the token; on a computer, a column at the right. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums max-md:basis-full md:grid md:justify-items-end">
        <span>created {ago(now - token.createdAt)}</span>
        <span>{token.lastUsedAt === null ? "never used" : `used ${ago(now - token.lastUsedAt)}`}</span>
        {token.expiresAt !== null && live && <span>until {dateTime(token.expiresAt)}</span>}
      </div>
      {live && (
        <Button variant="outline" size="sm" onClick={() => onRevoke(token)} className="max-md:h-10">
          Revoke
        </Button>
      )}
    </li>
  )
}

export function TokensPage() {
  const { now, offset, snapshot, sessionExpired, identity } = useData()
  const signedPerson = isPerson(identity)
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const serverNow = now + offset
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [creating, setCreating] = useState<{ open: boolean; opening: number }>({ open: false, opening: 0 })
  const [revoking, setRevoking] = useState<{ token: TokenView | null; open: boolean; inProgress: boolean; error: string }>({
    token: null,
    open: false,
    inProgress: false,
    error: "",
  })

  const reload = useCallback(async () => {
    const { status, body } = await readTokens()
    if (status === 401) return sessionExpired()
    if (status !== 200 || body === null || !Array.isArray(body.tokens)) {
      setLoaded((previous) => (previous.state === "ready" ? previous : { state: "failed" }))
      return
    }
    setLoaded({ state: "ready", list: body })
  }, [sessionExpired])

  useEffect(() => {
    void reload()
  }, [reload])

  function openCreation() {
    // The unlock first, as for a secret: the dialog would only end in a 423.
    if (!actions.state.open) return actions.unlock()
    setCreating((previous) => ({ open: true, opening: previous.opening + 1 }))
  }

  async function revoke() {
    const token = revoking.token
    if (token === null) return
    setRevoking((previous) => ({ ...previous, inProgress: true, error: "" }))
    const { status, body } = await revokeToken(token.id)
    if (status === 401) {
      setRevoking((previous) => ({ ...previous, open: false, inProgress: false }))
      return sessionExpired()
    }
    if (status !== 200) {
      setRevoking((previous) => ({ ...previous, inProgress: false, error: body?.message ?? `Refused (${status}).` }))
      return
    }
    setRevoking((previous) => ({ ...previous, open: false, inProgress: false }))
    announce(`Token of ${token.label} revoked.`)
    void reload()
  }

  const knownSlugs = snapshot?.sites.map((site) => site.slug) ?? []
  const list = loaded.state === "ready" ? loaded.list : null
  const live = list?.tokens.filter((token) => isLive(token, serverNow)).length ?? 0
  const person = list?.member ?? null

  return (
    <>
      <PageHeader title="Tokens" actions={<SecretsLockControl quiet />} />
      <PageBody>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          {signedPerson
            ? "Your tokens let your CLI or an agent deploy over HTTPS with sitesolide deploy, without SSH. A token deploys only projects where you are a Developer or an Admin, creates projects only if you may, and never does more than your roles do now."
            : "A token lets someone, or an agent, deploy over HTTPS with sitesolide deploy, without SSH and without root. Each one deploys only the projects you grant it and the ones it creates, restricted unless you allow public sites. People with a role create their own, never beyond their roles."}
        </p>

        {loaded.state === "loading" && <PanelSkeleton lines={4} />}
        {loaded.state === "failed" && (
          <Panel title="Tokens">
            <ErrorState title="Can't read the tokens" onRetry={() => void reload()}>
              The dashboard did not answer, or the steward did not.
            </ErrorState>
          </Panel>
        )}

        {list !== null && !list.available && <Banner tone="attention">{list.reason}</Banner>}

        {list !== null && list.available && (
          <Panel
            title="Tokens"
            count={live}
            full
            actions={
              <Button size="sm" onClick={openCreation} className="max-md:h-10">
                <Plus />
                {actions.state.open ? "New token" : "Unlock to create"}
              </Button>
            }
          >
            {list.tokens.length === 0 ? (
              <EmptyState icon={KeySquare} title="No token yet">
                {person === null
                  ? "Create one per person or agent. The token is shown once; its holder signs in with sitesolide login."
                  : "Create one per workstation or agent. The token is shown once; sign in with sitesolide login."}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-divider">
                {list.tokens.map((token) => (
                  <TokenRow
                    key={token.id}
                    token={token}
                    now={serverNow}
                    mine={person !== null}
                    onRevoke={(chosen) => setRevoking({ token: chosen, open: true, inProgress: false, error: "" })}
                  />
                ))}
              </ul>
            )}
          </Panel>
        )}

        {list !== null && (
          <div className="grid gap-6 @4xl/body:grid-cols-2">
            <Panel title="Recent deployments" count={list.deployments.length} full>
              {list.deployments.length === 0 ? (
                <EmptyState compact title="No deployment by token yet" />
              ) : (
                <ul className="divide-y divide-divider">
                  {list.deployments.map((deployment) => (
                    <li key={deployment.id} className="grid gap-0.5 px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-2.5">
                        <span className="font-medium">{deployment.slug}</span>
                        <Status tone={deploymentTone(deployment.state)}>{deploymentLabel(deployment.state)}</Status>
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{ago(serverNow - deployment.createdAt)}</span>
                      </div>
                      <span className="text-xs text-muted-foreground wrap-anywhere">
                        {deployment.email}
                        {deployment.state === "failed" && deployment.message !== null ? `: ${deployment.message}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Activity" full>
              {list.audit.length === 0 ? (
                <EmptyState compact title="Nothing yet" />
              ) : (
                <ul className="divide-y divide-divider">
                  {list.audit.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5">
                      <span className="min-w-0 flex-1 wrap-anywhere">{auditLine(entry)}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{ago(serverNow - Date.parse(entry.at))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </PageBody>

      <CreateTokenDialog
        key={creating.opening}
        open={creating.open}
        origin={window.location.origin}
        knownSlugs={knownSlugs}
        person={person === null ? null : { roles: person.roles, create: person.create }}
        now={serverNow}
        onClose={() => setCreating((previous) => ({ ...previous, open: false }))}
        onCreated={() => void reload()}
        onLocked={() => actions.unlock()}
        onSessionExpired={sessionExpired}
      />
      <RevokeTokenDialog
        token={revoking.token}
        open={revoking.open}
        inProgress={revoking.inProgress}
        error={revoking.error}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking((previous) => ({ ...previous, open: false }))}
      />
    </>
  )
}
