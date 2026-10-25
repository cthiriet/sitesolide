import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Building2, FolderMinus, FolderPlus, RectangleEllipsis, SearchX, User, UserX, UsersRound, type LucideIcon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CHIP, Who } from "@/components/access-word"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { DataTable, RowButton, RowMenu, type Column } from "@/components/data-table"
import { DetailSheet, SheetFacts, SheetRecent, SheetSection, useSheet, type Fact } from "@/components/detail-sheet"
import { FilterBar, useListState, type Facet } from "@/components/filter-bar"
import { LegendEntry } from "@/components/legend"
import { TEXT_LINK } from "@/components/link"
import { InternalLink } from "@/components/navigation"
import { ProjectLink } from "@/components/project-link"
import { Banner, Count, EmptyState, ErrorState, INPUT_DIALOG, InlineEmpty, PageBody, PageHeader, Panel, PanelSkeleton } from "@/components/page"
import { WriteButton, WriteMenuItem } from "@/components/unlock"
import { useSecretsActions } from "@/components/secrets-actions"
import { readPeople, readTokens, removeAccess, removePerson, setCreate } from "@/lib/api"
import { ACCESS_UNREACHABLE, passwordExpiry, refusalText } from "@/lib/access"
import { FILTER_BAR_FROM, narrowList, type ListSpec } from "@/lib/list-state"
import {
  ENTRY_KINDS,
  ENTRY_WORDS,
  accessExpiry,
  createFieldError,
  createRefusal,
  entryMatches,
  entryProjects,
  expiredAccesses,
  mayRemove,
  peopleEntries,
  removalSentence,
  revokedTokensLine,
  type EntryKind,
  type EntryProject,
  type PeopleEntry,
} from "@/lib/people"
import { refusalOf } from "@/lib/secrets"
import { fitChips, isLive } from "@/lib/tokens"
import { TONE_TEXT } from "@/lib/tones"
import type { PeoplePageResponse, PersonView, TokenView } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * People: everyone with access to a project, and every domain, across the
 * machine, in one list; the owner's alone. Roles are given in each project's
 * Access section, where the people are; here the owner lets someone create
 * projects, and takes someone off every project at once, from a row's menu
 * or its sheet.
 *
 * Giving the create right waits for the unlock, as giving a role does;
 * taking it away, taking someone off, or clearing the password accesses that
 * ended, never waits.
 */

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; page: PeoplePageResponse }

/** The list's address: a search and the Type facet, from ten rows. */
const SPEC: ListSpec = { facets: { type: ENTRY_KINDS } }

/** What a row is, as an icon: User a company account, RectangleEllipsis password access, Building2 a domain. */
const KIND_ICON: Readonly<Record<EntryKind, LucideIcon>> = { account: User, password: RectangleEllipsis, domain: Building2 }

function KindMark({ kind }: { kind: EntryKind }) {
  const Icon = KIND_ICON[kind]
  return (
    <span role="img" aria-label={ENTRY_WORDS[kind].label} title={`${ENTRY_WORDS[kind].label}. ${ENTRY_WORDS[kind].description}`} className="inline-flex shrink-0 text-muted-foreground">
      <Icon aria-hidden="true" className="size-4" />
    </span>
  )
}

/** "calendar Admin", the role muted; a password access's project alone, its icon saying the rest. */
function ProjectWord({ project, kind }: { project: EntryProject; kind: EntryKind }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <ProjectLink slug={project.slug} section="access" className="text-foreground" />
      {kind !== "password" && <span className="shrink-0 text-muted-foreground">{project.role}</span>}
    </span>
  )
}

const projectsText = (projects: readonly EntryProject[]) => projects.map(({ slug, role }) => `${slug}: ${role}`).join(", ")

function ProjectsCell({ entry, now }: { entry: PeopleEntry; now: number }) {
  const projects = entryProjects(entry, now)
  if (projects.length === 0) {
    const admin = entry.kind !== "domain" && entry.person.admin
    return <span className="text-muted-foreground">{admin ? "Every site, as admin" : "No project yet"}</span>
  }
  // A role takes its room beside the slug, about ten characters.
  const { shown, more } = fitChips(projects, (one) => one.slug.length + (entry.kind === "password" ? 0 : one.role.length + 1), { budget: 32 })
  return (
    <span title={projectsText(projects)} className="flex min-w-0 items-center gap-1.5">
      <span className="flex min-w-0 items-baseline truncate">
        {shown.map((project, index) => (
          <span key={project.slug} className="inline-flex min-w-0 items-baseline">
            {index > 0 && <span className="text-muted-foreground">,&nbsp;</span>}
            <ProjectWord project={project} kind={entry.kind} />
          </span>
        ))}
      </span>
      {more > 0 && (
        <span className="shrink-0">
          <Count className="h-[1.125rem] px-1 text-[0.6875rem]">+{more}</Count>
          <span className="sr-only">: {projectsText(projects)}</span>
        </span>
      )}
    </span>
  )
}

const EXPIRY_TONE = { plain: "text-foreground", muted: "text-muted-foreground", attention: "font-medium text-attention-text" } as const

function columns(now: number, open: (entry: PeopleEntry) => void): Column<PeopleEntry>[] {
  return [
    {
      key: "who",
      head: "Person",
      width: "minmax(220px,1.3fr)",
      slot: "primary",
      cell: (entry) => (
        <>
          <KindMark kind={entry.kind} />
          {/* The whole email on one line, cut at its end: Who's break after the @ wraps a button even under nowrap. */}
          <RowButton onClick={() => open(entry)}>{entry.who}</RowButton>
          {entry.kind !== "domain" && entry.person.create && (
            <span title="May create projects, with a token of their own" className={cn(CHIP, "font-normal text-secondary-foreground")}>
              Creates projects
            </span>
          )}
        </>
      ),
    },
    {
      key: "projects",
      head: "Projects",
      width: "minmax(220px,1.6fr)",
      slot: "meta",
      cell: (entry) => <ProjectsCell entry={entry} now={now} />,
    },
    {
      key: "expires",
      head: "Expires",
      width: "104px",
      align: "end",
      slot: "state",
      cell: (entry) => {
        const expiry = entry.kind === "domain" ? null : accessExpiry(entry.person, now)
        if (expiry === null) return null
        return (
          <span title="When their password access ends" className={cn("whitespace-nowrap", EXPIRY_TONE[expiry.tone])}>
            {expiry.text}
          </span>
        )
      },
    },
  ]
}

/** Let someone create projects who has no access anywhere yet: a company email, *Allow*. Unlocked by then. */
function AllowDialog({
  open,
  page,
  onClose,
  onGiven,
}: {
  open: boolean
  page: PeoplePageResponse
  onClose: () => void
  onGiven: (email: string) => void
}) {
  const actions = useSecretsActions()
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const id = useId()

  async function allow(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return
    const fault = createFieldError(text, page.signIn)
    if (fault !== null) {
      setError(fault)
      return field.current?.focus()
    }
    setInProgress(true)
    try {
      const email = text.trim().toLowerCase()
      const { status, body } = await setCreate(email, true)
      if (status === 200) return onGiven(email)
      const message = actions.refusal(refusalOf(status, body))
      if (message === null) return onClose()
      setError(message)
    } finally {
      setInProgress(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onClose()
      }}
    >
      <DialogContent className={cn("gap-5 sm:max-w-md", INPUT_DIALOG)} initialFocus={() => field.current}>
        <form noValidate onSubmit={(event) => void allow(event)} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Let someone create projects</DialogTitle>
            <DialogDescription className="text-pretty">
              With a token of their own, they deploy new projects, restricted, and become Admin of each.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={id}>Company email</Label>
            <Input
              ref={field}
              id={id}
              value={text}
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="name@company.com"
              onChange={(event) => {
                setText(event.target.value)
                setError("")
              }}
              aria-invalid={error !== "" || undefined}
              aria-describedby={error !== "" ? `${id}-error` : undefined}
              className="h-10 sm:h-9"
            />
            {error !== "" && (
              <p id={`${id}-error`} role="alert" className="text-xs text-pretty text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" className="max-sm:h-10" />} disabled={inProgress}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={inProgress} className="max-sm:h-10">
              {inProgress ? "Saving…" : "Allow"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Someone's or a domain's sheet: what they are, each project and role, the create right, their tokens, their last actions. */
function PersonSheet({
  entry,
  page,
  now,
  tokens,
  busy,
  onClose,
  onCreate,
  onRemove,
}: {
  entry: PeopleEntry | null
  page: PeoplePageResponse
  now: number
  /** The tokens read for the sheet, null until they are. */
  tokens: readonly TokenView[] | null
  busy: boolean
  onClose: () => void
  onCreate: (person: PersonView, create: boolean) => void
  onRemove: (person: PersonView) => void
}) {
  const person = entry === null || entry.kind === "domain" ? null : entry.person
  const refusal = person === null ? null : createRefusal(person.who, page.signIn)
  const description =
    entry === null
      ? undefined
      : entry.kind === "domain"
        ? `Everyone with a company account at ${entry.who.replace(/^@/, "")}.`
        : entry.kind === "account" && !page.signIn.configured
          ? "Can't sign in until company sign-in is set up."
          : ENTRY_WORDS[entry.kind].description
  const actions =
    person === null ? undefined : person.create ? (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onCreate(person, false)} className="max-md:h-10">
        <FolderMinus />
        Stop creating projects
      </Button>
    ) : refusal === null ? (
      <WriteButton variant="outline" size="sm" disabled={busy} onPress={() => onCreate(person, true)} purpose="let someone create projects" className="max-md:h-10">
        <FolderPlus />
        Let create projects
      </WriteButton>
    ) : undefined

  return (
    <DetailSheet open={entry !== null} onClose={onClose} title={entry?.who ?? ""} description={description} actions={actions}>
      {entry !== null && (
        <>
          <SheetFacts
            facts={[
              {
                label: "Type",
                value: (
                  <LegendEntry icon={KIND_ICON[entry.kind]}>{ENTRY_WORDS[entry.kind].label}</LegendEntry>
                ),
              },
              ...(person === null
                ? []
                : ([
                    { label: "Creates projects", value: person.create ? "Yes, with a token of their own" : (refusal ?? "No") },
                    ...(person.admin
                      ? [
                          {
                            label: "Every site",
                            value: (
                              <>
                                As admin: set on the server in <code className="font-mono text-xs">OIDC_ADMIN_EMAILS</code>.
                              </>
                            ),
                          },
                        ]
                      : []),
                  ] satisfies Fact[])),
            ]}
          />

          <SheetSection title="Projects">
            <EntryProjects entry={entry} now={now} />
          </SheetSection>

          {person !== null && entry.kind === "account" && <PersonTokens who={person.who} tokens={tokens} now={now} />}

          {entry.kind === "account" && <SheetRecent filter={{ actor: entry.who }} />}

          {person !== null && mayRemove(person) && (
            <div className="grid justify-items-start gap-2 border-t pt-4">
              <Button variant="outline" disabled={busy} onClick={() => onRemove(person)} className="text-destructive hover:text-destructive max-md:h-10">
                <UserX />
                Remove from every project
              </Button>
            </div>
          )}
        </>
      )}
    </DetailSheet>
  )
}

/** Each project of a row, linked to its Access, with the role, a password access's end. */
function EntryProjects({ entry, now }: { entry: PeopleEntry; now: number }) {
  const projects = entryProjects(entry, now)
  if (projects.length === 0) {
    return <p className="text-muted-foreground">{entry.kind !== "domain" && entry.person.admin ? "Every site, as admin." : "No project yet."}</p>
  }
  return (
    <ul className="divide-y divide-divider">
      {projects.map((project) => {
        const password = entry.kind === "domain" ? null : (entry.person.passwords.find((one) => one.slug === project.slug) ?? null)
        const expiry = password === null ? null : passwordExpiry(password, now)
        return (
          <li key={project.slug} className="flex min-h-9 items-center justify-between gap-3 py-1.5">
            <ProjectLink slug={project.slug} section="access" />
            <span className="shrink-0 text-xs text-secondary-foreground">
              {project.role}
              {expiry !== null && <span className={expiry.tone === "attention" ? TONE_TEXT.attention : "text-muted-foreground"}>, {expiry.text}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** The tokens someone holds, which go with them when they are removed. */
function PersonTokens({ who, tokens, now }: { who: string; tokens: readonly TokenView[] | null; now: number }) {
  if (tokens === null) return null
  const theirs = tokens.filter((token) => token.member === who && isLive(token, now))
  return (
    <SheetSection title="Tokens">
      {theirs.length === 0 ? (
        <p className="text-muted-foreground">None.</p>
      ) : (
        <ul className="divide-y divide-divider">
          {theirs.map((token) => (
            <li key={token.id} className="flex min-h-9 items-center justify-between gap-3 py-1.5">
              <InternalLink href={`/tokens/?token=${encodeURIComponent(token.id)}`} className={cn(TEXT_LINK, "min-w-0 truncate")}>
                {token.label}
              </InternalLink>
              <span className="shrink-0 text-xs text-muted-foreground">{token.by === "owner" ? "Made by you" : "Made by them"}</span>
            </li>
          ))}
        </ul>
      )}
    </SheetSection>
  )
}

export function PeoplePage() {
  const { now, offset, sessionExpired } = useData()
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const serverNow = now + offset
  const sheet = useSheet("person")
  const list = useListState(SPEC)
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [tokens, setTokens] = useState<TokenView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState("")
  const [allowing, setAllowing] = useState<{ open: boolean; opening: number }>({ open: false, opening: 0 })
  const [removing, setRemoving] = useState<{ person: PersonView | null; tokens: string | null; open: boolean; inProgress: boolean; error: string }>({
    person: null,
    tokens: null,
    open: false,
    inProgress: false,
    error: "",
  })
  const [clearing, setClearing] = useState<{ open: boolean; inProgress: boolean; error: string }>({ open: false, inProgress: false, error: "" })

  const reload = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoaded({ state: "loading" })
      const { status, body } = await readPeople()
      if (status === 401) return sessionExpired()
      if (status === 200 && body !== null && Array.isArray(body.people)) return setLoaded({ state: "ready", page: body })
      const message = status === 502 ? ACCESS_UNREACHABLE : refusalText(status, body)
      setLoaded((previous) => (previous.state === "ready" && !showLoading ? previous : { state: "failed", message }))
    },
    [sessionExpired],
  )

  /** The tokens, for a person's sheet and a removal's confirmation: which go with them. */
  const readHeld = useCallback(async (): Promise<TokenView[] | null> => {
    const { status, body } = await readTokens()
    if (status === 401) {
      sessionExpired()
      return null
    }
    const read = status === 200 && body !== null && Array.isArray(body.tokens) ? body.tokens : null
    setTokens(read)
    return read
  }, [sessionExpired])

  useEffect(() => {
    void reload()
  }, [reload])

  // A sheet opened, by a click or by its address: its tokens, once.
  useEffect(() => {
    if (sheet.id !== null && tokens === null) void readHeld()
  }, [sheet.id, tokens, readHeld])

  /** Giving the right waits for the unlock, asked for when pressed; taking it away does not. */
  function changeCreate(person: PersonView, create: boolean) {
    setRowError("")
    if (create) return actions.require(() => void applyCreate(person, create), { purpose: "let someone create projects" })
    void applyCreate(person, create)
  }

  async function applyCreate(person: PersonView, create: boolean) {
    setBusy(person.who)
    try {
      const { status, body } = await setCreate(person.who, create)
      if (status === 200) {
        announce(create ? `${person.who} may create projects.` : `${person.who} may no longer create projects.`)
        return void reload()
      }
      const message = actions.refusal(refusalOf(status, body))
      if (message !== null) setRowError(`${person.who}: ${message}`)
    } finally {
      setBusy(null)
    }
  }

  /** The removal's confirmation, with the tokens it revokes: read first, so that the owner sees them before choosing. */
  async function askRemoval(person: PersonView) {
    const held = await readHeld()
    const line = held === null ? null : revokedTokensLine(held, person.who, serverNow)
    setRemoving({ person, tokens: line, open: true, inProgress: false, error: "" })
  }

  /** Every password access that ended, taken off its project one by one: none of them opens anything any more. */
  async function clearExpired(expired: { slug: string; who: string }[]) {
    setClearing({ open: true, inProgress: true, error: "" })
    for (const { slug, who } of expired) {
      const { status, body } = await removeAccess(slug, who)
      if (status === 200) continue
      const message = actions.refusal(refusalOf(status, body))
      setClearing({ open: message !== null, inProgress: false, error: message === null ? "" : `${who} on ${slug}: ${message}` })
      return void reload()
    }
    setClearing({ open: false, inProgress: false, error: "" })
    announce(`${expired.length === 1 ? "1 expired password access" : `${expired.length} expired password accesses`} removed.`)
    void reload()
  }

  async function remove() {
    const person = removing.person
    if (person === null) return
    setRemoving((previous) => ({ ...previous, inProgress: true, error: "" }))
    const { status, body } = await removePerson(person.who)
    if (status === 200) {
      setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
      announce(`${person.who} no longer has access to any project.`)
      if (sheet.id === person.who) sheet.close()
      setTokens(null)
      return void reload()
    }
    const message = actions.refusal(refusalOf(status, body))
    if (message === null) return setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
    setRemoving((previous) => ({ ...previous, inProgress: false, error: message }))
  }

  const page = loaded.state === "ready" ? loaded.page : null
  const entries = page === null ? [] : peopleEntries(page.people, page.domains)
  const expired = page === null ? [] : expiredAccesses(page.people, serverNow)
  const filterable = entries.length >= FILTER_BAR_FROM
  const { rows, counts } = narrowList(entries, filterable ? list : { query: "", facets: {}, sort: null }, {
    search: entryMatches,
    facets: { type: (entry) => entry.kind },
  })
  const facets: Facet[] = [
    {
      name: "type",
      label: "Type",
      options: ENTRY_KINDS.map((kind) => ({ value: kind, label: ENTRY_WORDS[kind].facet, icon: KIND_ICON[kind], count: counts.type?.[kind] ?? 0 })),
    },
  ]
  const opened = sheet.id === null ? null : (entries.find((entry) => entry.key === sheet.id) ?? null)
  const offersCreate = page !== null && page.available && page.signIn.configured

  return (
    <>
      <PageHeader
        title="People"
        count={page?.available === true ? entries.length : undefined}
        intro={
          <p>
            Everyone with access to a project, and every domain, with their role on each. Roles are given and changed in each
            project's Access section; here you let someone create projects, or remove them from every project at once.
          </p>
        }
        actions={
          offersCreate ? (
            <WriteButton
              variant="outline"
              onPress={() => setAllowing((before) => ({ open: true, opening: before.opening + 1 }))}
              purpose="let someone create projects"
              resume="Let someone create projects"
              className="max-md:h-10"
            >
              <FolderPlus />
              Let someone create projects
            </WriteButton>
          ) : undefined
        }
        history={{ type: "access" }}
      />
      <PageBody>
        {loaded.state === "loading" && <PanelSkeleton lines={5} title={false} />}
        {loaded.state === "failed" && (
          <Panel>
            <ErrorState title="Can't read who has access" onRetry={() => void reload(true)}>
              {loaded.message}
            </ErrorState>
          </Panel>
        )}

        {page !== null && !page.available && <Banner tone="attention">{page.reason}</Banner>}
        {page !== null && page.available && !page.signIn.configured && (
          <Banner tone="attention">
            Company sign-in isn't set up on this server: everyone added to a project gets password access, and nobody but
            you signs in to the dashboard.
          </Banner>
        )}
        {rowError !== "" && <Banner tone="error">{rowError}</Banner>}

        {page !== null && page.available && entries.length === 0 && (
          <Panel>
            <EmptyState icon={UsersRound} title="Nobody has access to a project yet">
              Add people from a project's Access section.
            </EmptyState>
          </Panel>
        )}

        {page !== null && page.available && entries.length > 0 && (
          <div className="grid gap-3">
            {filterable && (
              <FilterBar
                list={list}
                facets={facets}
                shown={rows.length}
                total={entries.length}
                noun={{ one: "person", many: "people" }}
                search={{ label: "Search people" }}
              />
            )}
            <Panel full>
              <DataTable
                label="People"
                caption="Everyone with access to a project, by name, then the domains"
                rows={rows}
                rowKey={(entry) => entry.key}
                columns={columns(serverNow, (entry) => sheet.open(entry.key))}
                onRowClick={(entry) => sheet.open(entry.key)}
                selected={sheet.id}
                menu={(entry) => {
                  if (entry.kind === "domain") return null
                  const person = entry.person
                  const offered = !person.create && createRefusal(person.who, page.signIn) === null
                  const removable = mayRemove(person)
                  if (!person.create && !offered && !removable) return null
                  return (
                    <RowMenu label={`Actions for ${person.who}`}>
                      {person.create && (
                        <WriteMenuItem unlock={false} disabled={busy === person.who} onPress={() => changeCreate(person, false)}>
                          <FolderMinus />
                          Stop creating projects
                        </WriteMenuItem>
                      )}
                      {offered && (
                        <WriteMenuItem disabled={busy === person.who} onPress={() => changeCreate(person, true)} purpose="let someone create projects">
                          <FolderPlus />
                          Let create projects
                        </WriteMenuItem>
                      )}
                      {removable && (
                        <>
                          {(person.create || offered) && <DropdownMenuSeparator />}
                          <WriteMenuItem variant="destructive" unlock={false} disabled={busy === person.who} onPress={() => void askRemoval(person)}>
                            <UserX />
                            Remove from every project
                          </WriteMenuItem>
                        </>
                      )}
                    </RowMenu>
                  )
                }}
                empty={
                  <InlineEmpty
                    icon={SearchX}
                    action={
                      <Button variant="link" className="h-auto p-0" onClick={list.clear}>
                        Clear filters
                      </Button>
                    }
                  >
                    Nobody matches.
                  </InlineEmpty>
                }
                foot={
                  expired.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{expired.length === 1 ? "1 password access has ended." : `${expired.length} password accesses have ended.`}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setClearing({ open: true, inProgress: false, error: "" })}
                        className="-ml-2 text-foreground max-md:h-9"
                      >
                        Remove expired
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            </Panel>
          </div>
        )}
      </PageBody>

      {page !== null && (
        <PersonSheet
          entry={opened}
          page={page}
          now={serverNow}
          tokens={tokens}
          busy={opened !== null && busy === opened.who}
          onClose={sheet.close}
          onCreate={changeCreate}
          onRemove={(person) => void askRemoval(person)}
        />
      )}

      {page !== null && (
        <AllowDialog
          key={allowing.opening}
          open={allowing.open}
          page={page}
          onClose={() => setAllowing((before) => ({ ...before, open: false }))}
          onGiven={(email) => {
            setAllowing((before) => ({ ...before, open: false }))
            announce(`${email} may create projects.`)
            void reload()
          }}
        />
      )}

      <AlertDialog
        open={removing.open}
        onOpenChange={(next) => {
          if (!next && !removing.inProgress) setRemoving((previous) => ({ ...previous, open: false }))
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-left max-sm:place-items-start">
            <AlertDialogTitle className="wrap-break-word">
              Remove <Who value={removing.person?.who ?? ""} /> from every project?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {removalSentence(removing.person)}
              {removing.tokens !== null && ` ${removing.tokens}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removing.error !== "" && <Banner tone="error">{removing.error}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={removing.inProgress} onClick={() => void remove()} className="max-sm:h-11">
              {removing.inProgress ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={clearing.open}
        onOpenChange={(next) => {
          if (!next && !clearing.inProgress) setClearing({ open: false, inProgress: false, error: "" })
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-left max-sm:place-items-start">
            <AlertDialogTitle>
              Remove {expired.length === 1 ? "1 expired password access" : `${expired.length} expired password accesses`}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty wrap-break-word">
              They already open nothing: {expired.map(({ slug, who }) => `${who} on ${slug}`).join(", ")}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {clearing.error !== "" && <Banner tone="error">{clearing.error}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={clearing.inProgress || expired.length === 0} onClick={() => void clearExpired(expired)} className="max-sm:h-11">
              {clearing.inProgress ? "Removing…" : "Remove expired"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
