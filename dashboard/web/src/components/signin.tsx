import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Logo } from "@/components/logo"
import { ThemeToggleButton } from "@/components/theme"
import { signIn } from "@/lib/api"
import { waitMessage, signInRefusal } from "@/lib/signin"
import { cn } from "@/lib/utils"

const NO_HASH = "Sign-in is disabled: no password hash is configured on the server."

/**
 * The dashboard's door. Full page on opening; as an overlay when the session
 * expired while the page is open, so that nothing underneath is lost, starting
 * with a guest password that is only shown once.
 */
export function SignIn({
  configured,
  message = "",
  superposition = false,
  onOpened,
}: {
  configured: boolean
  message?: string
  superposition?: boolean
  onOpened: () => void
}) {
  const titleId = useId()
  const fieldId = useId()
  const errorId = useId()
  const field = useRef<HTMLInputElement>(null)

  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)
  // The opening message, an expired session for instance, is not an input
  // error: it replaces the subtitle, without marking the field as faulty.
  const [error, setError] = useState("")
  const [inProgress, setEnCours] = useState(false)
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const restantS = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - now) / 1000))

  // The rate limit countdown, second by second, down to zero.
  useEffect(() => {
    if (waitUntil === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waitUntil])

  useEffect(() => {
    if (waitUntil === null || restantS > 0) return
    setWaitUntil(null)
    setError("")
    field.current?.focus()
  }, [waitUntil, restantS])

  // SyntheticEvent and not FormEvent: React 19's types deprecate the latter,
  // and bin/deprecations.ts reports exactly that diagnostic.
  async function submit(event: SyntheticEvent) {
    event.preventDefault()
    if (!configured || inProgress || restantS > 0) return
    if (password === "") {
      setError("Enter the password.")
      return field.current?.focus()
    }

    setEnCours(true)
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
      setEnCours(false)
    }
  }

  const errorText = configured ? error : ""
  const buttonLabel = inProgress ? "Signing in…" : restantS > 0 ? waitMessage(restantS) : "Sign in"

  const carte = (
    <div className="grid w-full max-w-xs justify-items-center gap-6">
      <div className="flex items-center gap-3">
        <Logo className="size-9" />
        {superposition ? (
          <p className="font-display text-xl font-semibold tracking-tight">sitesolide</p>
        ) : (
          <h1 className="font-display text-xl font-semibold tracking-tight">sitesolide</h1>
        )}
      </div>

      <Card className="w-full rounded-xl py-5 shadow-none ring-border">
        <CardHeader>
          <CardTitle id={titleId} className="font-display text-lg font-semibold tracking-tight">
            Sign in
          </CardTitle>
          <CardDescription>{message !== "" ? message : "Server dashboard"}</CardDescription>
        </CardHeader>
        <CardContent>
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
              disabled={!configured || inProgress || restantS > 0}
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

  if (superposition) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn("fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-background/70 p-6 backdrop-blur-sm")}
      >
        {carte}
        {themeToggle}
      </div>
    )
  }

  return (
    <main className="relative grid min-h-svh place-items-center bg-background p-6">
      {carte}
      {themeToggle}
    </main>
  )
}
