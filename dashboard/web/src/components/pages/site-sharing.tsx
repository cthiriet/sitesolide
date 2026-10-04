import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, Copy, DoorClosed, KeyRound, Share2, UserRoundX } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { Banner, Count, EmptyState, ErrorState, Panel, PanelSkeleton } from "@/components/page"
import { SitePage } from "@/components/site"
import { readSharing, replaceSharing } from "@/lib/api"
import { siteUrl } from "@/lib/pages"
import {
  MODE_TEXTS,
  SHARING_MODES,
  addEntries,
  canShare,
  identityPassed,
  listsInEffect,
  policySummary,
  shareMessage,
  sharingLoadFailure,
  sharingRefusal,
  sitePolicy,
  type Policy,
  type SharingList,
} from "@/lib/sharing"
import type { Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The portal's own project, whose Secrets hold portal.env. */
const PORTAL_SLUG = "portal"

type SharingRead =
  | { state: "loading" }
  | { state: "error"; failure: { title: string; advice: string } }
  | { state: "ready"; list: SharingList }

/**
 * The policies, read when the section opens and again with every snapshot,
 * like the guest accesses: a policy changed from another tab must not stay
 * shown as it was. Read here rather than above every page: nothing else shows
 * them.
 */
function useSharing() {
  const { generation, sessionExpired } = useData()
  const [read, setRead] = useState<SharingRead>({ state: "loading" })

  const reload = useCallback(
    async (showLoading = false) => {
      if (showLoading) setRead({ state: "loading" })
      const { status, body } = await readSharing()
      if (status === 401) return sessionExpired()
      if (status === 200 && body !== null && Array.isArray(body.sites) && body.sso !== undefined) {
        return setRead({ state: "ready", list: { sso: body.sso, sites: body.sites } })
      }
      setRead({ state: "error", failure: sharingLoadFailure(status) })
    },
    [sessionExpired],
  )

  useEffect(() => {
    void reload()
  }, [reload, generation])

  return { read, setRead, reload }
}

/** The way to the site's door, where the portal is turned on, or off to make the site public. */
function AccessLink({ slug, children = "Open Access" }: { slug: string; children?: string }) {
  return (
    <InternalLink href={siteUrl(slug, "access")} className={cn(buttonVariants({ variant: "outline" }), "max-md:h-10")}>
      {children}
    </InternalLink>
  )
}

function SecretsLink({ children }: { children: string }) {
  return (
    <InternalLink
      href={siteUrl(PORTAL_SLUG, "secrets")}
      className="rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
    </InternalLink>
  )
}

/** The three modes, as cards to choose from. Choosing saves at once, as revoking a guest does. */
function ModeChoice({
  policy,
  busy,
  onChoose,
}: {
  policy: Policy
  busy: boolean
  onChoose: (mode: Policy["mode"]) => void
}) {
  const name = useId()
  const kept = !listsInEffect(policy.mode).people && policy.people.length + policy.domains.length > 0
  return (
    <fieldset className="grid gap-2" disabled={busy}>
      <legend className="sr-only">Who gets in</legend>
      <div className="grid gap-2 @2xl/body:grid-cols-3">
        {SHARING_MODES.map((mode) => (
          <label
            key={mode}
            className="grid cursor-pointer content-start gap-1 rounded-lg border border-input p-3 transition-colors select-none hover:bg-muted has-checked:border-foreground has-checked:bg-muted has-checked:ring-1 has-checked:ring-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:cursor-default"
          >
            <input
              type="radio"
              name={name}
              value={mode}
              checked={policy.mode === mode}
              onChange={() => onChoose(mode)}
              className="sr-only"
            />
            <span className="text-sm font-medium">{MODE_TEXTS[mode].title}</span>
            <span className="text-xs text-pretty text-muted-foreground">{MODE_TEXTS[mode].description}</span>
          </label>
        ))}
      </div>
      {kept && (
        <p className="text-xs text-pretty text-muted-foreground">
          {policy.people.length > 0 && `${policy.people.length} ${policy.people.length === 1 ? "person" : "people"}`}
          {policy.people.length > 0 && policy.domains.length > 0 && " and "}
          {policy.domains.length > 0 && `${policy.domains.length} ${policy.domains.length === 1 ? "domain" : "domains"}`} kept
          for when you share it again, not in effect while only admins get in.
        </p>
      )}
    </fieldset>
  )
}

/**
 * A list the policy holds, people or domains: the entries with their removal,
 * and the field that adds one or several. Each change saves at once.
 */
function EntryList({
  kind,
  slug,
  values,
  busy,
  onChange,
}: {
  kind: "people" | "domains"
  slug: string
  values: readonly string[]
  busy: boolean
  onChange: (next: string[]) => Promise<boolean>
}) {
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState("")
  const [error, setError] = useState("")
  const people = kind === "people"

  async function add(event: SyntheticEvent) {
    event.preventDefault()
    const addition = addEntries(values, typed, kind)
    if (addition.error !== null) {
      setError(addition.error)
      field.current?.focus()
      return
    }
    if (await onChange(addition.values)) setTyped("")
    field.current?.focus()
  }

  return (
    <Panel
      title={people ? "People" : "Domains"}
      count={values.length > 0 ? values.length : undefined}
      description={
        people
          ? "They sign in with their work email. Removing someone closes the site to them at their next request."
          : "Everyone whose verified work email is at one of these domains gets in. Subdomains are not included."
      }
      full
    >
      {values.length === 0 ? (
        <EmptyState icon={people ? UserRoundX : Share2} title={people ? "Nobody added yet" : "No domain added yet"} compact />
      ) : (
        <ul className="divide-y" aria-label={people ? `People ${slug} is shared with` : `Domains ${slug} is shared with`}>
          {values.map((value) => (
            <li key={value} className="flex min-h-11 items-center gap-3 py-1 pr-2 pl-4">
              <span className="min-w-0 flex-1 wrap-anywhere">{value}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Remove ${value} from ${slug}`}
                onClick={() => void onChange(values.filter((entry) => entry !== value))}
                className="-my-1 h-11 px-3 text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive md:h-8 dark:hover:bg-destructive/15"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form noValidate onSubmit={(event) => void add(event)} className="grid gap-2 border-t p-4">
        <Label htmlFor={id}>{people ? "Add people" : "Add a domain"}</Label>
        <div className="flex gap-2">
          <Input
            ref={field}
            id={id}
            value={typed}
            inputMode={people ? "email" : "url"}
            autoComplete="off"
            spellCheck={false}
            placeholder={people ? "name@company.com" : "company.com"}
            onChange={(event) => {
              setTyped(event.target.value)
              setError("")
            }}
            aria-invalid={error !== "" || undefined}
            aria-describedby={error !== "" ? `${id}-error` : `${id}-help`}
            className="h-10 sm:h-9"
          />
          <Button type="submit" variant="outline" disabled={busy} className="h-10 sm:h-9">
            Add
          </Button>
        </div>
        {error !== "" ? (
          <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {people ? "Separate several addresses with commas." : "Without the @, like company.com."}
          </p>
        )}
      </form>
    </Panel>
  )
}

/** The line to send, copied as it is: where to go and with which account. */
function ShareLink({ site, providerName }: { site: Site; providerName: string | null }) {
  const text = shareMessage(site.address, providerName)
  const { state, copy, reset } = useCopy("Message copied")
  return (
    <Panel title="Send them the link" description="It opens nothing by itself: they still sign in, and get in only if this page lets them.">
      {state === "failure" ? (
        <CopyFallback text={text} onClose={reset} />
      ) : (
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
          <p className="min-w-0 flex-1 text-sm wrap-anywhere">{text}</p>
          <Button variant="outline" size="sm" onClick={() => void copy(text)} className="max-md:h-10">
            {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
            {state === "copied" ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </Panel>
  )
}

function Content({
  site,
  read,
  onSaved,
  onRetry,
}: {
  site: Site
  read: SharingRead
  onSaved: (list: SharingList) => void
  onRetry: () => void
}) {
  const { sessionExpired } = useData()
  const announce = useAnnounce()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  if (!canShare(site)) {
    return (
      <Panel>
        <EmptyState icon={DoorClosed} title={`${site.slug} isn't behind the portal`} action={<AccessLink slug={site.slug} />}>
          People sign in through the portal, so {site.slug} needs it first. Turn it on from Access.
        </EmptyState>
      </Panel>
    )
  }

  if (read.state === "loading") return <PanelSkeleton lines={3} />

  if (read.state === "error") {
    return (
      <Panel>
        <ErrorState title={read.failure.title} onRetry={onRetry}>
          {read.failure.advice}
        </ErrorState>
      </Panel>
    )
  }

  const { list } = read
  const { policy } = sitePolicy(list, site.address)
  const { sso } = list
  const effect = listsInEffect(policy.mode)

  async function save(next: Policy): Promise<boolean> {
    setBusy(true)
    setError("")
    const { status, body } = await replaceSharing(site.address, next)
    setBusy(false)
    if (status === 401) {
      sessionExpired()
      return false
    }
    if (status !== 200 || body === null || body.policy === undefined) {
      setError(sharingRefusal(status, body))
      return false
    }
    const others = list.sites.filter((entry) => entry.host !== site.address)
    onSaved({ ...list, sites: [...others, { host: site.address, policy: body.policy, updatedAt: body.updatedAt }] })
    announce(`Sharing of ${site.slug} saved: ${policySummary(body.policy)}`)
    return true
  }

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        Who may sign in to {site.slug} with their work account
        {sso.configured && sso.providerName !== null ? `, through ${sso.providerName}` : ""}. A change applies at their
        next request. Guests keep their passwords whatever you choose here.
      </p>

      {!sso.configured && (
        <Banner tone="attention" icon={KeyRound}>
          Signing in with a work account isn't set up on this server, so only passwords open {site.slug} for now. Set{" "}
          <code className="font-mono text-xs">OIDC_ISSUER</code>, <code className="font-mono text-xs">OIDC_CLIENT_ID</code>{" "}
          and <code className="font-mono text-xs">OIDC_CLIENT_SECRET</code> in the portal's{" "}
          <SecretsLink>portal.env</SecretsLink>, then restart it. What you choose here applies as soon as it is.
        </Banner>
      )}

      {identityPassed(site) === false && (
        <Banner tone="attention">
          The app behind {site.slug} isn't told who signed in yet: its Caddy block predates it. Deploy {site.slug} again
          to pass <code className="font-mono text-xs">X-Sitesolide-User</code> to it. Who gets in already follows this
          page.
        </Banner>
      )}

      {error !== "" && <Banner tone="error">{error}</Banner>}

      <div className="grid items-start gap-6 @4xl/body:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid gap-6">
          <Panel title="Who gets in" actions={<Count>{policySummary(policy)}</Count>}>
            <ModeChoice policy={policy} busy={busy} onChoose={(mode) => void save({ ...policy, mode })} />
          </Panel>
          {effect.people && (
            <EntryList
              kind="people"
              slug={site.slug}
              values={policy.people}
              busy={busy}
              onChange={(people) => save({ ...policy, people })}
            />
          )}
          {effect.domains && (
            <EntryList
              kind="domains"
              slug={site.slug}
              values={policy.domains}
              busy={busy}
              onChange={(domains) => save({ ...policy, domains })}
            />
          )}
        </div>

        <div className="grid gap-6">
          <ShareLink site={site} providerName={sso.providerName} />

          <Panel title="Always let in" count={sso.admins.length > 0 ? sso.admins.length : undefined} full>
            {sso.admins.length === 0 ? (
              <EmptyState title="No admin email" compact>
                Admins get into every protected site. List them in <code className="font-mono text-xs">OIDC_ADMIN_EMAILS</code>{" "}
                in the portal's <SecretsLink>portal.env</SecretsLink>.
              </EmptyState>
            ) : (
              <>
                <ul className="divide-y" aria-label="Admin emails">
                  {sso.admins.map((email) => (
                    <li key={email} className="flex min-h-11 items-center px-4 py-1 wrap-anywhere">
                      {email}
                    </li>
                  ))}
                </ul>
                <p className="border-t px-4 py-3 text-xs text-pretty text-muted-foreground">
                  Admins get into every protected site, whatever its sharing. They are set in the portal's{" "}
                  <SecretsLink>portal.env</SecretsLink>.
                </p>
              </>
            )}
          </Panel>

          <Panel title="Make it public">
            <div className="grid gap-3">
              <p className="text-pretty text-muted-foreground">
                Public isn't a sharing mode: it means turning the portal off for {site.slug}. Anyone with the address
                then gets in, and its app is told nobody: any{" "}
                <code className="font-mono text-xs">X-Sitesolide-*</code> header a visitor sends is taken off before it.
              </p>
              <div>
                <AccessLink slug={site.slug}>Open Access</AccessLink>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  )
}

/**
 * Who may open a site with their work account, under `/site/sharing/?s=<slug>`:
 * the mode, the people, the domains, the line to send, the admins who always
 * get in, and the way to Access for a public site. Like Guests, it needs the
 * portal in place, and says so with the way to Access when it is not.
 */
export function SharingSection({ slug }: { slug: string }) {
  const { read, setRead, reload } = useSharing()
  return (
    <SitePage slug={slug} section="sharing" skeleton={<PanelSkeleton lines={4} />}>
      {(site) => (
        <Content
          site={site}
          read={read}
          onSaved={(list) => setRead({ state: "ready", list })}
          onRetry={() => void reload(true)}
        />
      )}
    </SitePage>
  )
}
