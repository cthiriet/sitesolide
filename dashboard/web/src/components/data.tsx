import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { SignIn } from "@/components/signin"
import { UnreachableScreen } from "@/components/page"
import { signOut as postSignOut, readState, readGuests, readSecrets, readSession } from "@/lib/api"
import { currentAge } from "@/lib/format"
import { loadFailureReason } from "@/lib/invitations"
import type { Guest } from "@/lib/guests"
import {
  UNREACHABLE,
  clockOffset,
  refusalOf,
  secretsBySite,
  sortProjects,
  type SiteSecretsPanel,
} from "@/lib/secrets"
import type { Snapshot, Reading, ProjectView } from "@/lib/types"
import { NO_DATA, verdict as judge, type Verdict } from "@/lib/verdict"

/**
 * The data of every page, read once above them: moving from one page to another
 * reads nothing again, and the sidebar counts what the pages show.
 *
 * The reads live here; the writes stay in the pages that make them (secrets,
 * guests), which call `reload()` afterwards.
 */

/** The page refreshes twice a minute, the collector reading once. */
const REFRESH_MS = 30_000

/** The displayed ages move on without waiting for the next snapshot. */
const CLOCK_MS = 10_000

/**
 * A dashboard unreachable on opening retries by itself: it may be restarting,
 * after a password change or a restart asked for from its own secrets, and
 * comes back in a few seconds.
 */
const UNREACHABLE_RETRY_MS = 5_000

// --- The secrets -----------------------------------------------------------------

/**
 * What the page knows of the secrets, shared between a site's sections, the
 * sidebar and the home page. Names and states, never a value: a value only
 * lives in the row that displays it.
 */
export type SecretsData = {
  /** null before the first successful load. */
  projects: ProjectView[] | null
  /** End of the unlock, on the server's clock. */
  until: number | null
  /** What the banner says when the last read failed. */
  problem: string | null
  reload: () => Promise<void>
  setUnlockedUntil: (until: number | null) => void
  reportUnreachable: () => void
}

/**
 * The secrets, read on opening, on every snapshot received, and after every
 * action. A failure keeps the data already there and raises the banner. A read
 * asked for while another is in flight follows it instead of being lost: an
 * action that has just written must see its effect.
 */
export function useSecrets(generation: number, onSessionExpired: () => void): SecretsData {
  const [projects, setProjects] = useState<ProjectView[] | null>(null)
  const [until, setUnlockedUntil] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const encore = useRef(false)

  const reload = useCallback((): Promise<void> => {
    if (inFlight.current !== null) {
      encore.current = true
      return inFlight.current
    }
    const tache = (async () => {
      try {
        do {
          encore.current = false
          const { status, body } = await readSecrets()
          if (status === 200 && body !== null && Array.isArray(body.projects)) {
            setProjects(sortProjects(body.projects))
            setUnlockedUntil(typeof body.until === "number" ? body.until : null)
            setProblem(null)
            continue
          }
          const refusal = refusalOf(status, body)
          if (refusal.kind === "session") {
            onSessionExpired()
            break
          }
          if (refusal.kind === "locked") setUnlockedUntil(null)
          else setProblem(refusal.message)
        } while (encore.current)
      } finally {
        inFlight.current = null
      }
    })()
    inFlight.current = tache
    return tache
  }, [onSessionExpired])

  useEffect(() => {
    void reload()
  }, [reload, generation])

  const reportUnreachable = useCallback(() => setProblem(UNREACHABLE), [])

  return useMemo(
    () => ({ projects, until, problem, reload, setUnlockedUntil: setUnlockedUntil, reportUnreachable }),
    [projects, until, problem, reload, reportUnreachable],
  )
}

// --- The guest accesses ----------------------------------------------------------

export type GuestList =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; guests: Guest[] }

export type GuestsData = {
  list: GuestList
  /** Reads the list again. `showLoading` goes back to the skeleton first, for a "Retry". */
  reload: (options?: { showLoading?: boolean }) => Promise<void>
}

/**
 * The guest accesses, read again with every snapshot: a guest's last visit
 * moves while the page stays open. A failure after a successful read replaces
 * the list with its reason: a stale list of accesses would suggest that an
 * access revoked elsewhere still opens.
 */
export function useGuests(generation: number, onSessionExpired: () => void): GuestsData {
  const [list, setList] = useState<GuestList>({ state: "loading" })

  const reload = useCallback(
    async (options: { showLoading?: boolean } = {}) => {
      if (options.showLoading === true) setList({ state: "loading" })
      const { status, body } = await readGuests()
      if (status === 401) return onSessionExpired()
      if (status === 200 && body !== null && Array.isArray(body.guests)) {
        return setList({ state: "ready", guests: body.guests })
      }
      setList({ state: "error", message: loadFailureReason(status) })
    },
    [onSessionExpired],
  )

  useEffect(() => {
    void reload()
  }, [reload, generation])

  return useMemo(() => ({ list, reload }), [list, reload])
}

// --- The context -----------------------------------------------------------------

export type Data = {
  /** The last valid snapshot received, null before the first one. */
  reading: Reading | null
  /** `reading.snapshot` when it is present, null otherwise. */
  snapshot: Snapshot | null
  receivedAt: number | null
  /** The browser's clock, which moves on every ten seconds. */
  now: number
  /** The snapshot's current age, in milliseconds. */
  age: number | null
  verdict: Verdict
  /** The last read failed; the displayed data stays the previous one. */
  failure: boolean
  inProgress: boolean
  /** Changes with every snapshot received. */
  generation: number
  /** How far the server's clock runs ahead of the browser's. */
  offset: number
  refresh: () => void
  secrets: SecretsData
  secretsBySite: ReadonlyMap<string, SiteSecretsPanel>
  guests: GuestsData
  /** To be called on a 401: the sign-in comes over the top of the page, losing nothing. */
  sessionExpired: () => void
  signOut: () => void
}

const DataContext = createContext<Data | null>(null)

export function useData(): Data {
  const data = useContext(DataContext)
  if (data === null) throw new Error("useData used outside DataProvider")
  return data
}

/** The last valid snapshot, and the time it was received, from which the displayed age follows. */
type Received = { reading: Reading; receivedAt: number }

/**
 * An open session: the snapshot, its cadence, the secrets and the guests.
 * Unmounted on sign-out, and everything it held with it.
 */
function OpenSession({
  configured,
  onClosed,
  children,
}: {
  configured: boolean
  onClosed: (configured: boolean) => void
  children: ReactNode
}) {
  const [received, setReceived] = useState<Received | null>(null)
  const [failure, setFailed] = useState(false)
  const [inProgress, setEnCours] = useState(false)
  const [expired, setExpired] = useState(false)
  const [currentConfigured, setConfigured] = useState(configured)
  const [generation, setGeneration] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const inFlight = useRef(false)

  /**
   * Reads the snapshot again. A failure never touches the data already
   * displayed: it raises a flag, which the page shows as a banner. One call at
   * a time, `focus` and `visibilitychange` arriving together when you come back
   * to the tab.
   */
  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setEnCours(true)
    try {
      const { status, body } = await readState()
      // 401: session expired or closed elsewhere, including by a password
      // rotation. The sign-in comes over the top of the page instead of
      // replaying a refused request forever.
      if (status === 401) return setExpired(true)
      if (status !== 200 || body === null) return setFailed(true)
      const receivedAt = Date.now()
      setReceived({ reading: body, receivedAt })
      setNow(receivedAt)
      setFailed(false)
      setGeneration((before) => before + 1)
    } finally {
      inFlight.current = false
      setEnCours(false)
    }
  }, [])

  // A read straight away, then every thirty seconds as long as the tab is
  // visible, and on every return: tab brought back to the front, window
  // regaining focus, network recovered. Nothing while the sign-in is being
  // asked for.
  useEffect(() => {
    if (expired) return
    void refresh()
    const reread = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    const timer = window.setInterval(reread, REFRESH_MS)
    document.addEventListener("visibilitychange", reread)
    window.addEventListener("focus", reread)
    window.addEventListener("online", reread)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", reread)
      window.removeEventListener("focus", reread)
      window.removeEventListener("online", reread)
    }
  }, [expired, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => window.clearInterval(timer)
  }, [])

  // A session that has gone is checked again: the form needs to know whether a
  // hash is configured, and a lone 401 must not keep the page closed.
  useEffect(() => {
    if (!expired) return
    void readSession().then(({ body }) => {
      if (body === null) return
      setConfigured(body.configured)
      if (body.open) setExpired(false)
    })
  }, [expired])

  const sessionExpired = useCallback(() => setExpired(true), [])

  const signOut = useCallback(() => {
    void postSignOut().then(() => onClosed(currentConfigured))
  }, [onClosed, currentConfigured])

  const secrets = useSecrets(generation, sessionExpired)
  const guests = useGuests(generation, sessionExpired)
  const bySite = useMemo(() => secretsBySite(secrets.projects), [secrets.projects])

  const reading = received?.reading ?? null
  const receivedAt = received?.receivedAt ?? null
  const value = useMemo<Data>(() => {
    const present = reading !== null && reading.present ? reading : null
    return {
      reading,
      snapshot: present?.snapshot ?? null,
      receivedAt,
      now,
      age: present !== null && receivedAt !== null ? currentAge(present.age, receivedAt, now) : null,
      verdict: present !== null ? judge(present.snapshot.discrepancies, present.stale) : NO_DATA,
      failure,
      inProgress,
      generation,
      offset: present !== null && receivedAt !== null ? clockOffset(present.snapshot.generated, present.age, receivedAt) : 0,
      refresh: () => void refresh(),
      secrets,
      secretsBySite: bySite,
      guests,
      sessionExpired,
      signOut,
    }
  }, [reading, receivedAt, now, failure, inProgress, generation, refresh, secrets, bySite, guests, sessionExpired, signOut])

  const open = useCallback(() => setExpired(false), [])

  // With nothing to preserve, the sign-in takes the whole page.
  if (received === null && expired) {
    return <SignIn configured={currentConfigured} message="Your session expired. Sign in again." onOpened={open} />
  }

  return (
    <DataContext.Provider value={value}>
      {/* `inert` under the overlay: neither the keyboard nor a screen reader should reach the page. */}
      <div inert={expired}>{children}</div>
      {expired && (
        <SignIn
          superposition
          configured={currentConfigured}
          message="Your session expired. Sign in again to pick up where you left off."
          onOpened={open}
        />
      )}
    </DataContext.Provider>
  )
}

type Session =
  | { state: "verification" }
  | { state: "unreachable" }
  | { state: "closed"; configured: boolean }
  | { state: "open"; configured: boolean }

/**
 * The gate to the data: the session is checked, the sign-in is asked for, then
 * the pages receive the context. `wait` is shown during the check, and it is
 * also what the build renders into the HTML.
 */
export function DataProvider({ wait, children }: { wait: ReactNode; children: ReactNode }) {
  const [session, setSession] = useState<Session>({ state: "verification" })

  const check = useCallback(async (quiet = false) => {
    if (!quiet) setSession({ state: "verification" })
    const { status, body } = await readSession()
    if (status !== 200 || body === null) return setSession({ state: "unreachable" })
    setSession(body.open ? { state: "open", configured: body.configured } : { state: "closed", configured: body.configured })
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  // When unreachable, the check restarts by itself, without going back to the
  // skeleton: the screen stays readable and its button stays usable.
  const unreachable = session.state === "unreachable"
  useEffect(() => {
    if (!unreachable) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check(true)
    }, UNREACHABLE_RETRY_MS)
    return () => window.clearInterval(timer)
  }, [unreachable, check])

  const closed = useCallback((configured: boolean) => setSession({ state: "closed", configured }), [])

  switch (session.state) {
    case "verification":
      return wait
    case "unreachable":
      return <UnreachableScreen onRetry={() => void check()} />
    case "closed":
      return (
        <SignIn
          configured={session.configured}
          onOpened={() => setSession({ state: "open", configured: session.configured })}
        />
      )
    case "open":
      return (
        <OpenSession configured={session.configured} onClosed={closed}>
          {children}
        </OpenSession>
      )
  }
}
