import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react"
import { Check, CircleCheck, CircleX, Copy, Dices, ExternalLink, TriangleAlert, X } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { useData } from "@/components/data"
import { FormError, INPUT_DIALOG, SEGMENTED, Segment } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { NO_PASSWORD_MANAGER, ShowToggle, UnlockDialog, describedBy, type FocusReturn } from "@/components/secrets-dialogs"
import { LockGlyph } from "@/components/unlock"
import { removeVariable, setVariable } from "@/lib/api"
import { WEBHOOK_FORMATS, settingById, type SettingId, type SettingState } from "@/lib/machine-settings"
import { refusalOf, succeeded, unlockStatus } from "@/lib/secrets"
import {
  OFFSITE_FIELDS,
  PASSPHRASE_MIN,
  PASSPHRASE_VARIABLE,
  SIGNIN_FIELDS,
  WEBHOOK_SERVICES,
  drawPassphrase,
  fileCommand,
  formatSummary,
  formatWrite,
  httpsProblem,
  initialFormatChoice,
  lastPassSeconds,
  missingFile,
  nextPassSeconds,
  nextStep,
  offsiteDetailsReady,
  openingStep,
  passphraseHint,
  passphraseReady,
  pingCheck,
  previousStep,
  proofPhase,
  serviceName,
  signinReady,
  stepPosition,
  wantedFormat,
  webhookCheck,
  writesOf,
  MONITOR_PASS_MS,
  type FieldSpec,
  type FormatChoice,
  type GuideId,
  type GuideStart,
  type Hint,
  type Proof,
  type StepId,
  type WebhookService,
  type Write,
} from "@/lib/server-setup"
import { TONE_BANNER } from "@/lib/tones"
import type { Alerting } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * The guides: each setting step by step, the outside steps said in words,
 * the value typed, then what the server makes of it. A value is typed into a
 * masked field, never filled in from the server, and goes to the steward as
 * typed; its refusal shows under the field. The unlock is asked when Save
 * is pressed while locked, over the guide, and Save goes on once unlocked.
 */

export type GuideOpening = { id: GuideId; start: GuideStart; open: boolean; opening: number }

type GuideProps = {
  guide: GuideOpening | null
  states: Readonly<Record<SettingId, SettingState>>
  alerting: Alerting | null
  proof: Proof | null
  serverNow: number
  /** The heartbeat was saved: the page waits for its first ping from this time, on the server's clock. */
  onProof: (savedAt: number) => void
  onClose: () => void
  focusReturn: FocusReturn
}

/** What the dialog needs of its flow to decide on closing and on its width, with no extra render. */
type Shape = { busy: boolean; wide: boolean }

export function SetupGuide({ guide, onClose, focusReturn, ...rest }: GuideProps) {
  const shape = useRef<Shape>({ busy: false, wide: false })
  const [wide, setWide] = useState(false)
  return (
    <Dialog
      open={guide?.open ?? false}
      onOpenChange={(next) => {
        if (!next && !shape.current.busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={() => document.querySelector<HTMLElement>("[data-guide-focus]") ?? document.querySelector<HTMLElement>("[data-guide-primary]") ?? true}
        finalFocus={focusReturn}
        className={cn("gap-0 overflow-y-auto p-0 max-sm:max-h-[92svh]", wide ? "sm:max-w-[37.5rem]" : "sm:max-w-[30rem]", INPUT_DIALOG)}
      >
        {guide !== null && <GuideFlow key={guide.opening} guide={guide} onClose={onClose} shape={shape} setWide={setWide} {...rest} />}
      </DialogContent>
    </Dialog>
  )
}

// --- The frame of a step -----------------------------------------------------------------

/** How far the guide is: as many bars as steps, those done and the current one in the accent. */
function Bars({ index, total }: { index: number; total: number }) {
  return (
    <span aria-hidden="true" className="ml-auto inline-flex gap-1">
      {Array.from({ length: total }, (_, at) => (
        <i key={at} className={cn("block h-1 w-5.5 rounded-sm", at < index ? "bg-primary" : "bg-track shadow-well")} />
      ))}
    </span>
  )
}

function Frame({
  label,
  position,
  title,
  busy,
  onSubmit,
  foot,
  children,
}: {
  label: string
  position: { index: number; total: number } | null
  title: string
  busy: boolean
  onSubmit: () => void
  foot: ReactNode
  children: ReactNode
}) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy) onSubmit()
      }}
    >
      <div className="flex min-h-8 items-center gap-3 pt-3 pr-3 pl-5 max-sm:pl-4">
        <span className="mono-label">{label}</span>
        {position !== null && <Bars index={position.index} total={position.total} />}
        <DialogClose
          disabled={busy}
          render={<Button variant="ghost" size="icon-sm" aria-label="Close" className={cn("text-muted-foreground hover:text-foreground max-sm:size-9", position === null && "ml-auto")} />}
        >
          <X />
        </DialogClose>
      </div>
      <DialogTitle className="px-5 pt-1.5 pr-12 max-sm:px-4">{title}</DialogTitle>
      <div className="grid gap-3.5 px-5 pt-3 pb-5 text-sm text-pretty max-sm:px-4">{children}</div>
      <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-cell px-5 py-3 max-sm:px-4 [&_button]:max-sm:h-11 [&>a]:max-sm:h-11">{foot}</div>
    </form>
  )
}

const Grow = () => <span aria-hidden="true" className="flex-1" />

/** Two or three facts in a small table: the check's schedule, the format saved. */
function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="rounded-lg border bg-cell">
      {rows.map(([term, value]) => (
        <div key={term} className="flex min-h-9 items-center justify-between gap-3 border-b border-divider px-3 last:border-b-0">
          <dt className="text-[0.8125rem] text-muted-foreground">{term}</dt>
          <dd className="text-right font-medium text-strong">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Saved({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[0.8125rem] text-ok-text">
      <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </p>
  )
}

/** The result of a wait: what came through in the ok tone, what did not in the error's. */
function Result({ bad = false, children }: { bad?: boolean; children: ReactNode }) {
  const Icon = bad ? CircleX : CircleCheck
  return (
    <div
      role={bad ? "alert" : undefined}
      className={cn("flex items-start gap-3 rounded-lg border px-3.5 py-3", bad ? TONE_BANNER.error : "border-ok/30 bg-ok/8")}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", bad ? "text-destructive" : "text-ok-text")} />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** A warning the owner must read before going on: no live region, it is part of the step. */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[0.8125rem]", TONE_BANNER.attention)}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention-text" />
      <p className="min-w-0">{children}</p>
    </div>
  )
}

function HintLines({ id, hints }: { id: string; hints: readonly Hint[] }) {
  if (hints.length === 0) return null
  return (
    <div id={id} className="grid gap-1">
      {hints.map((hint) => (
        <p key={hint.text} className={cn("flex gap-1.5 text-xs leading-4", hint.tone === "attention" ? "text-attention-text" : "text-muted-foreground")}>
          {hint.tone === "attention" && <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />}
          <span>{hint.text}</span>
        </p>
      ))}
    </div>
  )
}

/** The words of a person, not of a machine: an email, a provider's name. */
const WORDS = new Set(["OIDC_ADMIN_EMAILS", "OIDC_PROVIDER_NAME"])

/**
 * One field: its plain label, "Optional" beside it when it is, masked with
 * Show when it holds a secret, and nothing a password manager would offer.
 * `keep`: a value is on the server already, which an empty field keeps.
 */
function GuideField({
  spec,
  value,
  onChange,
  keep,
  hints = [],
  error = "",
  focus = false,
  visible,
  onToggle,
}: {
  spec: Pick<FieldSpec, "variable" | "label" | "secret" | "optional" | "placeholder" | "help">
  value: string
  onChange: (value: string) => void
  keep: boolean
  hints?: readonly Hint[]
  error?: string
  focus?: boolean
  visible: boolean
  onToggle: () => void
}) {
  const id = useId()
  const masked = spec.secret && !visible
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={id}>
        {spec.label}
        {spec.optional && <span className="text-xs font-normal text-muted-foreground">Optional</span>}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={masked ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={keep ? "Leave empty to keep it" : spec.placeholder}
          {...NO_PASSWORD_MANAGER}
          spellCheck={false}
          autoCapitalize="off"
          data-guide-focus={focus || undefined}
          aria-invalid={error !== "" || undefined}
          aria-describedby={describedBy(hints.length > 0 && `${id}-hints`, spec.help !== undefined && `${id}-help`, error !== "" && `${id}-error`)}
          className={cn("h-10 sm:h-9", WORDS.has(spec.variable) ? "" : "font-mono", spec.secret && "pr-11")}
        />
        {spec.secret && <ShowToggle visible={visible} onToggle={onToggle} what={spec.label.toLowerCase()} />}
      </div>
      <HintLines id={`${id}-hints`} hints={hints} />
      {spec.help !== undefined && (
        <p id={`${id}-help`} className="text-xs text-pretty text-muted-foreground">
          {spec.help}
        </p>
      )}
      <FormError id={`${id}-error`}>{error}</FormError>
    </div>
  )
}

/** The command the file needs, cut before the file's name; the copy holds the whole line. */
function CutCommand({ file }: { file: string }) {
  const command = fileCommand(file)
  const { state, copy, reset } = useCopy("Command copied")
  if (state === "failure") return <CopyFallback text={command.whole} onClose={reset} />
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg bg-sunk py-1 pr-1 pl-3 shadow-well">
      <code className="min-w-0 flex-1 font-mono text-xs break-all">
        <span aria-hidden="true" className="text-faint select-none">
          ${" "}
        </span>
        {command.shown}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Copy the whole command"
        title="Copy the whole command"
        onClick={() => void copy(command.whole)}
        className="text-muted-foreground hover:text-foreground max-md:size-10"
      >
        {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
      </Button>
    </div>
  )
}

/**
 * The wait for the monitor's next pass: the seconds since its last one on
 * the minute it takes, the time actually elapsed and nothing invented.
 */
function PassTrack({ alerting, serverNow }: { alerting: Alerting | null; serverNow: number }) {
  const last = lastPassSeconds(alerting, serverNow)
  const left = nextPassSeconds(alerting, serverNow)
  const total = MONITOR_PASS_MS / 1000
  return (
    <div className="rounded-lg border bg-cell p-3.5">
      <p className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <span>Waiting for the monitor's next pass…</span>
        <span className="font-mono font-medium tabular-nums">{left > 0 ? `${left}s` : "any moment now"}</span>
      </p>
      <Progress
        value={(last / total) * 100}
        aria-label="Time since the monitor's last pass"
        getAriaValueText={() => `${last} seconds since the last pass`}
        className="w-full [&_[data-slot=progress-indicator]]:bg-primary [&_[data-slot=progress-indicator]]:transition-[width] [&_[data-slot=progress-indicator]]:duration-1000 [&_[data-slot=progress-indicator]]:ease-linear motion-reduce:[&_[data-slot=progress-indicator]]:transition-none [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-track"
      />
      <p aria-hidden="true" className="mt-2 flex justify-between font-mono text-[0.6875rem] text-muted-foreground">
        <span>Last pass {last}s ago</span>
        <span>Next pass</span>
      </p>
    </div>
  )
}

// --- The flow -------------------------------------------------------------------------------

const TITLES: Readonly<Record<StepId, string>> = {
  "create-check": "Create a check",
  "paste-ping": "Paste its ping URL",
  "wait-ping": "Wait for the first ping",
  "choose-service": "Choose where messages go",
  "paste-webhook": "Paste the webhook address",
  "webhook-saved": "Alert webhook set",
  "create-bucket": "Create a bucket",
  "bucket-details": "Enter its details",
  passphrase: "Choose the encryption passphrase",
  "offsite-saved": "Offsite copy set",
  "register-app": "Register the app",
  "signin-details": "Enter its details",
  "signin-saved": "Company sign-in set",
}

/** The same steps on a Change, which keeps what is not typed again. */
const CHANGE_TITLES: Readonly<Partial<Record<StepId, string>>> = {
  "webhook-saved": "Alert webhook changed",
  "bucket-details": "Change its details",
  passphrase: "The encryption passphrase",
  "offsite-saved": "Offsite copy changed",
  "signin-details": "Change its details",
  "signin-saved": "Company sign-in changed",
}

/** What the unlock is asked for, in its title: "Unlock to set the heartbeat URL". */
const PURPOSES: Readonly<Record<GuideId, string>> = {
  heartbeat: "set the heartbeat URL",
  webhook: "set the alert webhook",
  offsite: "set up the offsite copy",
  "company-signin": "set up company sign-in",
}

/** What the file the gate asks for holds, in its help. */
const HOLDS: Readonly<Record<GuideId, string>> = {
  heartbeat: "the heartbeat and the alert webhook",
  webhook: "the heartbeat and the alert webhook",
  offsite: "the offsite copy's settings",
  "company-signin": "company sign-in",
}

/** A step as the frame draws it: its title, what Enter and the primary button do, its buttons and its body. */
type StepFrame = { title: string; label?: string; position?: boolean; onSubmit: () => void; foot: ReactNode; body: ReactNode }

const PING_FIELD = { variable: "HEARTBEAT_URL", label: "Ping URL", secret: true, optional: false, placeholder: "https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" } as const
const PING_HELP =
  "From healthchecks.io or a service like it. The monitor pings it every minute; the service tells you when the pings stop. Keep it secret: whoever has it can hide that the server is down."

function GuideFlow({
  guide,
  states,
  alerting,
  proof,
  serverNow,
  onProof,
  onClose,
  shape,
  setWide,
}: Omit<GuideProps, "guide" | "focusReturn"> & { guide: GuideOpening; shape: RefObject<Shape>; setWide: (wide: boolean) => void }) {
  const { id } = guide
  const announce = useAnnounce()
  const actions = useSecretsActions()
  const { secrets, offset } = useData()
  const setting = settingById(id)
  const state = states[id]
  // A Change: something is on the server already, which a field left empty keeps. Fixed at opening.
  const [change] = useState(() => state.present.length > 0)
  const [step, setStep] = useState<StepId>(() => openingStep(id, guide.start))
  const [fields, setFields] = useState<Readonly<Record<string, string>>>({})
  const [visible, setVisible] = useState<Readonly<Record<string, boolean>>>({})
  const [service, setService] = useState<WebhookService | null>(null)
  const [choice, setChoice] = useState<FormatChoice>(() => initialFormatChoice(states.format.present.length > 0))
  const [savedFormat, setSavedFormat] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [unlock, setUnlock] = useState<{ purpose: string; then: (() => void) | null } | null>(null)
  const [checked, setChecked] = useState(false)
  const primary = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLDivElement>(null)

  const file = missingFile(id, state.presence)
  const wide = file === null && (step === "bucket-details" || step === "signin-details")

  useEffect(() => {
    shape.current = { busy, wide }
    setWide(wide)
  })

  // A new step takes the focus to its first field, or to its primary button.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const root = body.current
      if (root === null) return
      const target = root.querySelector<HTMLElement>("[data-guide-focus], input:not([type=hidden]):not([disabled])") ?? primary.current
      target?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [step, file === null])

  const set = (variable: string) => (value: string) => {
    setFields((before) => ({ ...before, [variable]: value }))
    setError("")
  }
  const value = (variable: string) => fields[variable] ?? ""
  const toggle = (variable: string) => () => setVisible((before) => ({ ...before, [variable]: !before[variable] }))
  const keep = (variable: string) => change && state.present.includes(variable)
  const go = (next: StepId | null) => {
    if (next === null) return
    setError("")
    setStep(next)
  }

  /** One write after another, as the steward takes them: `locked`, `refused` (its message shown), or `ok`. */
  async function perform(writes: readonly Write[]): Promise<"ok" | "locked" | "refused"> {
    for (const write of writes) {
      const target = { slug: setting.slug, file: setting.file, variable: write.variable }
      const { status, body: answer } = "remove" in write ? await removeVariable(target) : await setVariable({ ...target, value: write.value })
      if (succeeded(status)) continue
      const refusal = refusalOf(status, answer)
      if (refusal.kind === "locked") return "locked"
      const message = actions.refusal(refusal)
      if (message !== null) setError(message)
      return "refused"
    }
    return "ok"
  }

  /**
   * Save: at once while unlocked, otherwise once the unlock asked over the
   * guide goes through. A 423 met on the way locks and asks again, and Save
   * is pressed again: a write is never replayed.
   */
  function save(writes: readonly Write[], done: () => void) {
    const purpose = PURPOSES[id]
    const run = async () => {
      setBusy(true)
      setError("")
      try {
        const outcome = await perform(writes)
        if (outcome === "locked") {
          secrets.setUnlockedUntil(null)
          return setUnlock({ purpose, then: null })
        }
        actions.changed()
        if (outcome === "ok") done()
      } finally {
        setBusy(false)
      }
    }
    if (actions.state.open) return void run()
    setUnlock({ purpose, then: () => void run() })
  }

  async function checkAgain() {
    setBusy(true)
    try {
      await secrets.reload()
      setChecked(true)
    } finally {
      setBusy(false)
    }
  }

  const locked = !actions.state.open
  const back = (label = "Back") => {
    const previous = previousStep(id, step)
    return previous === null ? (
      <DialogClose render={<Button type="button" variant="ghost" disabled={busy} />}>Cancel</DialogClose>
    ) : (
      <Button type="button" variant="ghost" disabled={busy} onClick={() => go(previous)}>
        {label}
      </Button>
    )
  }
  const submit = (label: string, { ready = true, write = false, variant = "default" }: { ready?: boolean; write?: boolean; variant?: "default" | "outline" } = {}) => (
    <Button ref={primary} type="submit" variant={variant} disabled={busy || !ready} data-guide-primary="">
      {busy && write ? "Saving…" : label}
      {write && locked && <LockGlyph />}
    </Button>
  )
  let frame: StepFrame

  if (file !== null) {
    frame = {
      label: "Before you start",
      position: false,
      title: "One command to run first",
      onSubmit: () => void checkAgain(),
      foot: (
        <>
          <DialogClose render={<Button type="button" variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Grow />
          <Button ref={primary} type="submit" disabled={busy}>
            {busy ? "Checking…" : "Check again"}
          </Button>
        </>
      ),
      body: (
        <>
          <p>Run this once on the server, then check again.</p>
          <CutCommand file={file} />
          {checked && <FormError>The server still isn't ready. Run the command, then check again.</FormError>}
          <p className="text-xs text-muted-foreground">
            It creates the empty place where the dashboard keeps {HOLDS[id]}. The dashboard can't create it itself, since it belongs to
            root. Copy gives the whole command.
          </p>
        </>
      ),
    }
  } else {
    frame = stepFrame()
  }

  function stepFrame(): StepFrame {
    switch (step) {
      // --- The heartbeat
      case "create-check":
        return {
          title: TITLES[step],
          onSubmit: () => go(nextStep(id, step)),
          foot: (
            <>
              {back()}
              <Grow />
              <a href="https://healthchecks.io" target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "outline" }))}>
                Open healthchecks.io
                <ExternalLink data-icon="inline-end" />
              </a>
              {submit("Next")}
            </>
          ),
          body: (
            <>
              <p>At healthchecks.io, Add Check.</p>
              <Facts rows={[["Schedule", "Simple"], ["Period", "1 minute"], ["Grace", "5 minutes"]]} />
              <p>If the server dies, you hear of it within six minutes.</p>
            </>
          ),
        }
      case "paste-ping": {
        const address = value(PING_FIELD.variable)
        const check = pingCheck(address)
        return {
          title: TITLES[step],
          onSubmit: () => {
            if (!check.ready) return
            save([{ variable: PING_FIELD.variable, value: address.trim() }], () => {
              setFields({})
              onProof(Date.now() + offset)
              announce("Heartbeat URL saved. The monitor uses it within a minute.")
              go("wait-ping")
            })
          },
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Save and continue", { ready: check.ready, write: true })}
            </>
          ),
          body: (
            <GuideField
              spec={{ ...PING_FIELD, help: PING_HELP }}
              value={address}
              onChange={set(PING_FIELD.variable)}
              keep={false}
              hints={check.hints}
              error={error}
              focus
              visible={visible[PING_FIELD.variable] === true}
              onToggle={toggle(PING_FIELD.variable)}
            />
          ),
        }
      }
      case "wait-ping": {
        const phase = proof === null ? "unknown" : proofPhase(proof, alerting)
        if (phase === "failed" || phase === "refused") {
          return {
            title: TITLES[step],
            onSubmit: () => go("paste-ping"),
            foot: (
              <>
                <DialogClose render={<Button type="button" variant="ghost" />}>Close</DialogClose>
                <Grow />
                {submit("Change the URL")}
              </>
            ),
            body: (
              <>
                <Result bad>{phase === "refused" ? "The monitor didn't take this address. Check the URL." : "The monitor couldn't reach it. Check the URL."}</Result>
                <p className="text-xs text-muted-foreground">The value is saved as you typed it. Copy the ping URL from the check's page again and paste it over.</p>
              </>
            ),
          }
        }
        if (phase === "waiting") {
          return {
            title: TITLES[step],
            onSubmit: onClose,
            foot: (
              <>
                <Grow />
                {submit("Close", { variant: "outline" })}
              </>
            ),
            body: (
              <>
                <Saved>Heartbeat saved. The monitor uses it within a minute.</Saved>
                <PassTrack alerting={alerting} serverNow={serverNow} />
                <p className="text-xs text-muted-foreground">The monitor runs every minute. You can close this: the check carries on without it.</p>
              </>
            ),
          }
        }
        return {
          title: TITLES[step],
          onSubmit: onClose,
          foot: (
            <>
              <Grow />
              {submit("Done")}
            </>
          ),
          body:
            phase === "delivered" ? (
              <>
                <Result>
                  <span className="font-semibold text-strong">Delivered:</span> healthchecks.io shows the check as up.
                </Result>
                <p className="text-xs text-muted-foreground">The monitor now pings it every minute. If the pings stop, healthchecks.io tells you after the grace time.</p>
              </>
            ) : (
              <>
                <Saved>Heartbeat saved. The monitor uses it within a minute.</Saved>
                <Result>Within two minutes the check turns green on healthchecks.io.</Result>
              </>
            ),
        }
      }

      // --- The alert webhook
      case "choose-service":
        return {
          title: TITLES[step],
          onSubmit: () => {
            if (service !== null) go(nextStep(id, step))
          },
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Next", { ready: service !== null })}
            </>
          ),
          body: (
            <>
              <p id="where-messages-go">Where should the monitor write when a site goes down or recovers?</p>
              <div role="radiogroup" aria-labelledby="where-messages-go" className="grid gap-1">
                {WEBHOOK_SERVICES.map((one, index) => (
                  <label
                    key={one.id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 hover:bg-muted has-checked:border-highlight-line has-checked:bg-highlight has-focus-visible:ring-2 has-focus-visible:ring-ring"
                  >
                    <input
                      type="radio"
                      name="webhook-service"
                      value={one.id}
                      checked={service === one.id}
                      onChange={() => setService(one.id)}
                      data-guide-focus={(service === null ? index === 0 : service === one.id) || undefined}
                      className="size-4 shrink-0 accent-primary outline-none"
                    />
                    <span className="grid min-w-0">
                      <span className="font-medium text-strong">{one.name}</span>
                      <span className="text-xs text-pretty text-muted-foreground">{one.steps}</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          ),
        }
      case "paste-webhook": {
        const address = value("ALERT_WEBHOOK_URL")
        const check = webhookCheck(address, service)
        const known = service === null ? null : WEBHOOK_SERVICES.find((one) => one.id === service)!
        const wanted = wantedFormat(service, choice, address)
        return {
          title: service !== null && service !== "other" ? `Paste the ${serviceName(service)} address` : TITLES[step],
          onSubmit: () => {
            if (!check.ready) return
            const writes: Write[] = [{ variable: "ALERT_WEBHOOK_URL", value: address.trim() }]
            const format = formatWrite(wanted, address.trim(), states.format.present.length > 0)
            if (format !== null) writes.push(format)
            save(writes, () => {
              setSavedFormat(formatSummary(wanted, address.trim()))
              setFields({})
              announce("Alert webhook saved. The monitor uses it within a minute.")
              go("webhook-saved")
            })
          },
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Save and continue", { ready: check.ready, write: true })}
            </>
          ),
          body: (
            <>
              <GuideField
                spec={{
                  variable: "ALERT_WEBHOOK_URL",
                  label: "Webhook address",
                  secret: true,
                  optional: false,
                  placeholder: known?.placeholder ?? WEBHOOK_SERVICES[WEBHOOK_SERVICES.length - 1]!.placeholder,
                  help: known === null || known.id === "other" ? undefined : known.steps,
                }}
                value={address}
                onChange={set("ALERT_WEBHOOK_URL")}
                keep={false}
                hints={check.hints}
                error={error}
                focus
                visible={visible.ALERT_WEBHOOK_URL === true}
                onToggle={toggle("ALERT_WEBHOOK_URL")}
              />
              {service === "other" && (
                <div className="grid gap-1.5">
                  <span id="message-format" className="text-sm leading-none font-medium">
                    Message format
                  </span>
                  <div role="group" aria-labelledby="message-format" className={cn(SEGMENTED, "flex")}>
                    {(["json", "text"] as const).map((format) => (
                      <Segment key={format} selected={(choice === "auto" ? "json" : choice) === format} onClick={() => setChoice(format)} className="flex-1">
                        {format === "json" ? "JSON" : "Plain text"}
                      </Segment>
                    ))}
                  </div>
                </div>
              )}
              {service === null && (
                <div className="grid gap-1.5">
                  <Label htmlFor="message-format-choice">Message format</Label>
                  <Select
                    id="message-format-choice"
                    value={choice}
                    items={{ keep: "Keep the current one", auto: "From the address", ...Object.fromEntries(WEBHOOK_FORMATS.map((one) => [one.value, one.label])) }}
                    onValueChange={(next) => {
                      if (next !== null) setChoice(next as FormatChoice)
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {states.format.present.length > 0 && (
                        <SelectItem value="keep" description="The format chosen before stays as it is.">
                          Keep the current one
                        </SelectItem>
                      )}
                      <SelectItem value="auto" description="Slack, Discord, Google Chat and ntfy.sh are known by their address; anything else gets JSON.">
                        From the address
                      </SelectItem>
                      <SelectSeparator />
                      {WEBHOOK_FORMATS.map((one) => (
                        <SelectItem key={one.value} value={one.value}>
                          {one.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          ),
        }
      }
      case "webhook-saved": {
        return {
          title: (change && CHANGE_TITLES[step]) || TITLES[step],
          onSubmit: onClose,
          foot: (
            <>
              <Grow />
              {submit("Done")}
            </>
          ),
          body: (
            <>
              <Saved>Webhook saved. The monitor uses it within a minute.</Saved>
              <p>The monitor sends a message the next time a site goes down or recovers. Nothing is sent now.</p>
              <Facts
                rows={[
                  ["Message format", savedFormat ?? "As before"],
                  ["Applies", "At the next pass, no restart"],
                ]}
              />
            </>
          ),
        }
      }

      // --- The offsite copy
      case "create-bucket":
        return {
          title: TITLES[step],
          onSubmit: () => go(nextStep(id, step)),
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Next")}
            </>
          ),
          body: (
            <>
              <p>
                At an S3-compatible storage provider (Backblaze B2, Cloudflare R2, Wasabi or similar), create a private bucket and an access key
                limited to that bucket.
              </p>
              <p className="text-xs text-muted-foreground">Snapshots are encrypted before they leave the server. The provider only ever holds data it cannot read.</p>
            </>
          ),
        }
      case "bucket-details": {
        const ready = offsiteDetailsReady(fields, state.present)
        const [endpoint, bucket, access, secret, region, prefix] = OFFSITE_FIELDS
        const one = (spec: FieldSpec, extra: { hints?: Hint[]; focus?: boolean } = {}) => (
          <GuideField
            spec={spec}
            value={value(spec.variable)}
            onChange={set(spec.variable)}
            keep={keep(spec.variable)}
            visible={visible[spec.variable] === true}
            onToggle={toggle(spec.variable)}
            {...extra}
          />
        )
        const endpointProblem = httpsProblem(value(endpoint!.variable))
        return {
          title: (change && CHANGE_TITLES[step]) || TITLES[step],
          onSubmit: () => {
            if (ready) go(nextStep(id, step))
          },
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Next", { ready })}
            </>
          ),
          body: (
            <div className="grid gap-3.5">
              {change && <p>Change what you need. A field you leave empty stays as it is.</p>}
              {one(endpoint!, { focus: true, hints: endpointProblem === null ? [] : [{ text: endpointProblem, tone: "attention" }] })}
              {one(bucket!)}
              <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-x-3">
                {one(access!)}
                {one(secret!)}
              </div>
              <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-x-3">
                {one(region!)}
                {one(prefix!)}
              </div>
            </div>
          ),
        }
      }
      case "passphrase": {
        const passphrase = value(PASSPHRASE_VARIABLE)
        const present = state.present.includes(PASSPHRASE_VARIABLE)
        const ready = passphraseReady(passphrase, saved, change && present)
        const hint = passphraseHint(passphrase)
        return {
          title: (change && CHANGE_TITLES[step]) || TITLES[step],
          onSubmit: () => {
            if (!ready) return
            const writes = writesOf(fields, OFFSITE_FIELDS)
            if (passphrase !== "") writes.push({ variable: PASSPHRASE_VARIABLE, value: passphrase })
            save(writes, () => {
              setFields({})
              setSaved(false)
              announce("Offsite copy saved. The next hourly backup uses it.")
              go("offsite-saved")
            })
          },
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Save", { ready, write: true })}
            </>
          ),
          body: (
            <PassphraseStep
              passphrase={passphrase}
              setPassphrase={(next, show) => {
                set(PASSPHRASE_VARIABLE)(next)
                setSaved(false)
                if (show) setVisible((before) => ({ ...before, [PASSPHRASE_VARIABLE]: true }))
              }}
              keep={change && present}
              hint={hint}
              visible={visible[PASSPHRASE_VARIABLE] === true}
              onToggle={toggle(PASSPHRASE_VARIABLE)}
              saved={saved}
              setSaved={setSaved}
            />
          ),
        }
      }
      case "offsite-saved":
        return {
          title: (change && CHANGE_TITLES[step]) || TITLES[step],
          onSubmit: onClose,
          foot: (
            <>
              <Grow />
              {submit("Done")}
            </>
          ),
          body: (
            <>
              <Saved>Offsite copy saved.</Saved>
              <p>The next hourly backup uses it. Nothing to restart.</p>
              <p className="text-xs text-muted-foreground">
                Keep the passphrase where you saved it. Changing it later without adding the new one to the backup repository first cuts the
                offsite copy off.
              </p>
            </>
          ),
        }

      // --- Company sign-in
      case "register-app":
        return {
          title: TITLES[step],
          onSubmit: () => go(nextStep(id, step)),
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Next")}
            </>
          ),
          body: (
            <>
              <p>At your identity provider (Google Workspace, Microsoft Entra, Okta or any OpenID Connect one), create an application for the portal.</p>
              <p>Set its redirect address to the portal's, then copy its issuer address, client ID and client secret.</p>
              <p className="text-xs text-muted-foreground">People then sign in with their company account.</p>
            </>
          ),
        }
      case "signin-details": {
        const ready = signinReady(fields, state.present)
        const [issuer, client, secret, domains, admins, provider] = SIGNIN_FIELDS
        const one = (spec: FieldSpec, extra: { hints?: Hint[]; focus?: boolean; error?: string } = {}) => (
          <GuideField
            spec={spec}
            value={value(spec.variable)}
            onChange={set(spec.variable)}
            keep={keep(spec.variable)}
            visible={visible[spec.variable] === true}
            onToggle={toggle(spec.variable)}
            {...extra}
          />
        )
        const issuerProblem = httpsProblem(value(issuer!.variable))
        return {
          title: (change && CHANGE_TITLES[step]) || TITLES[step],
          onSubmit: () => {
            if (!ready) return
            save(writesOf(fields, SIGNIN_FIELDS), () => {
              setFields({})
              announce("Company sign-in saved. The portal uses it when it restarts.")
              go("signin-saved")
            })
          },
          foot: (
            <>
              {back()}
              <Grow />
              {submit("Save and continue", { ready, write: true })}
            </>
          ),
          body: (
            <div className="grid gap-3.5">
              {change && <p>Change what you need. A field you leave empty stays as it is.</p>}
              {one(issuer!, { focus: true, hints: issuerProblem === null ? [] : [{ text: issuerProblem, tone: "attention" }] })}
              <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-x-3">
                {one(client!)}
                {one(secret!)}
              </div>
              {one(domains!)}
              <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-x-3">
                {one(admins!)}
                {one(provider!)}
              </div>
            </div>
          ),
        }
      }
      case "signin-saved":
        return {
          title: (change && CHANGE_TITLES[step]) || TITLES[step],
          onSubmit: onClose,
          foot: (
            <>
              <Grow />
              {submit("Done")}
            </>
          ),
          body: (
            <>
              <Saved>Company sign-in saved.</Saved>
              <p>
                The portal reads these when it starts: restart it to apply a change. Until then, nothing changes for visitors, and the row on the
                Server page says Restart pending.
              </p>
            </>
          ),
        }
    }
  }

  const position = file === null && frame.position !== false ? stepPosition(id, step) : null
  return (
    <>
      <Frame
        label={frame.label ?? position?.label ?? ""}
        position={position}
        title={frame.title}
        busy={busy}
        onSubmit={frame.onSubmit}
        foot={frame.foot}
      >
        <div ref={body} className="grid gap-3.5">
          {frame.body}
        </div>
        {error !== "" && step !== "paste-ping" && step !== "paste-webhook" && <FormError>{error}</FormError>}
      </Frame>
      {/* Nested in the guide, so that the guide stays under it and focus comes back to Save. */}
      <UnlockDialog
        open={unlock !== null}
        purpose={unlock?.purpose ?? null}
        onClose={() => setUnlock(null)}
        onUnlocked={(until) => {
          secrets.setUnlockedUntil(until)
          const status = unlockStatus(until, Date.now(), offset)
          announce(status.open ? `Changes unlocked for ${status.remainingText}.` : "Changes unlocked.")
          const then = unlock?.then ?? null
          setUnlock(null)
          then?.()
        }}
        onRefusal={actions.refusal}
        focusReturn={() => primary.current ?? true}
      />
    </>
  )
}

/** The passphrase: typed or generated here, copied, then confirmed saved before it goes. */
function PassphraseStep({
  passphrase,
  setPassphrase,
  keep,
  hint,
  visible,
  onToggle,
  saved,
  setSaved,
}: {
  passphrase: string
  setPassphrase: (passphrase: string, show: boolean) => void
  keep: boolean
  hint: Hint | null
  visible: boolean
  onToggle: () => void
  saved: boolean
  setSaved: (saved: boolean) => void
}) {
  const announce = useAnnounce()
  const { state, copy, reset } = useCopy("Passphrase copied")
  const checkbox = useId()
  return (
    <>
      {keep && <p>Leave it empty to keep the current passphrase.</p>}
      <GuideField
        spec={{ variable: PASSPHRASE_VARIABLE, label: keep ? "New passphrase" : "Encryption passphrase", secret: true, optional: false, placeholder: `At least ${PASSPHRASE_MIN} characters` }}
        value={passphrase}
        onChange={(next) => setPassphrase(next, false)}
        keep={false}
        hints={hint === null ? [] : [hint]}
        focus
        visible={visible}
        onToggle={onToggle}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setPassphrase(drawPassphrase(), true)
            announce("Passphrase generated. Copy it into your password manager.")
          }}
          className="max-sm:h-9"
        >
          <Dices />
          Generate
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={passphrase === ""} onClick={() => void copy(passphrase)} className="max-sm:h-9">
          {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      {state === "failure" && <CopyFallback text={passphrase} onClose={reset} />}
      <Note>
        {keep
          ? "Changing it here alone cuts the offsite copy off: add the new one to the backup repository first."
          : "Copy it into your password manager now: without it the offsite copy can't be read."}
      </Note>
      <label htmlFor={checkbox} className={cn("flex cursor-pointer items-center gap-2.5", passphrase === "" && "opacity-60")}>
        <input
          id={checkbox}
          type="checkbox"
          checked={saved}
          disabled={passphrase === ""}
          onChange={(event) => setSaved(event.target.checked)}
          className="size-4 accent-primary"
        />
        I saved it
      </label>
    </>
  )
}
