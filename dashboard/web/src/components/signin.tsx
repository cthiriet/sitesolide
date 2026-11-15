import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Eye, EyeOff, KeyRound, LogIn } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Logo } from "@/components/logo"
import { FormError } from "@/components/page"
import { ThemeToggleButton } from "@/components/theme"
import { readSession, signIn } from "@/lib/api"
import { signInFailure, signInUrl } from "@/lib/identity"
import { waitMessage, signInRefusal } from "@/lib/signin"
import type { PasskeyOffer, SsoOffer } from "@/lib/types"
import { cn } from "@/lib/utils"
import { ceremonyMessage, linkFromHash, passkeysSupported, registerPasskey, signInWithPasskey } from "@/lib/webauthn"

const NO_PASSKEY: PasskeyOffer = { registered: false, passwordSignIn: true }

/** What the owner does with no passkey left: the steward's link, minted by root. */
const RECOVERY = "Lost your passkeys? Run sitesolide passkey link on your workstation for a one-time link."

const NO_HASH = "Sign-in is disabled: no password hash is configured on the server."

/**
 * The card's field and buttons, at the portal's size: 44 px and 12 px
 * corners; a button's label at 15 px, the field keeping the 16 px below which
 * a phone zooms in on focus.
 */
const CONTROL = "h-11 rounded-[0.75rem]"
const BUTTON = cn(CONTROL, "text-[0.9375rem]")

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
 * The dashboard's sign-in. Full page on opening; as an overlay when the session
 * expired while the page is open, so that nothing underneath is lost, starting
 * with a password that is only shown once.
 *
 * The ways in: a person signs in with the portal's identity provider, a link
 * and not a form, since the flow leaves for the portal's own host; the owner
 * with a passkey once they hold one, the dashboard's password until then. A
 * sign-in with the provider that came back without a session says why, from
 * the address (`?signin=`). Root's one-time link, `#passkey=`, registers the
 * owner's passkey and signs them in.
 */
export function SignIn({
  configured,
  sso = { offered: false, providerName: null },
  zone = null,
  passkeys: given,
  message = "",
  overlay = false,
  onOpened,
}: {
  configured: boolean
  sso?: SsoOffer
  /** The zone the server serves, under the title: which server the password goes to, before it is typed. */
  zone?: string | null
  /** Whether the owner holds a passkey; absent, asked of /api/session. */
  passkeys?: PasskeyOffer
  message?: string
  overlay?: boolean
  onOpened: () => void
}) {
  const [ssoFailure] = useState(() => signInFailure(new URLSearchParams(window.location.search).get("signin")))
  const [link, setLink] = useState(() => linkFromHash(window.location.hash))
  const [fetched, setFetched] = useState<PasskeyOffer | null>(null)
  const passkeys = given ?? fetched ?? NO_PASSKEY
  // The password form, until the owner holds a passkey; with no hash it says sign-in is disabled.
  const showPassword = link === null && (!passkeys.registered || passkeys.passwordSignIn)
  useEffect(() => {
    if (given !== undefined) return
    void readSession().then(({ body }) => {
      if (body?.passkeys !== undefined) setFetched(body.passkeys)
    })
  }, [given])
  const [passkeyError, setPasskeyError] = useState("")
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [deviceName, setDeviceName] = useState("")
  const nameId = useId()

  async function passkeySignIn() {
    if (passkeyBusy) return
    setPasskeyBusy(true)
    setPasskeyError("")
    try {
      const result = await signInWithPasskey()
      if (result.ok) return onOpened()
      setPasskeyError(ceremonyMessage(result.status, result.body))
    } finally {
      setPasskeyBusy(false)
    }
  }

  async function registerWithLink(event: SyntheticEvent) {
    event.preventDefault()
    if (passkeyBusy || link === null) return
    setPasskeyBusy(true)
    setPasskeyError("")
    try {
      const result = await registerPasskey(deviceName.trim() === "" ? "Passkey" : deviceName.trim(), link)
      if (result.ok) {
        // The link is spent: out of the address, so that a reload does not offer it again.
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
        setLink(null)
        return onOpened()
      }
      setPasskeyError(ceremonyMessage(result.status, result.body))
    } finally {
      setPasskeyBusy(false)
    }
  }
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

  // The portal's sign-in card, which a visitor meets in front of a restricted
  // site (portal/src/page.ts): a page read once, so the landing page's panel
  // radius, 24 px, and its 44 px controls with their 12 px corners, where the
  // rest of the dashboard keeps its denser 14 px panels and small buttons.
  const card = (
    <div className="grid w-full max-w-xs justify-items-center gap-6">
      <div className="flex items-center gap-3">
        <Logo className="size-9" />
        {overlay ? (
          <p className="text-title font-semibold">sitesolide</p>
        ) : (
          <h1 className="text-title font-semibold">sitesolide</h1>
        )}
      </div>

      <Card className="w-full rounded-3xl py-6 [--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle id={titleId} className="text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
            Sign in
          </CardTitle>
          {zone !== null ? (
            <CardDescription className="font-mono text-[0.8125rem] wrap-anywhere">{zone}</CardDescription>
          ) : (
            <CardDescription>Server dashboard</CardDescription>
          )}
          {message !== "" && <p className="pt-1 text-sm text-pretty">{message}</p>}
        </CardHeader>
        <CardContent className="grid gap-4">
          {ssoFailure !== null && (
            <p role="alert" className="text-sm text-pretty text-destructive">
              {ssoFailure}
            </p>
          )}
          {link !== null && (
            <form noValidate onSubmit={registerWithLink} className="grid gap-3">
              <p className="text-sm text-pretty">Register a passkey on this device with the one-time link from your server. It signs you in as the owner.</p>
              <div className="grid gap-2">
                <Label htmlFor={nameId}>Name this passkey</Label>
                <Input id={nameId} value={deviceName} maxLength={60} placeholder="Laptop" onChange={(event) => setDeviceName(event.target.value)} className={CONTROL} />
              </div>
              <Button type="submit" disabled={passkeyBusy || !passkeysSupported()} className={cn(BUTTON, "w-full")}>
                <KeyRound />
                {passkeyBusy ? "Waiting for the passkey…" : "Register a passkey"}
              </Button>
              {!passkeysSupported() && <p className="text-sm text-muted-foreground">This browser doesn't offer passkeys.</p>}
              <FormError>{passkeyError}</FormError>
            </form>
          )}
          {link === null && passkeys.registered && (
            <div className="grid gap-2">
              <Button type="button" onClick={() => void passkeySignIn()} disabled={passkeyBusy || !passkeysSupported()} className={cn(BUTTON, "w-full")}>
                <KeyRound />
                {passkeyBusy ? "Waiting for the passkey…" : "Sign in with a passkey"}
              </Button>
              <FormError>{passkeyError}</FormError>
              {!passkeys.passwordSignIn && !sso.offered && <p className="text-xs text-pretty text-muted-foreground">{RECOVERY}</p>}
            </div>
          )}
          {sso.offered && (
            <>
              <a href={signInUrl(currentReturn())} className={cn(buttonVariants({ variant: "outline" }), BUTTON, "w-full [&_svg]:text-signin-ink")}>
                <LogIn />
                Sign in with {sso.providerName ?? "your company account"}
              </a>
              {showPassword && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  or with the owner's password
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                </div>
              )}
            </>
          )}
          {passkeys.registered && !passkeys.passwordSignIn && sso.offered && <p className="text-xs text-pretty text-muted-foreground">{RECOVERY}</p>}
          {showPassword && <form noValidate onSubmit={submit} className="grid gap-4">
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
                  className={cn(CONTROL, "pr-11")}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={!configured}
                  aria-label={visible ? "Hide password" : "Show password"}
                  onClick={() => setVisible((before) => !before)}
                  className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2 text-muted-foreground after:absolute after:-inset-1.5 hover:text-foreground"
                >
                  {visible ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <FormError id={errorId}>{errorText}</FormError>
              {!configured && <p className="text-sm text-muted-foreground">{NO_HASH}</p>}
            </div>

            <Button
              type="submit"
              disabled={!configured || inProgress || remainingS > 0}
              className={cn(BUTTON, "w-full tabular-nums")}
            >
              {buttonLabel}
            </Button>
          </form>}
        </CardContent>
      </Card>
    </div>
  )

  // Discreet, in the corner of the screen. It comes after the card in the
  // document, so last for the keyboard: the password field stays the first
  // stop. In the overlay it sits inside the dialog, the page below being
  // inert.
  const themeToggle = <ThemeToggleButton className="absolute top-3 right-3 size-11 text-muted-foreground" />

  if (overlay) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-background/70 p-6 backdrop-blur-sm"
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
