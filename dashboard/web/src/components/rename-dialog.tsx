import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { CircleCheck, CircleX, PencilLine } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { useNavigation } from "@/components/navigation"
import { FormError, INPUT_DIALOG } from "@/components/page"
import { WriteButton } from "@/components/unlock"
import { renameProject } from "@/lib/api"
import { siteUrl } from "@/lib/pages"
import { renameFormError, renameRefusal, suggestedSlug } from "@/lib/rename"
import { TONE_TEXT } from "@/lib/tones"
import { cn } from "@/lib/utils"

type Phase =
  | { phase: "form" }
  | { phase: "in-progress" }
  | { phase: "succeeded"; to: string; url: string }
  | { phase: "failure"; message: string; log: string[] }

/**
 * Renaming a project, the owner's: one field, the new name, which is also
 * its address under the zone, shown as it is typed. The server moves
 * everything the name spells, then the dialog says where the site now
 * answers and leads to it. The service is down a few seconds meanwhile.
 */
export function RenameButton({ slug, zone }: { slug: string; zone: string | null }) {
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(0)
  const busy = useRef(false)
  return (
    <>
      <WriteButton
        variant="outline"
        size="sm"
        purpose="rename the project"
        resume="Rename"
        onPress={() => {
          setOpening((count) => count + 1)
          setOpen(true)
        }}
      >
        <PencilLine aria-hidden="true" />
        Rename
      </WriteButton>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy.current) setOpen(false)
        }}
      >
        <DialogContent showCloseButton={false} className={cn("gap-5 sm:max-w-lg", INPUT_DIALOG)}>
          {open && <RenameFlow key={opening} slug={slug} zone={zone} busy={busy} onClose={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function RenameFlow({ slug, zone, busy, onClose }: { slug: string; zone: string | null; busy: { current: boolean }; onClose: () => void }) {
  const announce = useAnnounce()
  const { refresh, sessionExpired, secrets } = useData()
  const { navigate } = useNavigation()
  const [phase, setPhase] = useState<Phase>({ phase: "form" })
  const [entry, setEntry] = useState("")
  const [error, setError] = useState("")
  const inputId = useId()
  const hintId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const to = suggestedSlug(entry)

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
    const fault = renameFormError(slug, to)
    if (fault !== null) return setError(fault)
    setError("")
    setPhase({ phase: "in-progress" })
    announce(`Renaming ${slug} to ${to}`)
    const { status, body } = await renameProject(slug, to)
    if (status === 401) {
      onClose()
      return sessionExpired()
    }
    if (status === 423) {
      secrets.setUnlockedUntil(null)
      setPhase({ phase: "form" })
      return setError("Changes locked again meanwhile: unlock, then rename.")
    }
    if (status === 200 && body !== null && typeof body.url === "string") {
      setPhase({ phase: "succeeded", to, url: body.url })
      announce(`${slug} is now ${to}`)
      refresh()
      return
    }
    const message = renameRefusal(status, body)
    setPhase({ phase: "failure", message, log: Array.isArray(body?.log) ? body.log.filter((line): line is string => typeof line === "string") : [] })
    announce(`Rename failed. ${message}`)
  }

  if (phase.phase === "succeeded" || phase.phase === "failure") {
    const success = phase.phase === "succeeded"
    const Icon = success ? CircleCheck : CircleX
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon aria-hidden="true" className={cn("size-5 shrink-0", TONE_TEXT[success ? "ok" : "error"])} />
            {success ? `${slug} is now ${phase.to}` : "Rename failed"}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {success ? (
              <>
                It answers at <span className="font-mono text-foreground">{phase.url.replace(/^https:\/\//, "").replace(/\/$/, "")}</span>, and its own domain, if it has one, as before. The next{" "}
                <span className="font-mono">sitesolide deploy</span> from its folder writes the new name into sitesolide.json: commit it.
              </>
            ) : (
              phase.message
            )}
          </DialogDescription>
        </DialogHeader>
        {!success && phase.log.length > 0 && (
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{phase.log.join("\n")}</pre>
        )}
        <DialogFooter>
          {success ? (
            <Button
              ref={closeButton}
              className="max-sm:h-11"
              onClick={() => {
                onClose()
                navigate(siteUrl(phase.to))
              }}
            >
              Open {phase.to}
            </Button>
          ) : (
            <DialogClose render={<Button ref={closeButton} className="max-sm:h-11" />}>Close</DialogClose>
          )}
        </DialogFooter>
      </>
    )
  }

  const inProgress = phase.phase === "in-progress"
  return (
    <form noValidate onSubmit={confirm} className="grid gap-5" aria-busy={inProgress || undefined}>
      <DialogHeader>
        <DialogTitle>{inProgress ? `Renaming ${slug}` : `Rename ${slug}`}</DialogTitle>
        <DialogDescription className="text-pretty">
          The name is also its address. Its files, data, secrets, people with access and tokens follow; its service stops for a few seconds. The old address stops answering.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label htmlFor={inputId}>New name</Label>
        <Input
          id={inputId}
          value={entry}
          autoFocus
          disabled={inProgress}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={slug}
          onChange={(event) => {
            setEntry(event.target.value)
            setError("")
          }}
          aria-invalid={error !== "" || undefined}
          aria-describedby={hintId}
          className="h-10 font-mono sm:h-9"
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {to === "" ? "Lowercase letters, digits and dashes." : (
            <>
              New address: <span className="font-mono text-foreground">{to}.{zone ?? "your zone"}</span>
            </>
          )}
        </p>
        <FormError>{error}</FormError>
      </div>

      {inProgress && <p className="text-xs text-pretty text-muted-foreground">Usually under a minute, a few more while the hourly backup finishes. Keep this open: the result always comes, and a failure puts everything back.</p>}

      <DialogFooter>
        {!inProgress && <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>}
        <Button type="submit" disabled={inProgress || to === "" || to === slug} className="max-sm:h-11">
          {inProgress ? "Renaming..." : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  )
}
