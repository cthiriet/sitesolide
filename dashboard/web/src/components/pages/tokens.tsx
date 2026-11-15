import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, History, KeySquare, Plus, SearchX, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { CHIP } from "@/components/access-word"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { DataTable, RowButton, RowMenu, RowMenuLink, type Column } from "@/components/data-table"
import { DetailSheet, SheetFacts, SheetRecent, SheetSection, useSheet, type Fact } from "@/components/detail-sheet"
import { FilterBar, useListState } from "@/components/filter-bar"
import { ProjectLink } from "@/components/project-link"
import { Banner, Count, ErrorState, InlineEmpty, PageBody, PageHeader, Panel, PanelSkeleton, StateLabel } from "@/components/page"
import { WriteButton, WriteMenuItem } from "@/components/unlock"
import { useSecretsActions } from "@/components/secrets-actions"
import { CreateTokenDialog, RevokeTokenDialog } from "@/components/token-dialogs"
import { readTokens, revokeToken } from "@/lib/api"
import { ago, dateTime, fromNow } from "@/lib/format"
import { historyUrl } from "@/lib/history"
import { FILTER_BAR_FROM, type ListSpec } from "@/lib/list-state"
import {
  PERMISSION_WORDS,
  expiryCell,
  foldLabel,
  isLive,
  lastUsed,
  liveReach,
  madeFor,
  permissionChips,
  projectChips,
  splitTokens,
  tokenMatches,
  tokenPermissions,
  tokenProjects,
  tokenStatus,
  type PermissionKey,
  type Reach,
} from "@/lib/tokens"
import type { TeamPageResponse, TokenView } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The tokens that deploy without SSH: one line each, OpenRouter's keys
 * table, its details in a sheet. Machine level.
 *
 * The page reads `/api/tokens` itself: the tokens are the steward's, and change
 * only through this page. Creating one asks for the unlock when *New token*
 * is pressed; revoking does not, so that a stolen token is closed without
 * looking for a password first.
 *
 * Every token is the owner's, for themselves and their agents. A token
 * deploys; it never gives anyone access to a site.
 *
 * What tokens did is in Activity: the header's *History*, and each token's
 * sheet, its last ten actions. Revoked and expired tokens fold under the
 * list, history rather than something to act on.
 */

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; list: TeamPageResponse }

/** The list's address: a search, from ten tokens. */
const SPEC: ListSpec = {}

/** A permission's chip: its short word, its sentence on hover. */
function PermissionChip({ permission, ended }: { permission: PermissionKey; ended: boolean }) {
  const words = PERMISSION_WORDS[permission]
  return (
    <span title={words.title} className={cn(CHIP, "font-normal", ended ? "text-muted-foreground" : "text-secondary-foreground")}>
      {words.chip}
    </span>
  )
}

/** The "+2" of what a cell does not show, every one of them in its tooltip. */
function More({ count, title }: { count: number; title: string }) {
  if (count === 0) return null
  return (
    <span title={title} className="shrink-0">
      <Count className="h-[1.125rem] px-1 text-[0.6875rem]">+{count}</Count>
      <span className="sr-only">: {title}</span>
    </span>
  )
}

const reachText = (reach: readonly Reach[]) => reach.map(({ slug, detail }) => (detail === null ? slug : `${slug} (${detail})`)).join(", ")

/** A revoked or expired token's cells are history: muted, whatever they say. */
function ProjectsCell({ reach, ended }: { reach: readonly Reach[]; ended: boolean }) {
  if (reach.length === 0) return <span className="text-muted-foreground">No project yet</span>
  const { shown, more } = projectChips(reach)
  return (
    <span title={reachText(reach)} className={cn("flex min-w-0 items-center gap-1.5", ended && "text-muted-foreground")}>
      <span className="flex min-w-0 items-center truncate">
        {shown.map((one, index) => (
          <span key={one.slug} className="inline-flex min-w-0 items-center gap-1">
            {index > 0 && <span className="text-muted-foreground">,&nbsp;</span>}
            <ProjectLink slug={one.slug} />
          </span>
        ))}
      </span>
      <More count={more} title={reachText(reach)} />
    </span>
  )
}

function PermissionsCell({ permissions, ended }: { permissions: readonly PermissionKey[]; ended: boolean }) {
  // Nothing beyond deploying is every token's default: quiet.
  if (permissions.length === 0) return <span className="sr-only">None</span>
  const { shown, more } = permissionChips(permissions)
  const all = permissions.map((key) => PERMISSION_WORDS[key].title).join(", ")
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {shown.map((one) => (
        <PermissionChip key={one} permission={one} ended={ended} />
      ))}
      <More count={more} title={all} />
    </span>
  )
}

const EXPIRY_TONE = { plain: "text-foreground", muted: "text-muted-foreground", attention: "font-medium text-attention-text" } as const

function columns({ now, open }: { now: number; open: (token: TokenView) => void }): Column<TokenView>[] {
  return [
    {
      key: "name",
      head: "Name",
      width: "minmax(150px,1.2fr)",
      slot: "primary",
      cell: (token) => {
        const live = isLive(token, now)
        return (
          <RowButton onClick={() => open(token)} className={cn(!live && "font-normal text-muted-foreground")}>
            {token.label}
          </RowButton>
        )
      },
    },
    {
      key: "projects",
      head: "Projects",
      width: "minmax(130px,1fr)",
      slot: "meta",
      cell: (token) => <ProjectsCell reach={liveReach(token)} ended={!isLive(token, now)} />,
    },
    {
      key: "permissions",
      head: "Permissions",
      width: "minmax(190px,1.1fr)",
      slot: "hide",
      cell: (token) => <PermissionsCell permissions={tokenPermissions(token)} ended={!isLive(token, now)} />,
    },
    {
      key: "used",
      head: "Last used",
      width: "100px",
      align: "end",
      slot: "hide",
      cell: (token) => (
        <span title={token.lastUsedAt === null ? undefined : dateTime(token.lastUsedAt)} className="whitespace-nowrap text-muted-foreground">
          {lastUsed(token, now)}
        </span>
      ),
    },
    {
      key: "expires",
      head: "Expires",
      width: "104px",
      align: "end",
      slot: "state",
      cell: (token) => {
        const expiry = expiryCell(token, now)
        return (
          <span title={expiry.title ?? undefined} className={cn("whitespace-nowrap", EXPIRY_TONE[expiry.tone])}>
            {expiry.text}
          </span>
        )
      },
    },
  ]
}

/** A token's sheet: its dates, each project and permission explained, its last actions. */
function TokenSheet({
  token,
  now,
  onClose,
  onRevoke,
}: {
  token: TokenView | null
  now: number
  onClose: () => void
  onRevoke: (token: TokenView) => void
}) {
  const status = token === null ? null : tokenStatus(token, now)
  return (
    <DetailSheet
      open={token !== null}
      onClose={onClose}
      title={token?.label ?? ""}
      state={status === null ? undefined : <StateLabel tone={status.tone}>{status.label}</StateLabel>}
    >
      {token !== null && <TokenDetails token={token} now={now} onRevoke={onRevoke} />}
    </DetailSheet>
  )
}

function TokenDetails({ token, now, onRevoke }: { token: TokenView; now: number; onRevoke: (token: TokenView) => void }) {
  const reach = liveReach(token)
  const permissions = tokenPermissions(token)
  const made = madeFor(token)
  const live = isLive(token, now)
  const when = (at: number) => (
    <>
      {dateTime(at)} <span className="text-muted-foreground">({at > now ? fromNow(at - now) : ago(now - at)})</span>
    </>
  )
  const facts: Fact[] = [
    ...(made === null ? [] : [{ label: "Made for", value: made }]),
    { label: "Created", value: when(token.createdAt) },
    { label: "Last used", value: token.lastUsedAt === null ? "Never" : when(token.lastUsedAt) },
    token.revokedAt !== null
      ? { label: "Revoked", value: when(token.revokedAt) }
      : { label: "Expires", value: token.expiresAt === null ? "No expiry" : when(token.expiresAt) },
  ]
  return (
    <>
      <SheetFacts facts={facts} />

      <SheetSection title="Projects it may deploy">
        {reach.length === 0 ? (
          <p className="text-muted-foreground">No project yet.</p>
        ) : (
          <ul className="divide-y divide-divider">
            {reach.map(({ slug, detail }) => (
              <li key={slug} className="flex min-h-9 items-center justify-between gap-3 py-1.5">
                <ProjectLink slug={slug} />
                {detail === "created" && <span className="shrink-0 text-xs text-secondary-foreground">Created by it</span>}
              </li>
            ))}
          </ul>
        )}
      </SheetSection>

      <SheetSection title="Permissions">
        {permissions.length === 0 ? (
          <p className="text-muted-foreground">None beyond deploying its projects.</p>
        ) : (
          <ul className="grid gap-3">
            {permissions.map((key) => {
              const words = PERMISSION_WORDS[key]
              return (
                <li key={key} className="grid gap-0.5">
                  <span className="font-medium">{words.title}</span>
                  <span className="text-xs text-pretty text-muted-foreground">{words.sentence}</span>
                </li>
              )
            })}
          </ul>
        )}
      </SheetSection>

      {/* Every line is this token's: under each, the site it touched rather than its name again. */}
      <SheetRecent filter={{ actor: `token:${token.id}` }} meta={(row) => row.site ?? row.target} />

      {live && (
        <div className="grid justify-items-start gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => onRevoke(token)} className="text-destructive hover:text-destructive max-md:h-10">
            <Trash2 />
            Revoke token
          </Button>
          <p className="text-xs text-muted-foreground">Needs no unlock, so that a token that leaked is closed at once.</p>
        </div>
      )}
    </>
  )
}

export function TokensPage() {
  const { now, offset, snapshot, sessionExpired } = useData()
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const serverNow = now + offset
  const sheet = useSheet("token")
  const search = useListState(SPEC)
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [creating, setCreating] = useState<{ open: boolean; opening: number }>({ open: false, opening: 0 })
  const [showEnded, setShowEnded] = useState(false)
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

  /** Unlocked by then: `WriteButton` asked first, the dialog would only end in a 423. */
  function openCreation() {
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
    announce(`${token.label} revoked.`)
    void reload()
  }

  const askRevoke = (token: TokenView) => setRevoking({ token, open: true, inProgress: false, error: "" })

  const projects = tokenProjects(snapshot?.sites ?? [], snapshot?.zone ?? null)
  const list = loaded.state === "ready" ? loaded.list : null

  const tokens = list?.tokens ?? []
  const { live, ended } = splitTokens(tokens, serverNow)
  const filterable = tokens.length >= FILTER_BAR_FROM
  const query = filterable ? search.query.trim() : ""
  const matching = (token: TokenView) => query === "" || tokenMatches(token, query)
  const liveShown = live.filter(matching)
  const endedShown = ended.filter(matching)
  const rows = showEnded ? [...liveShown, ...endedShown] : liveShown
  const opened = sheet.id === null ? null : (tokens.find((token) => token.id === sheet.id) ?? null)

  const newToken = (props: { variant?: "default" | "link"; className?: string; children: ReactNode }) => (
    <WriteButton
      variant={props.variant}
      onPress={openCreation}
      purpose="create a token"
     
      className={props.className}
    >
      {props.children}
    </WriteButton>
  )

  const empty =
    query !== "" ? (
      <InlineEmpty
        icon={SearchX}
        action={
          <Button variant="link" className="h-auto p-0" onClick={search.clear}>
            Clear search
          </Button>
        }
      >
        No tokens match "{query}".
      </InlineEmpty>
    ) : (
      <InlineEmpty icon={KeySquare} action={newToken({ variant: "link", className: "h-auto p-0", children: "New token" })}>
        {ended.length > 0 ? "No token can deploy right now." : "No token yet. Create one per workstation or agent."}
      </InlineEmpty>
    )

  return (
    <>
      <PageHeader
        title="Tokens"
        count={list?.available === true ? live.length : undefined}
        intro={
          <>
            <p>
              A token lets your CLI or an agent run sitesolide deploy without SSH, on every project or the ones you choose. It never
              gives anyone access to a site.
            </p>
            <p className="text-muted-foreground">What tokens did is in Activity, under History; each token's sheet holds its last actions.</p>
          </>
        }
        actions={
          list?.available === true
            ? newToken({
                className: "max-md:h-10",
                children: (
                  <>
                    <Plus />
                    New token
                  </>
                ),
              })
            : undefined
        }
        history={{ actor: "token:" }}
      />
      <PageBody>
        {loaded.state === "loading" && <PanelSkeleton lines={4} title={false} />}
        {loaded.state === "failed" && (
          <Panel>
            <ErrorState title="Can't read the tokens" onRetry={() => void reload()}>
              The dashboard did not answer, or the service behind it did not. Retry in a moment; if it persists, run sitesolide status.
            </ErrorState>
          </Panel>
        )}

        {list !== null && !list.available && <Banner tone="attention">{list.reason}</Banner>}

        {list !== null && list.available && (
          <div className="grid gap-3">
            {filterable && (
              <FilterBar
                list={search}
                shown={liveShown.length}
                total={live.length}
                noun={{ one: "token", many: "tokens" }}
                search={{ label: "Search tokens" }}
              />
            )}
            <Panel full>
              <DataTable
                label="Tokens"
                caption={showEnded ? "Newest first, then the revoked and expired" : "Newest first; revoked and expired folded below"}
                rows={rows}
                rowKey={(token) => token.id}
                columns={columns({ now: serverNow, open: (token) => sheet.open(token.id) })}
                narrowBelow="48rem"
                onRowClick={(token) => sheet.open(token.id)}
                selected={sheet.id}
                menu={(token) => (
                  <RowMenu label={`Actions for ${token.label}`}>
                    <RowMenuLink href={historyUrl({ actor: `token:${token.id}` })}>
                      <History />
                      View activity
                    </RowMenuLink>
                    {isLive(token, serverNow) && (
                      <>
                        <DropdownMenuSeparator />
                        <WriteMenuItem variant="destructive" unlock={false} onPress={() => askRevoke(token)}>
                          <Trash2 />
                          Revoke token
                        </WriteMenuItem>
                      </>
                    )}
                  </RowMenu>
                )}
                empty={empty}
                foot={
                  endedShown.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={showEnded}
                      onClick={() => setShowEnded((open) => !open)}
                      className="-ml-2 text-muted-foreground hover:text-foreground max-md:h-9"
                    >
                      {showEnded ? <ChevronUp /> : <ChevronDown />}
                      {foldLabel(endedShown.length, showEnded)}
                    </Button>
                  ) : undefined
                }
              />
            </Panel>
          </div>
        )}
      </PageBody>

      <TokenSheet
        token={opened}
        now={serverNow}
        onClose={sheet.close}
        onRevoke={askRevoke}
      />
      <CreateTokenDialog
        key={creating.opening}
        open={creating.open}
        origin={window.location.origin}
        projects={projects}
        now={serverNow}
        onClose={() => setCreating((previous) => ({ ...previous, open: false }))}
        onCreated={() => void reload()}
        onLocked={() => actions.unlock({ purpose: "create a token" })}
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
