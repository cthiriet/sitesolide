import { useCallback, useEffect, useState } from "react"
import { KeySquare, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { Who } from "@/components/access-word"
import { InternalLink } from "@/components/navigation"
import { Banner, EmptyState, ErrorState, PageBody, PageHeader, Panel, PanelSkeleton, Status } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { CreateTokenDialog, RevokeTokenDialog } from "@/components/token-dialogs"
import { readPeople, readTokens, revokeToken } from "@/lib/api"
import { isPerson } from "@/lib/identity"
import { ago, dateTime } from "@/lib/format"
import { auditLine, deploymentLabel, deploymentTone, isLive, liveReach, madeByLine, scopeLines, tokenHolders, tokenStatus } from "@/lib/tokens"
import type { AccessRole, Roles, TeamPageResponse, TokenView } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The tokens that deploy without SSH, what each may do, and what they did.
 * Machine level, beside People.
 *
 * The page reads `/api/tokens` itself: the tokens are the steward's, and change
 * only through this page. Creating one needs the dashboard unlocked, the
 * header's lock, the same one as the Secrets section; revoking does not, so
 * that a stolen token is closed without looking for a password first.
 *
 * The owner sees every token, each with whose it is and who made it, and
 * makes one for themselves or for a person of People. A person sees theirs
 * alone, those the owner made for them included, mints them under their own
 * unlock, a forced sign-in at their provider, and never beyond their roles.
 */

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; list: TeamPageResponse }

const LINK =
  "rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"

/**
 * A token: its label, who made it and for whom, its state; what it may do
 * beyond deploying, only what is on; and where it deploys, a person's with
 * their role there today, paused below Developer.
 */
function TokenRow({
  token,
  now,
  mine,
  rights,
  onRevoke,
}: {
  token: TokenView
  now: number
  mine: boolean
  /** The rights of the person the token belongs to, as they are now; null when not known. */
  rights: { roles: Readonly<Record<string, AccessRole>>; create: boolean } | null
  onRevoke: (token: TokenView) => void
}) {
  const status = tokenStatus(token, now)
  const reach = liveReach(token, rights?.roles ?? null)
  const scope = scopeLines(token, rights)
  const live = isLive(token, now)
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-medium wrap-anywhere">{token.label}</span>
          <Status tone={status.tone}>{status.label}</Status>
        </div>
        <p className="text-xs text-muted-foreground wrap-break-word">
          <Who value={madeByLine(token, mine ? "person" : "owner")} />
        </p>
        {scope.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {scope.map(({ text, paused }, index) => (
              <span key={text}>
                {index > 0 && " · "}
                <span className={cn(paused ? "text-muted-foreground" : "text-foreground")}>{text}</span>
              </span>
            ))}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {reach.length === 0
            ? "No project yet."
            : reach.map(({ slug, text, paused }, index) => (
                <span key={slug}>
                  {index > 0 && ", "}
                  <span className={cn(paused ? "text-muted-foreground" : "text-foreground")}>{text}</span>
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
  const [holders, setHolders] = useState<{ email: string; roles: Roles; create: boolean }[]>([])
  // Every person's rights now, for the owner: where each person's token deploys today, and what it may still do.
  const [people, setPeople] = useState<ReadonlyMap<string, { roles: Readonly<Record<string, AccessRole>>; create: boolean }>>(new Map())
  const [creating, setCreating] = useState<{ open: boolean; opening: number }>({ open: false, opening: 0 })
  const [revoking, setRevoking] = useState<{ token: TokenView | null; open: boolean; inProgress: boolean; error: string }>({
    token: null,
    open: false,
    inProgress: false,
    error: "",
  })

  /** The owner's People: whom a token may be made for, and everyone's roles now. */
  const readHolders = useCallback(async () => {
    const { status, body } = await readPeople()
    if (status === 401) return sessionExpired()
    if (status !== 200 || body === null || !Array.isArray(body.people)) return
    setHolders(tokenHolders(body.people))
    setPeople(new Map(body.people.map((one) => [one.who, { roles: one.roles, create: one.create }])))
  }, [sessionExpired])

  const reload = useCallback(async () => {
    const { status, body } = await readTokens()
    if (status === 401) return sessionExpired()
    if (status !== 200 || body === null || !Array.isArray(body.tokens)) {
      setLoaded((previous) => (previous.state === "ready" ? previous : { state: "failed" }))
      return
    }
    setLoaded({ state: "ready", list: body })
    if (body.member === null) void readHolders()
  }, [sessionExpired, readHolders])

  useEffect(() => {
    void reload()
  }, [reload])

  async function openCreation() {
    // The unlock first, as for a secret: the dialog would only end in a 423.
    if (!actions.state.open) return actions.unlock()
    // The owner may make a token for a person of People: who they are, and their roles now.
    if (!signedPerson) await readHolders()
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
  const person = list?.member ?? null
  const rightsOf = (token: TokenView): { roles: Readonly<Record<string, AccessRole>>; create: boolean } | null =>
    token.member === null ? null : person !== null ? { roles: person.roles, create: person.create } : (people.get(token.member) ?? null)

  return (
    <>
      <PageHeader title="Tokens" actions={<SecretsLockControl quiet />} />
      <PageBody>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          {signedPerson
            ? "Your tokens let your CLI or an agent deploy with sitesolide deploy, without SSH. A token never does more than your roles do now: below Developer on a project, it is paused there."
            : "A token lets your agents, or a person, deploy with sitesolide deploy, without SSH. Every token is someone's: yours deploys what you allow it; a person's never does more than their roles, and goes with them."}
        </p>

        {loaded.state === "loading" && <PanelSkeleton lines={4} />}
        {loaded.state === "failed" && (
          <Panel title="Tokens">
            <ErrorState title="Can't read the tokens" onRetry={() => void reload()}>
              The dashboard did not answer, or the service behind it did not. Retry in a moment; if it persists, run sitesolide status.
            </ErrorState>
          </Panel>
        )}

        {list !== null && !list.available && <Banner tone="attention">{list.reason}</Banner>}

        {list !== null && list.available && (
          <Panel
            title="Tokens"
            count={list.tokens.length}
            full
            actions={
              <Button size="sm" onClick={() => void openCreation()} className="max-md:h-10">
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
                    rights={rightsOf(token)}
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
            <Panel
              title="Token activity"
              full
              actions={
                <InternalLink href="/activity/" className={cn(LINK, "text-xs text-muted-foreground hover:text-foreground")}>
                  All activity
                </InternalLink>
              }
            >
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
        holders={holders}
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
