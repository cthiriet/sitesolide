import { useSyncExternalStore } from "react"
import { Moon, Sun, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  NO_TRANSITION_CLASS,
  applyTheme,
  themeButton,
  storeChoice,
  themeFromRoot,
  nextTheme,
  type Theme,
} from "@/lib/theme"

/**
 * Every button reads the class on <html>, not a React state: the inline script
 * in layouts/main.astro sets it before the first render, then changes it when
 * the system or another tab changes, knowing nothing about React. An observe
 * on that attribute is enough to keep the header, the sign-in page and its
 * overlay in agreement.
 */
function subscribe(notify: () => void) {
  const observe = new MutationObserver(notify)
  observe.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observe.disconnect()
}

const currentTheme = (): Theme => themeFromRoot(document.documentElement.classList)

// The page is built without a document. The button is never rendered there,
// the session being checked first, but React wants a value for that case.
const buildTheme = (): Theme => "light"

function toggle() {
  const root = document.documentElement
  const next = nextTheme(themeFromRoot(root.classList))
  // A storage that refuses does not prevent the switch: it will only hold for this page.
  storeChoice(() => window.localStorage, next)
  root.classList.add(NO_TRANSITION_CLASS)
  applyTheme(root, next)
  // The read forces the styles to be computed while the transitions are cut
  // off: the colours are already the new ones when the class goes away, so its
  // removal animates nothing.
  void root.offsetHeight
  root.classList.remove(NO_TRANSITION_CLASS)
}

/**
 * The current theme, and what a toggle control should display: the sidebar and
 * the mobile menu make a menu row of it, the sign-in page a button.
 */
export function useTheme(): { theme: Theme; label: string; Icon: LucideIcon; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, buildTheme)
  const { icon, label } = themeButton(theme)
  return { theme, label, Icon: icon === "sun" ? Sun : Moon, toggle }
}

export function ThemeToggleButton({ className }: { className?: string }) {
  const { label, Icon, toggle: handleClick } = useTheme()
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} onClick={handleClick} className={className}>
      <Icon />
    </Button>
  )
}
