import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import { ChevronDown, CircleCheck, CircleX, Globe, Info, KeyRound, Link2, Lock, RefreshCw, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAnnounce } from "@/components/copy"
import { Banner, FormError, INPUT_DIALOG, Panel, Tile } from "@/components/page"
import { CodeChip } from "@/components/access-word"
import { Track, useClock, type FocusReturn, type OnRefusal } from "@/components/secrets-dialogs"
import { LockGlyph } from "@/components/unlock"
import { setGeneralAccess } from "@/lib/api"
import {
  addressesLine,
  CHANGE_DURATION,
  DEPLOY_NOTE,
  changeProgress,
  changeResult,
  changeTexts,
  codeWithheld,
  confirmationValid,
  GENERAL_CHOICES,
  removalConfirmation,
  whoChanges,
  type ChangeTarget,
  type ChoiceOption,
  type GeneralReader,
  type GeneralState,
} from "@/lib/access"
import { refusalOf, succeeded } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { GeneralAccess } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * General access, the first thing a site's Access section says: how the site
 * opens, the three ways it may, and the change from one to another. All three
 * change here, through the steward and the gatekeeper; a site that opens with
 * a code shows it, its link to copy, and a new one to draw.
 */

// --- The panel ---------------------------------------------------------------------

const ICONS: Record<GeneralAccess, LucideIcon> = { public: Globe, restricted: Lock, code: KeyRound }

/** The paths a restricted site leaves to the app alone, in the words used everywhere. */
function Exemptions({ paths }: { paths: readonly string[] }) {
  return (
    <p className="text-xs text-pretty text-muted-foreground">
      Open to anyone, guarded by the app alone:{" "}
      {paths.map((path, index) => (
        <span key={path}>
          {index > 0 && " "}
          <code className="rounded-sm border bg-cell px-1.5 py-px font-mono text-xs">{path}</code>
        </span>
      ))}
    </p>
  )
}

/** The code in force, to copy or open; or, for whoever may not see it, whom to ask. */
function Code({ slug, state }: { slug: string; state: GeneralState }) {
  if (state.code === null) return <p className="text-xs text-pretty text-muted-foreground">{codeWithheld(slug)}</p>
  return <CodeChip slug={slug} code={state.code.code} url={state.code.url} large />
}

/** A quiet line under the choices: the addresses a change applies to, why nothing may change, a read that failed. */
function Note({ icon: Icon, label, children }: { icon?: LucideIcon; label?: string; children: string }) {
  return (
    <p className="flex gap-2 border-t px-4 py-3 text-xs text-pretty text-muted-foreground">
      {Icon !== undefined && <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />}
      <span>
        {label !== undefined && <span className="sr-only">{label}</span>}
        {children}
      </span>
    </p>
  )
}

/**
 * How the site opens, in one row, the share dialog's: the way's icon on its
 * tile, its name and its sentence, then what it carries, the code and its
 * link for a site that opens with one, the exempt paths of a restricted one.
 * `action`, at the row's end: *Change* for whoever may change it. `note`,
 * under the sentence: who changes it, for whoever only reads it.
 */
export function GeneralAccessLine({
  slug,
  state,
  action,
  extra,
  note,
}: {
  slug: string
  state: GeneralState
  action?: ReactNode
  /** Beside the code in force: *New code*. */
  extra?: ReactNode
  note?: string
}) {
  const choice = GENERAL_CHOICES.find((one) => one.access === state.current)!
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Tile icon={ICONS[state.current]} size={32} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-medium text-strong">{choice.title}</p>
        <p className="text-pretty text-muted-foreground">{choice.sentence}</p>
        {state.current === "code" && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Code slug={slug} state={state} />
            {extra}
          </div>
        )}
        {state.current === "restricted" && state.exemptions.length > 0 && (
          <div className="mt-1">
            <Exemptions paths={state.exemptions} />
          </div>
        )}
        {note !== undefined && <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{note}</p>}
      </div>
      {action !== undefined && <div className="flex shrink-0 items-center">{action}</div>}
    </div>
  )
}

/**
 * *Change*: the three ways a site opens, in a menu, each with its sentence,
 * the current one ticked. A way the steward refuses here is offered greyed
 * with its reason in place of its sentence. Choosing one runs its
 * confirmation, after the unlock for a way that lets more people in, which
 * carries the lock glyph while changes are locked. The choice waits for the
 * menu to close, so that focus is back on *Change* when its dialog opens.
 */
function ChangeMenu({
  slug,
  options,
  current,
  locked,
  onChoose,
}: {
  slug: string
  options: ChoiceOption[]
  current: GeneralAccess
  locked: boolean
  onChoose: (target: ChangeTarget) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button ref={trigger} variant="outline" size="sm" data-general="change" aria-label={`Change how ${slug} opens`} className="max-md:h-10" />
        }
      >
        Change
        <ChevronDown aria-hidden="true" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(value: GeneralAccess) => {
            if (value === current) return
            window.setTimeout(() => {
              trigger.current?.focus()
              onChoose(value)
            }, 0)
          }}
        >
          {options.map((option) => {
            const Icon = ICONS[option.access]
            const offered = option.current || option.available
            return (
              <DropdownMenuRadioItem
                key={option.access}
                value={option.access}
                disabled={!offered}
                closeOnClick
                data-general={option.access}
                className="items-start gap-2.5 py-2 max-md:py-2.5"
              >
                <Icon aria-hidden="true" className="mt-0.5 text-muted-foreground" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium">
                    {option.title}
                    {/* Restricting lets nobody new in: it asks for no unlock. */}
                    {locked && !option.current && option.available && option.access !== "restricted" && <LockGlyph />}
                  </span>
                  <span className="text-xs text-pretty whitespace-normal text-muted-foreground">{option.reason ?? option.sentence}</span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * In a disagreement between sitesolide.json and the server, the three ways
 * stay laid out, each side marked, *Keep* one and *Apply* the other, the
 * third a plain choice: it is an error, and it earns the room.
 */
function Chooser({
  slug,
  state,
  options,
  locked,
  onChoose,
}: {
  slug: string
  state: GeneralState
  options: ChoiceOption[]
  locked: boolean
  onChoose: (target: ChangeTarget) => void
}) {
  return (
    <ul className="divide-y divide-divider" aria-label={`How ${slug} opens`}>
      {options.map((option) => {
        const Icon = ICONS[option.access]
        return (
          <li
            key={option.access}
            aria-current={option.current ? "true" : undefined}
            className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3", option.current && "bg-highlight")}
          >
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", option.current ? "text-primary" : "text-muted-foreground")} />
            <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
              <p className={cn("flex flex-wrap items-center gap-x-2", option.current ? "font-semibold text-strong" : "font-medium")}>
                {option.title}
                {option.side !== null && <span className="text-xs font-normal text-muted-foreground">{option.side}</span>}
              </p>
              <p className="text-pretty text-muted-foreground">{option.sentence}</p>
              {option.current && option.access === "code" && (
                <div className="mt-1.5">
                  <Code slug={slug} state={state} />
                </div>
              )}
              {option.current && option.access === "restricted" && state.exemptions.length > 0 && (
                <div className="mt-1">
                  <Exemptions paths={state.exemptions} />
                </div>
              )}
              {option.reason !== null && <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{option.reason}</p>}
            </div>
            {option.available && option.action !== null && (
              <Button variant="outline" size="sm" data-general={option.access} onClick={() => onChoose(option.access)} className="max-md:h-10">
                {option.action}
                {locked && option.access !== "restricted" && <LockGlyph />}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * General access, the first thing a site's Access section says: how the site
 * opens, in one row, with *Change* for the owner and the project's Admins,
 * a menu of the three ways, each with its sentence; the code in force has
 * *New code* beside it. A disagreement with sitesolide.json is said above in
 * red and lays the three ways out with Keep and Apply. What the steward
 * refuses for one way is said in the menu, for all of them once under the
 * row. Whoever only reads it gets the row and who changes it. Nothing changes
 * until the confirmation.
 */
export function GeneralAccessPanel({
  slug,
  state,
  options,
  reader,
  renewable,
  stewardReason,
  failedNote,
  addresses,
  locked = false,
  onChoose,
}: {
  slug: string
  state: GeneralState
  options: ChoiceOption[]
  reader: GeneralReader
  /** Every address the site answers on: named when there is more than the preview. */
  addresses: string[]
  /** *New code* is offered beside the code in force. */
  renewable: boolean
  /** The steward's reason when no other choice may be taken from here, said once under the row. */
  stewardReason: string | null
  /** When who has access could not be read: the choices wait for the server. */
  failedNote: string | null
  /** Changes are locked: a way that lets more people in carries the lock glyph, and asks for the unlock when pressed. */
  locked?: boolean
  onChoose: (target: ChangeTarget) => void
}) {
  const problem =
    state.problem === null ? null : (
      <div className="border-b p-3">
        <Banner tone="error">
          <span className="font-medium">{state.problem.title}.</span> {state.problem.detail}
        </Banner>
      </div>
    )
  const addressLine = addressesLine(addresses)
  const reads = reader === "reader"
  const choosing = !reads && state.problem !== null

  return (
    <Panel title="General access" full>
      {problem}
      {choosing ? (
        <Chooser slug={slug} state={state} options={options} locked={locked} onChoose={onChoose} />
      ) : (
        <GeneralAccessLine
          slug={slug}
          state={state}
          note={reads ? whoChanges(slug) : undefined}
          action={
            !reads && options.some((option) => option.available) ? (
              <ChangeMenu slug={slug} options={options} current={state.current} locked={locked} onChoose={onChoose} />
            ) : undefined
          }
          extra={
            renewable ? (
              <Button variant="outline" size="sm" data-general="renew" onClick={() => onChoose("renew")} className="max-md:h-10">
                <RefreshCw aria-hidden="true" />
                New code
                {locked && <LockGlyph />}
              </Button>
            ) : undefined
          }
        />
      )}
      {/* Link2, not Globe: Globe says Public, and this line stands under every way. */}
      {addressLine !== null && <Note icon={Link2}>{addressLine}</Note>}
      {!reads && stewardReason !== null && (
        <Note icon={Info} label="Why it can't change here: ">
          {stewardReason}
        </Note>
      )}
      {!reads && failedNote !== null && <Note>{failedNote}</Note>}
    </Panel>
  )
}

// --- The dialog ----------------------------------------------------------------------

export type ChangeState = {
  slug: string
  target: ChangeTarget
  /** How the site opens before the change: leaving a code says the code stops working. */
  from: GeneralAccess
  /** Said before restricting a site nobody is on the list of: who will still open it. */
  warning: string | null
  /** Every address the site answers on, which the change applies to together. */
  addresses: string[]
  open: boolean
  opening: number
}

type Phase =
  | { phase: "confirmation" }
  | { phase: "in-progress"; start: number }
  | { phase: "succeeded"; detail: string; code: { code: string; url: string | null } | null }
  | { phase: "failure"; message: string }

/**
 * A change of general access: a confirmation stating what is about to
 * happen, the slug retyped to make a site public or open it with a code,
 * then the wait, which neither closes nor cancels, and finally the
 * gatekeeper's result in plain words, the code when there is one, and the
 * repository reminder. The form remounts on every opening.
 */
export function GeneralAccessDialog({
  state,
  onClose,
  onChanged,
  onRefusal,
  focusReturn,
}: {
  state: ChangeState | null
  onClose: () => void
  onChanged: (target: ChangeTarget) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const busy = useRef(false)
  const typed = state !== null && changeTexts(state.slug, state.target, state.from, state.addresses).typed
  return (
    <Dialog
      open={state?.open ?? false}
      onOpenChange={(next) => {
        if (!next && !busy.current) onClose()
      }}
    >
      <DialogContent finalFocus={focusReturn} showCloseButton={false} className={cn("gap-5 sm:max-w-lg", typed && INPUT_DIALOG)}>
        {state !== null && <ChangeFlow key={state.opening} state={state} busy={busy} onChanged={onChanged} onRefusal={onRefusal} />}
      </DialogContent>
    </Dialog>
  )
}

function ChangeFlow({
  state,
  busy,
  onChanged,
  onRefusal,
}: {
  state: ChangeState
  busy: { current: boolean }
  onChanged: (target: ChangeTarget) => void
  onRefusal: OnRefusal
}) {
  const announce = useAnnounce()
  const { slug, target } = state
  const texts = changeTexts(slug, target, state.from, state.addresses)
  const typed = texts.typed
  const [phase, setPhase] = useState<Phase>({ phase: "confirmation" })
  const [entry, setEntry] = useState("")
  const [error, setError] = useState("")
  const inputId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    busy.current = phase.phase === "in-progress"
    if (phase.phase === "succeeded" || phase.phase === "failure") closeButton.current?.focus()
  }, [phase, busy])
  useEffect(
    () => () => {
      busy.current = false
    },
    [busy],
  )

  async function confirm(event: SyntheticEvent) {
    event.preventDefault()
    if (phase.phase === "in-progress") return
    if (typed && !confirmationValid(entry, slug)) {
      setError(`Type ${slug} to confirm.`)
      return
    }
    setError("")
    setPhase({ phase: "in-progress", start: Date.now() })
    announce(texts.runningTitle)
    const access = target === "renew" ? "code" : target
    const { status, body } = await setGeneralAccess(slug, access, typed ? removalConfirmation(entry) : "", target === "renew")
    if (succeeded(status) && body !== null && typeof body.detail === "string") {
      const detail = changeResult(target, body.detail)
      const code = body.code !== undefined && body.code !== null ? body.code : null
      setPhase({ phase: "succeeded", detail, code })
      // Never through the live region: the code is on screen for whoever asked.
      announce(`${texts.succeeded}. ${detail}`)
      return onChanged(target)
    }
    const message = onRefusal(refusalOf(status, body))
    if (message === null) return
    setPhase({ phase: "failure", message })
    announce(`${texts.failure}. ${message}`)
  }

  if (phase.phase === "succeeded" || phase.phase === "failure") {
    const success = phase.phase === "succeeded"
    const Icon = success ? CircleCheck : CircleX
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon aria-hidden="true" className={cn("size-5 shrink-0", TONE_TEXT[success ? "ok" : "error"])} />
            {success ? texts.succeeded : texts.failure}
          </DialogTitle>
          <DialogDescription className="text-pretty">{success ? phase.detail : phase.message}</DialogDescription>
        </DialogHeader>
        {success && phase.code !== null && (
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">The code</p>
            <div>
              <CodeChip slug={slug} code={phase.code.code} url={phase.code.url} large />
            </div>
            <p className="text-xs text-pretty text-muted-foreground">Send the link: it opens the site and remembers the code for thirty days. It stays shown in Access.</p>
          </div>
        )}
        {success && target !== "renew" && <p className="text-sm text-pretty text-muted-foreground">{DEPLOY_NOTE}</p>}
        <DialogFooter>
          <DialogClose render={<Button ref={closeButton} className="max-sm:h-11" />}>Close</DialogClose>
        </DialogFooter>
      </>
    )
  }

  const inProgress = phase.phase === "in-progress"
  const lead = target === "public" ? `${slug} becomes public.` : `${slug} opens to anyone with its code.`
  return (
    <form noValidate onSubmit={confirm} className="grid gap-5" aria-busy={inProgress || undefined}>
      <DialogHeader>
        <DialogTitle>{inProgress ? texts.runningTitle : texts.title}</DialogTitle>
        {/* What it opens, first and in red, before what it keeps. */}
        {texts.warning !== null && !inProgress && (
          <Banner tone="error">
            <span className="font-medium">{lead}</span> {texts.warning}
          </Banner>
        )}
        <DialogDescription className="text-pretty">{texts.consequence}</DialogDescription>
      </DialogHeader>

      {target === "restricted" && !inProgress && state.warning !== null && <Banner tone="attention">{state.warning}</Banner>}

      <p className="text-xs text-pretty text-muted-foreground">{CHANGE_DURATION}</p>

      {inProgress && <ChangeWait start={phase.start} />}

      {typed && !inProgress && (
        <div className="grid gap-2">
          <Label htmlFor={inputId}>
            Type <span className="font-mono">{slug}</span> to confirm
          </Label>
          <Input
            id={inputId}
            value={entry}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setEntry(event.target.value)
              setError("")
            }}
            aria-invalid={error !== "" || undefined}
            className="h-10 font-mono sm:h-9"
          />
          <FormError>{error}</FormError>
        </div>
      )}

      <DialogFooter>
        {/* A change already under way cannot be cancelled: the gatekeeper sees it through, or rolls back. */}
        {!inProgress && <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>}
        <Button
          type="submit"
          autoFocus={!typed}
          variant={typed ? "destructive" : "default"}
          disabled={inProgress || (typed && !confirmationValid(entry, slug))}
          className="max-sm:h-11"
        >
          {inProgress ? texts.actionInProgress : texts.action}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The time elapsed, on the scale of the longest answer the relay waits for. */
function ChangeWait({ start }: { start: number }) {
  const { part, elapsed, slow } = changeProgress(useClock() - start)
  return (
    <div className="grid gap-2">
      <Track part={part} elapsed={elapsed} usual={null} finish="1.5 min" label={slow ? "Still working, taking longer than usual" : "Waiting for the server"} />
      <p className="text-xs text-pretty text-muted-foreground">
        {slow ? "The server can take a while to apply it. Keep this open: the result always comes." : "Keep this open to see the result."}
      </p>
    </div>
  )
}
