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
import { Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Command, CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { Banner, FormError, INPUT_DIALOG } from "@/components/page"
import { createToken } from "@/lib/api"
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_CHOICES,
  expiryFrom,
  firstTokenField,
  holderLine,
  messageText,
  loginCommand,
  mintableProjects,
  neededLine,
  neededOptions,
  noProjectText,
  optionsAllowed,
  requestScope,
  tokenRefusal,
  validateTokenForm,
  type TokenErrors,
  type TokenField,
  type TokenProject,
} from "@/lib/tokens"
import { roleLabel } from "@/lib/access"
import type { Role, Roles, Scope, TokenView } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The Tokens page's two dialogs: creating a token, up to the screen that
 * shows it once, and confirming a revocation.
 *
 * Creating needs the dashboard unlocked, as reading a secret does: the page
 * asks for the password first, and a 423 from the service closes this dialog
 * and asks again, the steward having forgotten the unlock.
 *
 * Every token belongs to someone. The owner chooses whose: their own, for
 * their agents, offered every project on the server; or a person of People,
 * made exactly as that person's own would be. A person's token, whoever makes
 * it, offers the projects where they are a Developer or an Admin; creating
 * projects only with the right the owner granted them; and the options only
 * for projects they are an Admin of. An option a project chosen cannot be
 * deployed without is ticked, and says which: a token without it would be
 * refused there at its first deployment. Managing secrets is not one of
 * them: a Developer already changes a project's secrets, and every project a
 * person's token offers is one they deploy, so it is never taken away. The
 * steward judges it all again.
 */

const COPY_WARNING = "You haven't copied the token. It can't be shown again."

function Field({ id, labelText, error, children }: { id: string; labelText: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{labelText}</Label>
      {children}
      {error !== undefined && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * One choice: a checkbox, its title, and what it allows when that needs
 * saying. `locked`: ticked because a project chosen needs it, `note` saying
 * which; it reads as on, not as unavailable.
 */
function Choice({
  checked,
  onChange,
  title,
  meta,
  disabled = false,
  locked = false,
  note,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  title: string
  /** Beside the title, right aligned: a person's role on a project. */
  meta?: string
  disabled?: boolean
  locked?: boolean
  note?: string
  children?: ReactNode
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors select-none has-focus-visible:ring-2 has-focus-visible:ring-ring",
        disabled ? "cursor-not-allowed opacity-60" : locked ? "cursor-default" : "cursor-pointer hover:bg-muted",
      )}
    >
      {/* Locked, it stays focusable and drawn as ticked: `disabled` would grey it out as if it were off. */}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-disabled={locked || undefined}
        onChange={(event) => {
          if (!locked) onChange(event.target.checked)
        }}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-baseline gap-2">
          <span title={title} className="min-w-0 truncate text-sm font-medium">
            {title}
          </span>
          {meta !== undefined && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>}
        </span>
        {children !== undefined && <span className="text-xs text-pretty text-muted-foreground">{children}</span>}
        {note !== undefined && <span className="text-xs font-medium text-secondary-foreground">{note}</span>}
      </span>
    </label>
  )
}

const NO_OPTION = { public: [], domain: [] }

/** Every permission off, as a token starts and as choosing another holder resets it. */
const NO_SCOPE: Omit<Scope, "slugs"> = { create: false, outbound: false, domain: false, public: false, secrets: false }

export type CreatedToken = { token: TokenView; secret: string }

export function CreateTokenDialog({
  open,
  origin,
  projects,
  person = null,
  now,
  onClose,
  onCreated,
  onLocked,
  onSessionExpired,
  holders = [],
}: {
  open: boolean
  /** The dashboard's address, which the holder logs in to. */
  origin: string
  /** The projects on the server a token may be given, and what deploying each takes. */
  projects: readonly TokenProject[]
  /** A person minting their own: their roles and the create right. Null for the owner. */
  person?: { roles: Roles; create: boolean } | null
  /** For the owner, the people a token may be made for, with their roles and the create right. */
  holders?: readonly { email: string; roles: Roles; create: boolean }[]
  now: number
  onClose: () => void
  onCreated: () => void
  /** The steward forgot the unlock: close, and ask for the password again. */
  onLocked: () => void
  onSessionExpired: () => void
}) {
  const announce = useAnnounce()
  const [label, setLabel] = useState("")
  // Whose token, for the owner: `owner`, their own, or a person's email.
  const [holder, setHolder] = useState("owner")
  const [expiry, setExpiry] = useState<number | null>(DEFAULT_EXPIRY_DAYS)
  const [scope, setScope] = useState(NO_SCOPE)
  const [chosen, setChosen] = useState<string[]>([])
  // The person the token will be made for: the one minting their own, or the one the owner chose.
  const target = person ?? (holder === "owner" ? null : (holders.find((one) => one.email === holder) ?? null))
  // The person the owner makes it for, by name; null for the owner's own, or a person's own.
  const holderEmail = person === null && holder !== "owner" ? holder : null
  // The projects offered: every one for the owner's own, a person's where they deploy, with their role.
  const offered: { slug: string; role: Exclude<Role, "viewer"> | null }[] =
    target === null ? projects.map(({ slug }) => ({ slug, role: null })) : mintableProjects(target.roles)
  const options = target === null || optionsAllowed(target.roles, chosen, scope.create)
  const needed = options ? neededOptions(projects, chosen, target !== null) : NO_OPTION
  // A person's options fall as soon as their choice no longer allows them; one a project needs is on.
  // Managing secrets stays as ticked: a Developer may already.
  const effective = options
    ? { ...scope, public: scope.public || needed.public.length > 0, domain: scope.domain || needed.domain.length > 0 }
    : { ...scope, outbound: false, domain: false, public: false }
  const [errors, setErrors] = useState<TokenErrors>({})
  const [formError, setFormError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [copied, setCopied] = useState(false)
  const [warned, setWarned] = useState(false)

  const labelField = useRef<HTMLInputElement>(null)
  const projectsField = useRef<HTMLFieldSetElement>(null)
  const labelId = useId()
  const holderId = useId()
  const projectsId = useId()
  const expiryId = useId()

  function focusField(field: TokenField) {
    if (field === "label") return labelField.current?.focus()
    projectsField.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus()
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
    const slugs = [...chosen].sort()
    const faults = validateTokenForm({ label, slugs, create: effective.create })
    setErrors(faults)
    setFormError("")
    const first = firstTokenField(faults)
    if (first !== null) return focusField(first)

    setInProgress(true)
    try {
      // A person minting their own sends no holder: the token is theirs, the steward says so.
      const { status, body } = await createToken({ label: label.trim(), ...(person === null ? { holder } : {}), expiresAt: expiryFrom(expiry, now), scope: requestScope(effective, slugs) })
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
      announce(`Token created for ${body.token.member ?? "you"}. Copy it now: it won't be shown again.`)
      onCreated()
    } finally {
      setInProgress(false)
    }
  }

  const empty = target === null ? "No project on the server yet." : noProjectText(target.roles, person !== null ? null : holderEmail)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) askToClose()
      }}
    >
      {/* Taller than a phone's screen with every project: it scrolls within itself. */}
      <DialogContent className={cn("max-h-[calc(100svh-2rem)] gap-5 overflow-y-auto sm:max-w-xl", INPUT_DIALOG)} initialFocus={() => labelField.current}>
        {created === null ? (
          <form noValidate onSubmit={create} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>New token</DialogTitle>
              <DialogDescription className="text-pretty">
                {person !== null
                  ? "For your CLI or an agent, to run sitesolide deploy. It never does more than your roles, and you can revoke it at any time."
                  : target !== null
                    ? `For ${holderEmail}, made as their own would be: it never does more than their roles, and goes with them if they leave.`
                    : "For an agent or a workstation, to run sitesolide deploy over HTTPS, without SSH. You can revoke it at any time."}
              </DialogDescription>
            </DialogHeader>

            <div className={cn("grid gap-4", person === null && holders.length > 0 && "sm:grid-cols-2")}>
              <Field id={labelId} labelText="Name" error={errors.label}>
                <Input
                  ref={labelField}
                  id={labelId}
                  value={label}
                  maxLength={64}
                  autoComplete="off"
                  placeholder="Laptop, CI, agent…"
                  onChange={(event) => {
                    setLabel(event.target.value)
                    setErrors(({ label: _, ...rest }) => rest)
                  }}
                  aria-invalid={errors.label !== undefined || undefined}
                  aria-describedby={errors.label !== undefined ? `${labelId}-error` : undefined}
                  className="h-10 sm:h-9"
                />
              </Field>
              {person === null && holders.length > 0 && (
                <Field id={holderId} labelText="Whose token">
                  <Select
                    id={holderId}
                    value={holder}
                    items={{ owner: "Mine", ...Object.fromEntries(holders.map((one) => [one.email, one.email])) }}
                    onValueChange={(next) => {
                      if (next === null) return
                      setHolder(next)
                      setChosen([])
                      setScope(NO_SCOPE)
                      setErrors({})
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="owner" description="Yours, for your own agents">
                        Mine
                      </SelectItem>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectGroupLabel>For someone in People</SelectGroupLabel>
                        {holders.map((one) => (
                          <SelectItem key={one.email} value={one.email} description={holderLine(one)}>
                            {one.email}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>

            <fieldset ref={projectsField} aria-describedby={errors.slugs !== undefined ? `${projectsId}-error` : undefined}>
              <legend className="mb-2 text-sm leading-none font-medium">Projects it may deploy</legend>
              <div className="rounded-lg border border-input">
                {offered.length === 0 ? (
                  <p className="px-3 py-2.5 text-xs text-muted-foreground">{empty}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-x-1 p-1 sm:max-h-64 sm:overflow-y-auto">
                    {/* Two columns even on a phone, a slug being short; a long list scrolls within itself where the dialog has the room. */}
                    {offered.map(({ slug, role }) => (
                      <Choice
                        key={slug}
                        checked={chosen.includes(slug)}
                        onChange={(next) => {
                          setChosen((before) => (next ? [...before, slug] : before.filter((one) => one !== slug)))
                          setErrors(({ slugs: _, ...rest }) => rest)
                        }}
                        title={slug}
                        meta={role === null ? undefined : roleLabel(role)}
                      />
                    ))}
                  </div>
                )}
                {(target === null || target.create) && (
                  <div className="border-t border-input p-1">
                    <Choice
                      checked={effective.create}
                      onChange={(next) => {
                        setScope({ ...scope, create: next })
                        setErrors(({ slugs: _, ...rest }) => rest)
                      }}
                      title="New projects"
                    >
                      {target === null
                        ? "Projects it creates itself, which it then deploys."
                        : person !== null
                          ? "Projects it creates itself. You become Admin of each."
                          : "Projects it creates itself. They become Admin of each."}
                    </Choice>
                  </div>
                )}
              </div>
              {errors.slugs !== undefined && (
                <p id={`${projectsId}-error`} role="alert" className="mt-2 text-xs text-destructive">
                  {errors.slugs}
                </p>
              )}
            </fieldset>

            <fieldset aria-describedby={`${projectsId}-options`}>
              <legend className="mb-1 text-sm leading-none font-medium">Permissions</legend>
              <p id={`${projectsId}-options`} className="mb-2 text-xs text-pretty text-muted-foreground">
                {options
                  ? "Off unless you tick them. One a chosen project needs is ticked for you."
                  : `Public sites, outbound network and a domain only when ${person !== null ? "you are" : "they are"} an Admin of every project chosen.`}
              </p>
              {/* No rule between them: each choice is a rounded row, and a rule under one bent up at its corners. */}
              <div className="grid gap-0.5 rounded-lg border border-input p-1">
                <Choice
                  checked={effective.public}
                  disabled={!options}
                  locked={needed.public.length > 0}
                  note={needed.public.length > 0 ? neededLine(needed.public) : undefined}
                  onChange={(next) => setScope({ ...scope, public: next })}
                  title="Deploy public sites"
                >
                  Sites anyone opens without signing in. Off: what it deploys asks to sign in.
                </Choice>
                <Choice checked={effective.outbound} disabled={!options} onChange={(next) => setScope({ ...scope, outbound: next })} title="Use outbound network">
                  For services that call an outside API. Connectors you grant work without it.
                </Choice>
                <Choice
                  checked={effective.domain}
                  disabled={!options}
                  locked={needed.domain.length > 0}
                  note={needed.domain.length > 0 ? neededLine(needed.domain) : undefined}
                  onChange={(next) => setScope({ ...scope, domain: next })}
                  title="Declare a domain"
                >
                  A domain of its own in sitesolide.json. Switching to it stays {person === null ? "yours" : "the owner's"}.
                </Choice>
                {/* Never disabled: every project offered to a person's token is one where they may change secrets. */}
                <Choice checked={effective.secrets === true} onChange={(next) => setScope({ ...scope, secrets: next })} title="Manage secrets">
                  Lists each project's secret names, and sets, generates and removes its variables and files on the server. Never reads a value back.
                </Choice>
              </div>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm leading-none font-medium">Expires</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {EXPIRY_CHOICES.map((choice) => (
                  <label
                    key={choice.label}
                    className="flex h-10 cursor-pointer items-center justify-center rounded-lg border border-input px-2 text-sm whitespace-nowrap transition-colors select-none hover:bg-muted has-checked:border-primary has-checked:bg-highlight has-checked:font-medium has-checked:text-strong has-checked:ring-1 has-checked:ring-primary has-focus-visible:ring-2 has-focus-visible:ring-ring sm:h-9"
                  >
                    <input type="radio" name={expiryId} checked={expiry === choice.days} onChange={() => setExpiry(choice.days)} className="sr-only" />
                    {choice.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <FormError>{formError}</FormError>

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
  const message = useCopy("Message copied")
  const token = useCopy("Token copied")
  const button = useRef<HTMLButtonElement>(null)
  const code = useRef<HTMLElement>(null)
  const text = messageText(origin, created.secret)

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
          {created.token.member !== null && created.token.by === "owner"
            ? `Send it to ${created.token.member}. They run the command below and paste the token at its prompt. The token is shown only once.`
            : "Run the command below where it deploys from, and paste the token at its prompt. The token is shown only once."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-sunk py-1.5 pr-1.5 pl-3 shadow-well">
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

      {message.state === "failure" && <CopyFallback text={text} lines={3} onClose={message.reset} />}
      {warned && <Banner tone="attention">{COPY_WARNING}</Banner>}

      <DialogFooter>
        <Button variant="outline" onClick={onDone} className="max-sm:h-10">
          {warned ? "Close without copying" : "Done"}
        </Button>
        <Button
          ref={button}
          onClick={() =>
            void message.copy(text).then((done) => {
              if (done) onCopied()
            })
          }
          className="max-sm:h-10"
        >
          {message.state === "copied" ? <Check /> : <Copy />}
          {message.state === "copied" ? "Copied" : "Copy message"}
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
        <FormError>{error}</FormError>
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
