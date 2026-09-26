import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react"
import { plainClick, readAddress, redirect, type Page, type SearchParams } from "@/lib/pages"

/**
 * Navigation between pages, with no reload: the data already read stays in
 * memory, and the next page appears at once.
 *
 * The browser's address is the only source of the current page. It is read
 * through `useSyncExternalStore`, subscribed to `popstate` (back, forward) and
 * to the navigations made here. At build time, and therefore at hydration, the
 * page is the one of the served file, with no query: `/site/secrets/?s=cms`
 * hydrates on `/site/secrets/`, then React reads the address again, with no
 * hydration mismatch.
 *
 * An older address, `/sites/?site=cms`, already reads as the new one; an effect
 * then replaces the browser's address, without adding a history entry.
 */

export type Navigation = {
  page: Page
  /** The current query's parameters, `?s=cms`. */
  params: SearchParams
  /** True when the current page comes from a back or a forward, whose scroll the browser restores. */
  fromHistory: boolean
  navigate: (href: string, options?: { replace?: boolean }) => void
}

const NavigationContext = createContext<Navigation | null>(null)

const listeners = new Set<() => void>()
let fromHistory = false

function notify() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  const handlePopstate = () => {
    fromHistory = true
    listener()
  }
  listeners.add(listener)
  window.addEventListener("popstate", handlePopstate)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("popstate", handlePopstate)
  }
}

const currentAddress = () => window.location.pathname + window.location.search

export function Router({ path, children }: { path: string; children: ReactNode }) {
  const address = useSyncExternalStore(subscribe, currentAddress, () => path)

  const navigate = useCallback((href: string, options: { replace?: boolean } = {}) => {
    const target = new URL(href, window.location.href)
    if (target.origin !== window.location.origin) {
      window.location.assign(target)
      return
    }
    const nextUrl = target.pathname + target.search + target.hash
    const currentPath = window.location.pathname + window.location.search + window.location.hash
    if (nextUrl !== currentPath) {
      if (options.replace === true) window.history.replaceState(null, "", nextUrl)
      else window.history.pushState(null, "", nextUrl)
    }
    fromHistory = false
    notify()
  }, [])

  // Read in the effect, not in the render: at hydration, `address` is still
  // the served file's, without its query.
  useEffect(() => {
    const target = redirect(window.location.pathname, window.location.search)
    if (target !== null) navigate(target, { replace: true })
  }, [address, navigate])

  const value = useMemo<Navigation>(
    () => ({ ...readAddress(address), fromHistory: fromHistory, navigate }),
    [address, navigate],
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext)
  if (navigation === null) throw new Error("useNavigation used outside Router")
  return navigation
}

/**
 * A link to another dashboard page. A real `<a href>`: middle click, Cmd+click
 * and "Open in a new tab" do what they do everywhere. Only the plain click
 * stays inside the page.
 */
export function InternalLink({ href, onClick, target, ...props }: ComponentProps<"a"> & { href: string }) {
  const { navigate } = useNavigation()
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (!plainClick(event, target ?? null)) return
    event.preventDefault()
    navigate(href)
  }
  return <a href={href} target={target} onClick={handleClick} {...props} />
}
