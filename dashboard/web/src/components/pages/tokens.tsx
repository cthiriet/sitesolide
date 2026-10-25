import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, History, KeySquare, Pause, Plus, SearchX, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { CHIP } from "@/components/access-word"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { CellText, DataTable, RowButton, RowMenu, RowMenuLink, type Column } from "@/components/data-table"
import { DetailSheet, SheetFacts, SheetRecent, SheetSection, useSheet, type Fact } from "@/components/detail-sheet"
import { FilterBar, useListState } from "@/components/filter-bar"
import { TEXT_LINK } from "@/components/link"
import { InternalLink } from "@/components/navigation"
import { Banner, Count, ErrorState, InlineEmpty, PageBody, PageHeader, Panel, PanelSkeleton, StateLabel } from "@/components/page"
import { WriteButton, WriteMenuItem } from "@/components/unlock"
import { useSecretsActions } from "@/components/secrets-actions"
import { CreateTokenDialog, RevokeTokenDialog } from "@/components/token-dialogs"
import { readPeople, readTokens, revokeToken } from "@/lib/api"
import { ago, dateTime, fromNow } from "@/lib/format"
import { historyUrl } from "@/lib/history"
import { isPerson } from "@/lib/identity"
import { FILTER_BAR_FROM, type ListSpec } from "@/lib/list-state"
import { siteUrl } from "@/lib/pages"
import {
  PERMISSION_WORDS,
  expiryCell,
  foldLabel,
  isLive,
  lastUsed,
  liveReach,
  ownerLabel,
  permissionChips,
  projectChips,
  splitTokens,
  tokenHolders,
  tokenMatches,
  tokenPermissions,
  tokenProjects,
  tokenStatus,
  type Permission,
  type Reach,
  type Rights,
} from "@/lib/tokens"
import type { Roles, TeamPageResponse, TokenView } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The tokens that deploy without SSH: one line each, OpenRouter's keys
 * table, its details in a sheet. Machine level, beside People.
 *
 * The page reads `/api/tokens` itself: the tokens are the steward's, and change
 * only through this page. Creating one asks for the unlock when *New token*
 * is pressed; revoking does not, so that a stolen token is closed without
 * looking for a password first.
 *
 * The owner sees every token, each with whose it is, and makes one for
 * themselves or for a person of People. A person sees theirs alone, those the
 * owner made for them included, mints them under their own unlock, a forced
 * sign-in at their provider, and never beyond their roles.
 *
 * What tokens did is in Activity: the header's *History*, and each token's
 * sheet, its last ten actions. Revoked and expired tokens fold under the
 * list, history rather than something to act on.
 */

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; list: TeamPageResponse }

/** The list's address: a search, from ten tokens. */
const SPEC: ListSpec = {}

/** The pause glyph of a project or a permission a person's token holds but may not use now. */
function PauseGlyph({ className }: { className?: string }) {
  return <Pause aria-hidden="true" className={cn("size-3 shrink-0", className)} strokeWidth={2.25} />
}

/** A permission's chip: its short word, its sentence on hover; paused, muted with the glyph and why. */
function PermissionChip({ permission, ended }: { permission: Permission; ended: boolean }) {
  const words = PERMISSION_WORDS[permission.key]
  const paused = permission.pause !== null
  return (
    <span
      title={paused ? `${words.title} (paused: ${permission.pause})` : words.title}
      className={cn(CHIP, "font-normal", paused ? "border-dashed text-muted-foreground" : ended ? "text-muted-foreground" : "text-secondary-foreground")}
    >
      {paused && <PauseGlyph />}
      {words.chip}
      {paused && <span className="sr-only"> (paused: {permission.pause})</span>}
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

const reachText = (reach: readonly Reach[]) =>
  reach.map(({ slug, detail, paused }) => (detail === null ? slug : `${slug} (${paused ? `paused: ${detail}` : detail})`)).join(", ")

/** A revoked or expired token's cells are history: muted, whatever they say. */
function ProjectsCell({ reach, ended }: { reach: readonly Reach[]; ended: boolean }) {
  if (reach.length === 0) return <span className="text-muted-foreground">No project yet</span>
  const { shown, more } = projectChips(reach)
  return (
    <span title={reachText(reach)} className={cn("flex min-w-0 items-center gap-1.5", ended && "text-muted-foreground")}>
      <span className="flex min-w-0 items-center truncate">
        {shown.map((one, index) => (
          <span key={one.slug} className={cn("inline-flex min-w-0 items-center gap-1", one.paused && "text-muted-foreground")}>
            {index > 0 && <span className="text-muted-foreground">,&nbsp;</span>}
            {one.paused && <PauseGlyph />}
            <span className="truncate">{one.slug}</span>
            {one.paused && <span className="sr-only"> (paused: {one.detail})</span>}
          </span>
        ))}
      </span>
      <More count={more} title={reachText(reach)} />
    </span>
  )
}

function PermissionsCell({ permissions, ended }: { permissions: readonly Permission[]; ended: boolean }) {
  // Nothing beyond deploying is every token's default: quiet.
  if (permissions.length === 0) return <span className="sr-only">None</span>
  const { shown, more } = permissionChips(permissions)
  const all = permissions.map((one) => (one.pause === null ? PERMISSION_WORDS[one.key].title : `${PERMISSION_WORDS[one.key].title} (paused: ${one.pause})`)).join(", ")
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {shown.map((one) => (
        <PermissionChip key={one.key} permission={one} ended={ended} />
      ))}
      <More count={more} title={all} />
    </span>
  )
}

const EXPIRY_TONE = { plain: "text-foreground", muted: "text-muted-foreground", attention: "font-medium text-attention-text" } as const

/** Every live permission and project paused, nothing left to deploy now: said once beside the name. */
function fullyPaused(reach: readonly Reach[], permissions: readonly Permission[]): boolean {
  const creates = permissions.some((one) => one.key === "create" && one.pause === null)
  return reach.length > 0 && reach.every((one) => one.paused) && !creates
}

function columns({
  owner,
  now,
  rightsOf,
  open,
}: {
  owner: boolean
  now: number
  rightsOf: (token: TokenView) => Rights | null
  open: (token: TokenView) => void
}): Column<TokenView>[] {
  return [
    {
      key: "name",
      head: "Name",
      width: "minmax(150px,1.2fr)",
      slot: "primary",
      cell: (token) => {
        const live = isLive(token, now)
        const rights = rightsOf(token)
        const paused = live && fullyPaused(liveReach(token, rights?.roles ?? null), tokenPermissions(token, rights))
        return (
          <>
            <RowButton onClick={() => open(token)} className={cn(!live && "font-normal text-muted-foreground")}>
              {token.label}
            </RowButton>
            {paused && (
              <StateLabel tone="neutral" title="Every project it deploys is paused: its owner's role there is below Developer now.">
                Paused
              </StateLabel>
            )}
          </>
        )
      },
    },
    ...(owner
      ? [
          {
            key: "owner",
            head: "Owner",
            width: "minmax(140px,0.9fr)",
            slot: "meta" as const,
            cell: (token: TokenView) => (
              <CellText title={ownerLabel(token)} className={isLive(token, now) ? "text-secondary-foreground" : "text-muted-foreground"}>
                {ownerLabel(token)}
              </CellText>
            ),
          },
        ]
      : []),
    {
      key: "projects",
      head: "Projects",
      width: "minmax(130px,1fr)",
      slot: "meta",
      cell: (token) => <ProjectsCell reach={liveReach(token, rightsOf(token)?.roles ?? null)} ended={!isLive(token, now)} />,
    },
    {
      key: "permissions",
      head: "Permissions",
      width: "minmax(190px,1.1fr)",
      slot: "hide",
      cell: (token) => <PermissionsCell permissions={tokenPermissions(token, rightsOf(token))} ended={!isLive(token, now)} />,
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

/** A token's sheet: whose it is and who made it, its dates, each project and permission explained, its last actions. */
function TokenSheet({
  token,
  now,
  owner,
  rights,
  known,
  onClose,
  onRevoke,
}: {
  token: TokenView | null
  now: number
  /** The owner reads it; a person reads their own. */
  owner: boolean
  rights: Rights | null
  known: ReadonlySet<string>
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
      {token !== null && <TokenDetails token={token} now={now} owner={owner} rights={rights} known={known} onRevoke={onRevoke} />}
    </DetailSheet>
  )
}

function TokenDetails({
  token,
  now,
  owner,
  rights,
  known,
  onRevoke,
}: {
  token: TokenView
  now: number
  owner: boolean
  rights: Rights | null
  known: ReadonlySet<string>
  onRevoke: (token: TokenView) => void
}) {
  const reach = liveReach(token, rights?.roles ?? null)
  const permissions = tokenPermissions(token, rights)
  const live = isLive(token, now)
  const when = (at: number) => (
    <>
      {dateTime(at)} <span className="text-muted-foreground">({at > now ? fromNow(at - now) : ago(now - at)})</span>
    </>
  )
  // Who made it, said only when it is not whose it is: the owner's for a person, or the other way round.
  const madeByOther = token.member !== null && token.by !== token.member
  const facts: Fact[] = [
    ...(owner ? [{ label: "Owner", value: token.member === null && token.email !== "owner" ? `You, for ${token.email}` : ownerLabel(token) }] : []),
    ...(madeByOther ? [{ label: "Made by", value: owner ? "You" : "The owner" }] : []),
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
            {reach.map(({ slug, detail, paused }) => (
              <li key={slug} className="flex min-h-9 items-center justify-between gap-3 py-1.5">
                {known.has(slug) ? (
                  <InternalLink href={siteUrl(slug)} className={cn(TEXT_LINK, "min-w-0 truncate")}>
                    {slug}
                  </InternalLink>
                ) : (
                  <span className="min-w-0 truncate">{slug}</span>
                )}
                {detail !== null && (
                  <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", paused ? "text-muted-foreground" : "text-secondary-foreground")}>
                    {paused && <PauseGlyph />}
                    {paused ? `Paused: ${detail}` : detail === "created" ? "Created by it" : detail}
                  </span>
                )}
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
            {permissions.map((one) => {
              const words = PERMISSION_WORDS[one.key]
              return (
                <li key={one.key} className="grid gap-0.5">
                  <span className={cn("inline-flex items-center gap-1.5 font-medium", one.pause !== null && "text-muted-foreground")}>
                    {one.pause !== null && <PauseGlyph />}
                    {words.title}
                  </span>
                  <span className="text-xs text-pretty text-muted-foreground">
                    {one.pause !== null ? `Paused: ${one.pause}. ` : ""}
                    {words.sentence}
                  </span>
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
  const { now, offset, snapshot, sessionExpired, identity } = useData()
  const signedPerson = isPerson(identity)
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const serverNow = now + offset
  const sheet = useSheet("token")
  const search = useListState(SPEC)
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [holders, setHolders] = useState<{ email: string; roles: Roles; create: boolean }[]>([])
  // Every person's rights now, for the owner: where each person's token deploys today, and what it may still do.
  const [people, setPeople] = useState<ReadonlyMap<string, Rights>>(new Map())
  const [creating, setCreating] = useState<{ open: boolean; opening: number }>({ open: false, opening: 0 })
  const [showEnded, setShowEnded] = useState(false)
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

  /** Unlocked by then: `WriteButton` asked first, the dialog would only end in a 423. */
  async function openCreation() {
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
    announce(`${token.label} revoked.`)
    void reload()
  }

  const askRevoke = (token: TokenView) => setRevoking({ token, open: true, inProgress: false, error: "" })

  const projects = tokenProjects(snapshot?.sites ?? [], snapshot?.zone ?? null)
  const known = new Set(snapshot?.sites.map((site) => site.slug) ?? [])
  const list = loaded.state === "ready" ? loaded.list : null
  const person = list?.member ?? null
  const owner = person === null
  const rightsOf = (token: TokenView): Rights | null =>
    token.member === null ? null : person !== null ? { roles: person.roles, create: person.create } : (people.get(token.member) ?? null)

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
      onPress={() => void openCreation()}
      purpose="create a token"
      resume="New token"
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
        {ended.length > 0 ? "No token can deploy right now." : owner ? "No token yet. Create one per person or agent." : "No token yet. Create one per workstation or agent."}
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
              {signedPerson
                ? "Your tokens let your CLI or an agent deploy with sitesolide deploy, without SSH. A token never does more than your roles do now: below Developer on a project, it is paused there."
                : "A token lets your agents, or a person, deploy with sitesolide deploy, without SSH. Every token is someone's: yours deploys what you allow it; a person's never does more than their roles, and goes with them."}
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
                columns={columns({ owner, now: serverNow, rightsOf, open: (token) => sheet.open(token.id) })}
                narrowBelow={owner ? "56rem" : "48rem"}
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
        owner={owner}
        rights={opened === null ? null : rightsOf(opened)}
        known={known}
        onClose={sheet.close}
        onRevoke={askRevoke}
      />
      <CreateTokenDialog
        key={creating.opening}
        open={creating.open}
        origin={window.location.origin}
        projects={projects}
        person={person === null ? null : { roles: person.roles, create: person.create }}
        holders={holders}
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
