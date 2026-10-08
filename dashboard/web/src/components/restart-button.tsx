import { useRef, useState } from "react"
import { CircleCheck, CircleX, RotateCw } from "lucide-react"
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
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { Banner, Status } from "@/components/page"
import { restartService } from "@/lib/api"
import { readVerdict } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { RestartVerdict } from "@/lib/types"
import { cn } from "@/lib/utils"

type Phase = { kind: "confirmation" } | { kind: "in-progress" } | { kind: "verdict"; verdict: RestartVerdict } | { kind: "refused"; message: string }

/**
 * A person's restart of their project's service, from its Overview: the cut
 * announced, the wait, then the verdict in plain words, or the steward's
 * refusal as it stands. The page offers it to a Developer and an Admin; the
 * steward decides, on the registry as it reads at that moment. The owner
 * restarts from the Secrets section, unlocked.
 */
export function RestartButton({ slug }: { slug: string }) {
  const { sessionExpired, refresh } = useData()
  const announce = useAnnounce()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: "confirmation" })
  const trigger = useRef<HTMLButtonElement>(null)

  async function restart() {
    setPhase({ kind: "in-progress" })
    const { status, body } = await restartService({ slug })
    if (status === 401) {
      setOpen(false)
      return sessionExpired()
    }
    if (status === 200 && body !== null && body.verdict !== undefined) {
      setPhase({ kind: "verdict", verdict: body.verdict })
      announce(readVerdict(body.verdict, slug).title)
      refresh()
      return
    }
    setPhase({ kind: "refused", message: body?.message ?? `Refused (${status}).` })
  }

  const busy = phase.kind === "in-progress"
  const reading = phase.kind === "verdict" ? readVerdict(phase.verdict, slug) : null
  const Icon = reading?.tone === "ok" ? CircleCheck : CircleX

  return (
    <>
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        onClick={() => {
          setPhase({ kind: "confirmation" })
          setOpen(true)
        }}
        className="max-md:h-10"
      >
        <RotateCw />
        Restart
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) setOpen(false)
        }}
      >
        <AlertDialogContent finalFocus={trigger} aria-busy={busy || undefined} className="sm:max-w-md">
          {(phase.kind === "confirmation" || phase.kind === "in-progress") && (
            <>
              <AlertDialogHeader className="text-left max-sm:place-items-start">
                <AlertDialogTitle>{busy ? `Restarting ${slug}…` : `Restart ${slug}?`}</AlertDialogTitle>
                <AlertDialogDescription className="text-pretty">
                  {slug} stops, then starts again. Requests to it fail for a few seconds in between. The page then tells you
                  whether it stayed up, usually within ten seconds.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                {!busy && <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>}
                <AlertDialogAction disabled={busy} onClick={() => void restart()} className="max-sm:h-11">
                  {busy ? "Restarting…" : "Restart service"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {reading !== null && (
            <>
              <AlertDialogHeader className="text-left max-sm:place-items-start">
                <AlertDialogTitle className="flex items-center gap-2">
                  <Icon aria-hidden="true" className={cn("size-5 shrink-0", TONE_TEXT[reading.tone])} />
                  {reading.title}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-pretty">{reading.detail}</AlertDialogDescription>
              </AlertDialogHeader>
              <div>
                <Status tone={reading.tone} shape="pill">
                  {reading.word}
                </Status>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel className="max-sm:h-11">Close</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          )}
          {phase.kind === "refused" && (
            <>
              <AlertDialogHeader className="text-left max-sm:place-items-start">
                <AlertDialogTitle>{slug} was not restarted</AlertDialogTitle>
              </AlertDialogHeader>
              <Banner tone="error">{phase.message}</Banner>
              <AlertDialogFooter>
                <AlertDialogCancel className="max-sm:h-11">Close</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
