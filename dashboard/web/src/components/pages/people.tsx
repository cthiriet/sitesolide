import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Globe, UsersRound, X } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Who } from "@/components/access-word"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { Banner, EmptyState, ErrorState, PageBody, PageHeader, Panel, PanelSkeleton } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { readPeople, readTokens, removeAccess, removePerson, setCreate } from "@/lib/api"
import { ACCESS_UNREACHABLE, refusalText } from "@/lib/access"
import { siteUrl } from "@/lib/pages"
import { createFieldError, createRefusal, domainGroups, expiredAccesses, mayRemove, projectRoles, revokedTokensLine } from "@/lib/people"
import { refusalOf } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { PeoplePageResponse, PersonView } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * People: everyone with access to a project, across the machine, and what
 * each can do; the owner's alone. Roles are given in each project's Access
 * section, where the people are; here the owner gives the right to create
 * projects, and takes someone off every project at once.
 *
 * Giving the create right waits for the unlock, as giving a role does;
 * taking it away, taking someone off, or clearing the password accesses that
 * ended, never waits.
 */

/** By email, ignoring case: a name carried over from before the registry may start with a capital. */
function sortedPeople(people: readonly PersonView[]): PersonView[] {
  return [...people].sort((a, b) => a.who.localeCompare(b.who, "en", { sensitivity: "base" }))
}

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; page: PeoplePageResponse }

/**
 * A person's row: who and their roles, the create right, the removal. In a
 * wide panel, three columns under a header, the right's label said once
 * there; narrower, the right goes under the roles with its label.
 */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 @2xl:grid-cols-[minmax(0,1fr)_10rem_2.5rem]"

const LINK =
  "rounded-sm text-foreground underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"

/** A person's roles, each project linked to its Access section. */
function Roles({ person, now }: { person: PersonView; now: number }) {
  const roles = projectRoles(person, now)
  if (roles.length === 0) return <span className="text-xs text-muted-foreground">No project yet.</span>
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {roles.map(({ slug, label, password }) => (
        <li key={slug}>
          <InternalLink href={siteUrl(slug, "access")} className={LINK}>
            {slug}
          </InternalLink>
          : {label}
          {password !== null && <span className={password.tone === "attention" ? TONE_TEXT.attention : undefined}>, {password.text}</span>}
        </li>
      ))}
    </ul>
  )
}

function PersonRow({
  person,
  page,
  now,
  busy,
  onCreate,
  onRemove,
}: {
  person: PersonView
  page: PeoplePageResponse
  now: number
  busy: boolean
  onCreate: (create: boolean) => void
  onRemove: () => void
}) {
  const id = useId()
  const refusal = createRefusal(person.who, page.signIn)
  const offered = person.create || refusal === null
  return (
    <li className={cn(ROW, "py-3")}>
      <div className="grid min-w-0 gap-1">
        <span className="font-medium wrap-break-word">
          <Who value={person.who} />
        </span>
        <Roles person={person} now={now} />
        {person.admin && <span className="text-xs text-muted-foreground">Every site, as admin: set on the server in OIDC_ADMIN_EMAILS.</span>}
      </div>
      <div className="flex items-center @max-2xl:col-start-1 @max-2xl:row-start-2 @2xl:justify-center">
        {offered ? (
          <label
            htmlFor={id}
            className="-mx-2 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm select-none hover:bg-muted has-disabled:cursor-default has-focus-visible:ring-2 has-focus-visible:ring-ring"
          >
            <input id={id} type="checkbox" checked={person.create} disabled={busy} onChange={(event) => onCreate(event.target.checked)} className="size-4 accent-primary" />
            <span className="@2xl:sr-only">May create projects</span>
          </label>
        ) : (
          <span className="sr-only">{refusal}</span>
        )}
      </div>
      <div className="flex items-center justify-end @max-2xl:col-start-2 @max-2xl:row-start-1">
        {mayRemove(person) ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            title={`Remove ${person.who} from every project`}
            aria-label={`Remove ${person.who} from every project`}
            onClick={onRemove}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive max-md:size-10 dark:hover:bg-destructive/15"
          >
            <X />
          </Button>
        ) : (
          <span aria-hidden="true" className="size-8 max-md:size-10" />
        )}
      </div>
    </li>
  )
}

/** The create right for someone who has no access anywhere yet. */
function CreateForm({ page, onGiven }: { page: PeoplePageResponse; onGiven: (email: string) => void }) {
  const actions = useSecretsActions()
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const id = useId()

  async function give(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return
    const fault = createFieldError(text, page.signIn)
    if (fault !== null) {
      setError(fault)
      return field.current?.focus()
    }
    if (!actions.state.open) return actions.unlock()
    setInProgress(true)
    try {
      const email = text.trim().toLowerCase()
      const { status, body } = await setCreate(email, true)
      if (status === 200) {
        setText("")
        setError("")
        return onGiven(email)
      }
      const message = actions.refusal(refusalOf(status, body))
      if (message !== null) setError(message)
    } finally {
      setInProgress(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void give(event)} className="grid gap-2 border-t p-4">
      <label htmlFor={id} className="text-sm leading-none font-medium">
        Let someone create projects
      </label>
      <div className="flex flex-wrap gap-2">
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
          aria-describedby={`${id}-help`}
          className="h-10 min-w-0 flex-1 basis-60 sm:h-9"
        />
        <Button type="submit" variant="outline" disabled={inProgress} className="h-10 sm:h-9">
          {inProgress ? "Saving…" : actions.state.open ? "Allow" : "Unlock to allow"}
        </Button>
      </div>
      <p id={`${id}-help`} role={error !== "" ? "alert" : undefined} className={cn("text-xs text-pretty", error !== "" ? "text-destructive" : "text-muted-foreground")}>
        {error !== "" ? error : "With a token of their own, they deploy new projects, restricted, and become Admin of each."}
      </p>
    </form>
  )
}

export function PeoplePage() {
  const { now, offset, sessionExpired } = useData()
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const serverNow = now + offset
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState("")
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

  useEffect(() => {
    void reload()
  }, [reload])

  async function changeCreate(person: PersonView, create: boolean) {
    setRowError("")
    if (create && !actions.state.open) return actions.unlock()
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
    const { status, body } = await readTokens()
    if (status === 401) return sessionExpired()
    const tokens = status === 200 && body !== null && Array.isArray(body.tokens) ? revokedTokensLine(body.tokens, person.who, serverNow) : null
    setRemoving({ person, tokens, open: true, inProgress: false, error: "" })
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
      return void reload()
    }
    const message = actions.refusal(refusalOf(status, body))
    if (message === null) return setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
    setRemoving((previous) => ({ ...previous, inProgress: false, error: message }))
  }

  const page = loaded.state === "ready" ? loaded.page : null
  const domains = page === null ? [] : domainGroups(page.domains)
  const expired = page === null ? [] : expiredAccesses(page.people, serverNow)

  return (
    <>
      <PageHeader title="People" count={page?.available === true ? page.people.length : undefined} actions={<SecretsLockControl quiet />} />
      <PageBody>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          Everyone with access to a project, and their role on each. Roles are given and changed in each project's Access
          section; here you let someone create projects, or remove them from every project at once.
        </p>

        {loaded.state === "loading" && <PanelSkeleton lines={5} />}
        {loaded.state === "failed" && (
          <Panel title="People">
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

        {page !== null && page.available && (
          <Panel
            title="People"
            count={page.people.length}
            full
            actions={
              expired.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => setClearing({ open: true, inProgress: false, error: "" })} className="max-md:h-10">
                  Remove expired
                </Button>
              ) : undefined
            }
          >
            {page.people.length === 0 ? (
              <EmptyState icon={UsersRound} title="Nobody has access to a project yet">
                Add people from a project's Access section.
              </EmptyState>
            ) : (
              <div className="@container">
                <div aria-hidden="true" className={cn(ROW, "hidden h-10 border-b bg-muted text-xs font-medium text-muted-foreground @2xl:grid")}>
                  <span>Person, and their role on each project</span>
                  <span className="text-center">May create projects</span>
                  <span />
                </div>
                <ul className="divide-y divide-divider" aria-label="People with access to a project">
                {sortedPeople(page.people).map((person) => (
                  <PersonRow
                    key={person.who}
                    person={person}
                    page={page}
                    now={serverNow}
                    busy={busy === person.who}
                    onCreate={(create) => void changeCreate(person, create)}
                    onRemove={() => void askRemoval(person)}
                  />
                ))}
                </ul>
              </div>
            )}
            {page.signIn.configured && (
              <CreateForm
                page={page}
                onGiven={(email) => {
                  announce(`${email} may create projects.`)
                  void reload()
                }}
              />
            )}
          </Panel>
        )}

        {page !== null && page.available && domains.length > 0 && (
          <Panel title="Domains" count={domains.length} description="Everyone with a company account at the domain can open these sites." full>
            <ul className="divide-y divide-divider">
              {domains.map(({ domain, slugs }) => (
                <li key={domain} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5">
                  <span className="flex items-center gap-2 font-medium">
                    <Globe aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    {domain}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Can open{" "}
                    {slugs.map((slug, index) => (
                      <span key={slug}>
                        {index > 0 && ", "}
                        <InternalLink href={siteUrl(slug, "access")} className={LINK}>
                          {slug}
                        </InternalLink>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </PageBody>

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
              They lose every role and password access at their next request, may no longer create projects, and are
              signed out of the dashboard.
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
