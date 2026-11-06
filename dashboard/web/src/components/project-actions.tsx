import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { CircleCheck, CircleX, Power, PowerOff, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { RowMenu } from "@/components/data-table"
import { useNavigation } from "@/components/navigation"
import { FormError, INPUT_DIALOG } from "@/components/page"
import { RenameButton } from "@/components/rename-dialog"
import { WriteMenuItem } from "@/components/unlock"
import { projectLifecycle } from "@/lib/api"
import { lifecycleTexts, type LifecycleAction } from "@/lib/lifecycle"
import { renameRefusal } from "@/lib/rename"
import { TONE_TEXT } from "@/lib/tones"
import { cn } from "@/lib/utils"

/**
 * The project's own actions, the owner's, in its Overview's header: *Rename*,
 * then behind the "..." *Turn off* or *Turn on*, and last, destructive and
 * under a separator, *Delete project*, the slug retyped. Each asks for the
 * unlock first, then a confirmation that says what it does, waits for the
 * server, and says what happened.
 */
export function ProjectActions({ slug, zone, disabled }: { slug: string; zone: string | null; disabled: boolean }) {
  const [action, setAction] = useState<LifecycleAction | null>(null)
  const [opening, setOpening] = useState(0)
  const busy = useRef(false)
  const open = (next: LifecycleAction) =>
    // After the menu has closed, which would otherwise take the focus back.
    setTimeout(() => {
      setOpening((count) => count + 1)
      setAction(next)
    }, 0)
  return (
    <>
      {!disabled && <RenameButton slug={slug} zone={zone} />}
      <RowMenu label={`More actions for ${slug}`}>
        <WriteMenuItem onPress={() => open(disabled ? "enable" : "disable")} purpose={disabled ? "turn the project on" : "turn the project off"} resume={disabled ? "Turn on" : "Turn off"}>
          {disabled ? <Power /> : <PowerOff />}
          {disabled ? "Turn on" : "Turn off"}
        </WriteMenuItem>
        <DropdownMenuSeparator />
        <WriteMenuItem variant="destructive" onPress={() => open("remove")} purpose="delete the project" resume="Delete project">
          <Trash2 />
          Delete project
        </WriteMenuItem>
      </RowMenu>
      <Dialog
        open={action !== null}
        onOpenChange={(next) => {
          if (!next && !busy.current) setAction(null)
        }}
      >
        <DialogContent showCloseButton={false} className={cn("gap-5 sm:max-w-lg", action === "remove" && INPUT_DIALOG)}>
          {action !== null && <LifecycleFlow key={opening} slug={slug} action={action} busy={busy} onClose={() => setAction(null)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

type Phase = { phase: "form" } | { phase: "in-progress" } | { phase: "succeeded" } | { phase: "failure"; message: string; log: string[] }

function LifecycleFlow({ slug, action, busy, onClose }: { slug: string; action: LifecycleAction; busy: { current: boolean }; onClose: () => void }) {
  const announce = useAnnounce()
  const { refresh, sessionExpired, secrets } = useData()
  const { navigate } = useNavigation()
  const texts = lifecycleTexts(slug, action)
  const [phase, setPhase] = useState<Phase>({ phase: "form" })
  const [entry, setEntry] = useState("")
  const [error, setError] = useState("")
  const inputId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const typed = action === "remove"

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
    if (typed && entry.trim() !== slug) return setError(`Type ${slug} to confirm.`)
    setError("")
    setPhase({ phase: "in-progress" })
    announce(texts.running)
    const { status, body } = await projectLifecycle(slug, action, typed ? entry.trim() : "")
    if (status === 401) {
      onClose()
      return sessionExpired()
    }
    if (status === 423) {
      secrets.setUnlockedUntil(null)
      setPhase({ phase: "form" })
      return setError("Changes locked again meanwhile: unlock, then try again.")
    }
    if (status === 200) {
      announce(texts.succeeded)
      // A project deleted leaves no page to stay on: back to every site, which says it is gone.
      if (action === "remove") {
        onClose()
        navigate("/")
        refresh()
        return
      }
      setPhase({ phase: "succeeded" })
      refresh()
      return
    }
    const message = renameRefusal(status, body)
    setPhase({ phase: "failure", message, log: Array.isArray(body?.log) ? body.log.filter((line): line is string => typeof line === "string") : [] })
    announce(`${texts.failed}. ${message}`)
  }

  if (phase.phase === "succeeded" || phase.phase === "failure") {
    const success = phase.phase === "succeeded"
    const Icon = success ? CircleCheck : CircleX
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon aria-hidden="true" className={cn("size-5 shrink-0", TONE_TEXT[success ? "ok" : "error"])} />
            {success ? texts.succeeded : texts.failed}
          </DialogTitle>
          <DialogDescription className="text-pretty">{success ? texts.after : phase.message}</DialogDescription>
        </DialogHeader>
        {!success && phase.log.length > 0 && (
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{phase.log.join("\n")}</pre>
        )}
        <DialogFooter>
          <DialogClose render={<Button ref={closeButton} className="max-sm:h-11" />}>Close</DialogClose>
        </DialogFooter>
      </>
    )
  }

  const inProgress = phase.phase === "in-progress"
  return (
    <form noValidate onSubmit={confirm} className="grid gap-5" aria-busy={inProgress || undefined}>
      <DialogHeader>
        <DialogTitle>{inProgress ? texts.running : texts.title}</DialogTitle>
        <DialogDescription className="text-pretty">{texts.consequence}</DialogDescription>
      </DialogHeader>
      {typed && (
        <div className="grid gap-2">
          <Label htmlFor={inputId}>
            Type <span className="font-mono">{slug}</span> to confirm
          </Label>
          <Input
            id={inputId}
            value={entry}
            autoFocus
            disabled={inProgress}
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
        </div>
      )}
      <FormError>{error}</FormError>
      {inProgress && <p className="text-xs text-pretty text-muted-foreground">Usually under a minute, a few more while the hourly backup finishes. Keep this open: the result always comes.</p>}
      <DialogFooter>
        {!inProgress && <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>}
        <Button
          type="submit"
          autoFocus={!typed}
          variant={action === "enable" ? "default" : "destructive"}
          disabled={inProgress || (typed && entry.trim() !== slug)}
          className="max-sm:h-11"
        >
          {inProgress ? texts.actionRunning : texts.action}
        </Button>
      </DialogFooter>
    </form>
  )
}
