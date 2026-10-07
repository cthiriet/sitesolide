import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Eye, EyeOff, LogIn } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Logo } from "@/components/logo"
import { ThemeToggleButton } from "@/components/theme"
import { signIn } from "@/lib/api"
import { signInFailure, signInUrl } from "@/lib/members"
import { waitMessage, signInRefusal } from "@/lib/signin"
import type { SsoOffer } from "@/lib/types"
import { cn } from "@/lib/utils"

const NO_HASH = "Sign-in is disabled: no password hash is configured on the server."

/**
 * The address to come back to after the provider: this page, without the
 * reason a previous attempt left in it.
 */
function currentReturn(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete("signin")
  return `${url.pathname}${url.search}`
}

/**
 * The dashboard's door. Full page on opening; as an overlay when the session
 * expired while the page is open, so that nothing underneath is lost, starting
 * with a guest password that is only shown once.
 *
 * Two ways in: a member signs in with the portal's identity provider, a link
 * and not a form, since the flow leaves for the portal's own host; the owner
 * types the dashboard's password. A sign-in with the provider that came back
 * without a session says why, from the address (`?signin=`).
 */
export function SignIn({
  configured,
  sso = { offered: false, providerName: null },
  message = "",
  overlay = false,
  onOpened,
}: {
  configured: boolean
  sso?: SsoOffer
  message?: string
  overlay?: boolean
  onOpened: () => void
}) {
  const [ssoFailure] = useState(() => signInFailure(new URLSearchParams(window.location.search).get("signin")))
  const titleId = useId()
  const fieldId = useId()
  const errorId = useId()
  const field = useRef<HTMLInputElement>(null)

  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)
  // The opening message, an expired session for instance, is not an input
  // error: it replaces the subtitle, without marking the field as faulty.
  const [error, setError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const remainingS = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - now) / 1000))

  // The rate limit countdown, second by second, down to zero.
  useEffect(() => {
    if (waitUntil === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waitUntil])

  useEffect(() => {
    if (waitUntil === null || remainingS > 0) return
    setWaitUntil(null)
    setError("")
    field.current?.focus()
  }, [waitUntil, remainingS])

  // SyntheticEvent and not FormEvent: React 19's types deprecate the latter,
  // and bin/deprecations.ts reports exactly that diagnostic.
  async function submit(event: SyntheticEvent) {
    event.preventDefault()
    if (!configured || inProgress || remainingS > 0) return
    if (password === "") {
      setError("Enter the password.")
      return field.current?.focus()
    }

    setInProgress(true)
    setError("")
    try {
      const { status, body } = await signIn(password)
      if (status === 200) {
        setPassword("")
        return onOpened()
      }
      const refusal = signInRefusal(status, body)
      if (refusal.waitS > 0) {
        const start = Date.now()
        setNow(start)
        setWaitUntil(start + refusal.waitS * 1000)
      }
      if (status === 401) setPassword("")
      setError(refusal.message)
      field.current?.focus()
    } finally {
      setInProgress(false)
    }
  }

  const errorText = configured ? error : ""
  const buttonLabel = inProgress ? "Signing in…" : remainingS > 0 ? waitMessage(remainingS) : "Sign in"

  const card = (
    <div className="grid w-full max-w-xs justify-items-center gap-6">
      <div className="flex items-center gap-3">
        <Logo className="size-9" />
        {overlay ? (
          <p className="text-xl font-semibold tracking-title">sitesolide</p>
        ) : (
          <h1 className="text-xl font-semibold tracking-title">sitesolide</h1>
        )}
      </div>

      <Card className="w-full rounded-xl py-5 shadow-none ring-border">
        <CardHeader>
          <CardTitle id={titleId} className="text-lg font-semibold tracking-title">
            Sign in
          </CardTitle>
          <CardDescription>{message !== "" ? message : "Server dashboard"}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {ssoFailure !== null && (
            <p role="alert" className="text-sm text-pretty text-destructive">
              {ssoFailure}
            </p>
          )}
          {sso.offered && (
            <>
              <a href={signInUrl(currentReturn())} className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
                <LogIn />
                Sign in with {sso.providerName ?? "your work account"}
              </a>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                or with the owner's password
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          <form noValidate onSubmit={submit} className="grid gap-4">
            {/* For password managers, which file a username with every secret. */}
            <input type="text" name="username" autoComplete="username" value="sitesolide" readOnly hidden />

            <div className="grid gap-2">
              <Label htmlFor={fieldId}>Password</Label>
              <div className="relative">
                <Input
                  ref={field}
                  id={fieldId}
                  name="password"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  autoFocus
                  disabled={!configured}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={errorText !== "" || undefined}
                  aria-describedby={errorText !== "" ? errorId : undefined}
                  className="h-10 pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!configured}
                  aria-label={visible ? "Hide password" : "Show password"}
                  onClick={() => setVisible((before) => !before)}
                  className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {visible ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {errorText !== "" && (
                <p id={errorId} role="alert" className="text-sm text-destructive">
                  {errorText}
                </p>
              )}
              {!configured && <p className="text-sm text-muted-foreground">{NO_HASH}</p>}
            </div>

            <Button
              type="submit"
              disabled={!configured || inProgress || remainingS > 0}
              className="h-10 w-full tabular-nums"
            >
              {buttonLabel}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )

  // Discreet, in the corner of the screen. It comes after the card in the
  // document, so last for the keyboard: the password field stays the first
  // stop. In the overlay it sits inside the dialog, the page below being
  // inert.
  const themeToggle = <ThemeToggleButton className="absolute top-3 right-3 size-10 text-muted-foreground" />

  if (overlay) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn("fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-background/70 p-6 backdrop-blur-sm")}
      >
        {card}
        {themeToggle}
      </div>
    )
  }

  return (
    <main className="relative grid min-h-svh place-items-center bg-background p-6">
      {card}
      {themeToggle}
    </main>
  )
}
