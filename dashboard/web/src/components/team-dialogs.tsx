import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import { Check, Copy } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Command, CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { Banner, INPUT_DIALOG } from "@/components/page"
import { createTeamToken } from "@/lib/api"
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_CHOICES,
  expiryFrom,
  firstTokenField,
  invitationText,
  loginCommand,
  mintableProjects,
  optionsAllowed,
  parseSlugs,
  tokenRefusal,
  validateMemberTokenForm,
  validateTokenForm,
  type TokenErrors,
  type TokenField,
} from "@/lib/team"
import { roleLabel } from "@/lib/members"
import type { Roles, Scope, TokenView } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The Team page's two dialogs: creating a token, up to the screen that shows
 * it once, and confirming a revocation.
 *
 * Creating needs the dashboard unlocked, as reading a secret does: the page
 * asks for the password first, and a 423 from the service closes this dialog
 * and asks again, the steward having forgotten the unlock.
 *
 * A member creates their own: no email, theirs is the token's; the projects
 * where they are a Developer or a Project admin to choose from; creating
 * projects only with the right the super admin granted them; and the options
 * only for projects they administer. The steward judges it all again.
 */

const COPY_WARNING = "You haven't copied the token. It can't be shown again."

function Field({ id, labelText, help, error, children }: { id: string; labelText: string; help?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{labelText}</Label>
      {children}
      {error !== undefined ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        help !== undefined && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        )
      )}
    </div>
  )
}

/** One permission: a checkbox, what it allows, and what it costs. */
function Permission({
  checked,
  onChange,
  title,
  disabled = false,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  title: string
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-lg border border-input px-3 py-2.5 transition-colors select-none has-checked:border-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-foreground"
      />
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-pretty text-muted-foreground">{children}</span>
      </span>
    </label>
  )
}

export type CreatedToken = { token: TokenView; secret: string }

export function CreateTokenDialog({
  open,
  origin,
  knownSlugs,
  member = null,
  now,
  onClose,
  onCreated,
  onLocked,
  onSessionExpired,
}: {
  open: boolean
  /** The dashboard's address, which the holder logs in to. */
  origin: string
  /** The projects on the machine, for the slugs granted. */
  knownSlugs: readonly string[]
  /** A member minting their own: their roles and the create right. Null for the owner. */
  member?: { roles: Roles; create: boolean } | null
  now: number
  onClose: () => void
  onCreated: () => void
  /** The steward forgot the unlock: close, and ask for the password again. */
  onLocked: () => void
  onSessionExpired: () => void
}) {
  const announce = useAnnounce()
  const [label, setLabel] = useState("")
  const [email, setEmail] = useState("")
  const [slugsText, setSlugsText] = useState("")
  const [expiry, setExpiry] = useState<number | null>(DEFAULT_EXPIRY_DAYS)
  const [scope, setScope] = useState<Omit<Scope, "slugs">>({ create: member === null, outbound: false, domain: false, public: false })
  const [chosen, setChosen] = useState<string[]>([])
  const mintable = member === null ? [] : mintableProjects(member.roles)
  const options = member === null || optionsAllowed(member.roles, chosen, scope.create)
  // A member's options fall as soon as their choice no longer allows them.
  const effective = options ? scope : { ...scope, outbound: false, domain: false, public: false }
  const [errors, setErrors] = useState<TokenErrors>({})
  const [formError, setFormError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [copied, setCopied] = useState(false)
  const [warned, setWarned] = useState(false)

  const labelField = useRef<HTMLInputElement>(null)
  const emailField = useRef<HTMLInputElement>(null)
  const slugsField = useRef<HTMLInputElement>(null)
  const labelId = useId()
  const emailId = useId()
  const slugsId = useId()
  const expiryId = useId()

  function focusField(field: TokenField) {
    ;({ label: labelField, email: emailField, slugs: slugsField })[field].current?.focus()
  }

  function askToClose() {
    if (inProgress) return
    if (created === null || copied || warned) return onClose()
    setWarned(true)
    announce(COPY_WARNING)
  }

  async function create(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return
    const slugs = member === null ? parseSlugs(slugsText) : chosen
    const faults = member === null ? validateTokenForm({ label, email, slugs }, knownSlugs) : validateMemberTokenForm({ label, slugs, create: effective.create })
    setErrors(faults)
    setFormError("")
    const first = firstTokenField(faults)
    if (first !== null) return focusField(first)

    setInProgress(true)
    try {
      // A member's token carries their own email: the steward writes it, whatever is sent.
      const { status, body } = await createTeamToken({ label: label.trim(), email: member === null ? email.trim() : "", expiresAt: expiryFrom(expiry, now), scope: { ...effective, slugs } })
      if (status === 401) {
        onClose()
        return onSessionExpired()
      }
      if (status === 423) {
        onClose()
        return onLocked()
      }
      if (status !== 201 || body === null || typeof body.secret !== "string") {
        const refusal = tokenRefusal(status, body)
        if (refusal.field === null) return setFormError(refusal.message)
        setErrors({ [refusal.field]: refusal.message })
        return focusField(refusal.field)
      }
      setCreated({ token: body.token, secret: body.secret })
      announce(`Token created for ${body.token.email}. Copy it now: it won't be shown again.`)
      onCreated()
    } finally {
      setInProgress(false)
    }
  }

  const describedby = (id: string, error: string | undefined) => (error !== undefined ? `${id}-error` : `${id}-help`)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) askToClose()
      }}
    >
      {/* Taller than a phone's screen with every permission: it scrolls within itself. */}
      <DialogContent className={cn("max-h-[calc(100svh-2rem)] gap-5 overflow-y-auto sm:max-w-xl", INPUT_DIALOG)} initialFocus={() => labelField.current}>
        {created === null ? (
          <form noValidate onSubmit={create} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>New token</DialogTitle>
              <DialogDescription className="text-pretty">
                {member === null
                  ? "One token per person or agent. It deploys over HTTPS, without SSH and without root, and only what you allow here. You can revoke it at any time."
                  : "A token of your own, for your CLI or an agent. It never does more than your roles: lowered, they narrow it at once, and you can revoke it at any time."}
              </DialogDescription>
            </DialogHeader>

            <div className={cn("grid gap-4", member === null && "sm:grid-cols-2")}>
              <Field id={labelId} labelText="For" error={errors.label} help="A name you will recognise: a person, a laptop, an agent.">
                <Input
                  ref={labelField}
                  id={labelId}
                  value={label}
                  maxLength={64}
                  autoComplete="off"
                  onChange={(event) => {
                    setLabel(event.target.value)
                    setErrors(({ label: _, ...rest }) => rest)
                  }}
                  aria-invalid={errors.label !== undefined || undefined}
                  aria-describedby={describedby(labelId, errors.label)}
                  className="h-10 sm:h-9"
                />
              </Field>
              {member === null && (
              <Field id={emailId} labelText="Email" error={errors.email} help="Recorded with every deployment it makes.">
                <Input
                  ref={emailField}
                  id={emailId}
                  type="email"
                  value={email}
                  autoComplete="off"
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setErrors(({ email: _, ...rest }) => rest)
                  }}
                  aria-invalid={errors.email !== undefined || undefined}
                  aria-describedby={describedby(emailId, errors.email)}
                  className="h-10 sm:h-9"
                />
              </Field>
              )}
            </div>

            {member !== null ? (
              <fieldset aria-describedby={errors.slugs !== undefined ? `${slugsId}-error` : `${slugsId}-help`}>
                <legend className="mb-2 text-sm leading-none font-medium">Projects it may deploy</legend>
                {mintable.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None of your projects: you are a viewer on each. It may still create projects.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {mintable.map(({ slug, role }) => (
                      <Permission
                        key={slug}
                        checked={chosen.includes(slug)}
                        onChange={(next) => {
                          setChosen((before) => (next ? [...before, slug] : before.filter((one) => one !== slug)))
                          setErrors(({ slugs: _, ...rest }) => rest)
                        }}
                        title={slug}
                      >
                        {roleLabel(role)} here
                      </Permission>
                    ))}
                  </div>
                )}
                {errors.slugs !== undefined ? (
                  <p id={`${slugsId}-error`} role="alert" className="mt-2 text-xs text-destructive">
                    {errors.slugs}
                  </p>
                ) : (
                  <p id={`${slugsId}-help`} className="mt-2 text-xs text-muted-foreground">
                    Where you are a developer or a project admin. A role lowered later stops it there.
                  </p>
                )}
              </fieldset>
            ) : (
            <Field
              id={slugsId}
              labelText="Existing projects it may deploy"
              error={errors.slugs}
              help="Slugs, separated by commas. Leave empty for a token that only deploys the projects it creates."
            >
              <Input
                ref={slugsField}
                id={slugsId}
                value={slugsText}
                autoComplete="off"
                placeholder="none"
                onChange={(event) => {
                  setSlugsText(event.target.value)
                  setErrors(({ slugs: _, ...rest }) => rest)
                }}
                aria-invalid={errors.slugs !== undefined || undefined}
                aria-describedby={describedby(slugsId, errors.slugs)}
                className="h-10 font-mono sm:h-9"
              />
            </Field>
            )}

            <fieldset>
              <legend className="mb-2 text-sm leading-none font-medium">It may also</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(member === null || member.create) && (
                  <Permission
                    checked={effective.create}
                    onChange={(next) => {
                      setScope({ ...scope, create: next })
                      setErrors(({ slugs: _, ...rest }) => rest)
                    }}
                    title="Create projects"
                  >
                    {member === null
                      ? "New slugs, behind the portal unless public sites are allowed. It deploys what it creates."
                      : "New slugs, behind the portal unless public sites are allowed. You become project admin of what it creates."}
                  </Permission>
                )}
                <Permission checked={effective.public} disabled={!options} onChange={(next) => setScope({ ...scope, public: next })} title="Deploy public sites">
                  Sites anyone can open, and paths exempted from the portal. Off: everything it deploys asks for a sign-in.
                </Permission>
                <Permission checked={effective.outbound} disabled={!options} onChange={(next) => setScope({ ...scope, outbound: next })} title="Use outbound network">
                  Services that call an outside API, openly or through the hosts they list. Off: they reach the loopback only, and the connectors you grant.
                </Permission>
                <Permission checked={effective.domain} disabled={!options} onChange={(next) => setScope({ ...scope, domain: next })} title="Declare a domain">
                  A customer domain in the manifest. Switching to it stays {member === null ? "yours" : "the owner's"}.
                </Permission>
              </div>
              {!options && (
                <p className="mt-2 text-xs text-muted-foreground">Public sites, outbound network and a domain are for projects you administer: choose only those.</p>
              )}
            </fieldset>

            <fieldset className="grid gap-2" aria-describedby={`${expiryId}-help`}>
              <legend className="mb-2 text-sm leading-none font-medium">Expires</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {EXPIRY_CHOICES.map((choice) => (
                  <label
                    key={choice.label}
                    className="flex h-10 cursor-pointer items-center justify-center rounded-lg border border-input px-2 text-sm whitespace-nowrap transition-colors select-none hover:bg-muted has-checked:border-foreground has-checked:bg-muted has-checked:font-medium has-checked:ring-1 has-checked:ring-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring sm:h-9"
                  >
                    <input type="radio" name={expiryId} checked={expiry === choice.days} onChange={() => setExpiry(choice.days)} className="sr-only" />
                    {choice.label}
                  </label>
                ))}
              </div>
              <p id={`${expiryId}-help`} className="text-xs text-muted-foreground">
                An expired token is refused like a revoked one.
              </p>
            </fieldset>

            {formError !== "" && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}

            <DialogFooter>
              <DialogClose render={<Button variant="outline" className="max-sm:h-10" />} disabled={inProgress}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={inProgress} className="max-sm:h-10">
                {inProgress ? "Creating…" : "Create token"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <TokenScreen created={created} origin={origin} warned={warned && !copied} onCopied={() => setCopied(true)} onDone={askToClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The token, shown once, and how its holder signs in. No live region: a screen
 * reader would read the token out loud.
 */
function TokenScreen({ created, origin, warned, onCopied, onDone }: { created: CreatedToken; origin: string; warned: boolean; onCopied: () => void; onDone: () => void }) {
  const invitation = useCopy("Invitation copied")
  const token = useCopy("Token copied")
  const button = useRef<HTMLButtonElement>(null)
  const code = useRef<HTMLElement>(null)
  const text = invitationText(origin, created.secret)

  useEffect(() => {
    button.current?.focus()
  }, [])

  async function copyToken() {
    if (await token.copy(created.secret)) return onCopied()
    if (code.current !== null) window.getSelection()?.selectAllChildren(code.current)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8 leading-snug wrap-anywhere">Token for {created.token.label}</DialogTitle>
        <DialogDescription className="text-pretty">
          {created.token.member === null
            ? `Send it to ${created.token.email}. They run the command below and paste the token at its prompt. The token is shown only once.`
            : "Run the command below where you deploy from, and paste the token at its prompt. The token is shown only once."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3">
        <code ref={code} className="min-w-0 font-mono text-sm font-semibold select-all wrap-anywhere">
          {created.secret}
        </code>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={token.state === "copied" ? "Token copied" : "Copy token"}
          title="Copy token"
          onClick={() => void copyToken()}
          className="text-muted-foreground hover:text-foreground max-sm:size-11"
        >
          {token.state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
        </Button>
      </div>

      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">To sign in, on their workstation or in an agent's sandbox:</p>
        <Command text={loginCommand(origin)} />
        <p className="text-xs text-pretty text-muted-foreground">
          An agent without files sets SITESOLIDE_API={origin} and SITESOLIDE_TOKEN instead. Then sitesolide deploy works from any
          project folder.
        </p>
      </div>

      {invitation.state === "failure" && <CopyFallback text={text} lines={3} onClose={invitation.reset} />}
      {warned && <Banner tone="attention">{COPY_WARNING}</Banner>}

      <DialogFooter>
        <Button variant="outline" onClick={onDone} className="max-sm:h-10">
          {warned ? "Close without copying" : "Done"}
        </Button>
        <Button
          ref={button}
          onClick={() =>
            void invitation.copy(text).then((done) => {
              if (done) onCopied()
            })
          }
          className="max-sm:h-10"
        >
          {invitation.state === "copied" ? <Check /> : <Copy />}
          {invitation.state === "copied" ? "Copied" : "Copy invitation"}
        </Button>
      </DialogFooter>
    </>
  )
}

export function RevokeTokenDialog({
  token,
  open,
  inProgress,
  error,
  onConfirm,
  onCancel,
}: {
  token: TokenView | null
  open: boolean
  inProgress: boolean
  error: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Revoke {token?.label}'s token?</AlertDialogTitle>
          <AlertDialogDescription>
            The next request with it is refused, a deployment already running finishes. The projects it created stay where they
            are, and only a new token you grant them to can deploy them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== "" && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={inProgress} className="max-sm:h-10">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={inProgress} onClick={onConfirm} className="max-sm:h-10">
            {inProgress ? "Revoking…" : "Revoke token"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
