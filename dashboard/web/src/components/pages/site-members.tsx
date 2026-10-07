import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, ChevronDown, Contact, Copy, Plus } from "lucide-react"
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
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { useData } from "@/components/data"
import { Banner, EmptyState, ErrorState, INPUT_DIALOG, Panel, PanelSkeleton } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { SitePage } from "@/components/site"
import { putProjectMember, readProjectMembers, removeProjectMember } from "@/lib/api"
import { ago } from "@/lib/format"
import { ROLE_CHOICES, invitationLine, memberRefusal, roleLabel, validateMemberForm, type MemberErrors } from "@/lib/members"
import type { ProjectMembersResponse, Role } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A project's members, for its Project admins: who holds a role on it, and
 * nothing of their other projects. A Project admin gives a role on this
 * project, at most their own, under their unlock, a forced sign-in at the
 * provider; taking a role away needs none, so that closing someone out never
 * waits. The steward judges each change, and names the Project admin in the
 * journal; the super admin keeps the machine's Members page.
 */

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; page: ProjectMembersResponse }

type Editing = { open: boolean; opening: number; email: string | null; role: Role }

type Member = ProjectMembersResponse["members"][number]

const SELECT =
  "h-10 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent pr-9 pl-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-9 sm:text-sm dark:bg-input/30"

const CHEVRON = "pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"

/** Someone invited on this project, or a member's role on it changed. */
function RoleDialog({
  slug,
  editing,
  allowedDomains,
  onClose,
  onSaved,
  onLocked,
  onSessionExpired,
}: {
  slug: string
  editing: Editing
  allowedDomains: readonly string[]
  onClose: () => void
  onSaved: (email: string, change: "invite" | "role" | "none") => void
  onLocked: () => void
  onSessionExpired: () => void
}) {
  const [email, setEmail] = useState(editing.email ?? "")
  const [role, setRole] = useState<Role>(editing.role)
  const [errors, setErrors] = useState<MemberErrors>({})
  const [formError, setFormError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const emailField = useRef<HTMLInputElement>(null)
  const emailId = useId()
  const roleId = useId()
  const fresh = editing.email === null

  async function save(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return
    const faults = validateMemberForm(email, [{ slug, role }], fresh ? allowedDomains : [])
    setErrors(faults)
    setFormError("")
    if (faults.email !== undefined) return emailField.current?.focus()
    setInProgress(true)
    try {
      const address = email.trim().toLowerCase()
      const { status, body } = await putProjectMember(slug, address, role)
      if (status === 401) {
        onClose()
        return onSessionExpired()
      }
      if (status === 423) {
        onClose()
        return onLocked()
      }
      if ((status !== 200 && status !== 201) || body === null || body.member === undefined) {
        const refusal = memberRefusal(status, body)
        if (refusal.field === "email") return setErrors({ email: refusal.message })
        return setFormError(refusal.message)
      }
      onSaved(address, body.change)
      onClose()
    } finally {
      setInProgress(false)
    }
  }

  return (
    <Dialog
      open={editing.open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onClose()
      }}
    >
      <DialogContent className={cn("gap-5 sm:max-w-md", INPUT_DIALOG)} initialFocus={() => emailField.current}>
        <form noValidate onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{fresh ? `Invite someone to ${slug}` : `Role of ${editing.email} on ${slug}`}</DialogTitle>
            <DialogDescription className="text-pretty">
              {fresh
                ? `They sign in with their work account, and see ${slug} with the role you give them. Their other projects are not yours to see.`
                : `Their role on ${slug} alone: their other projects stay as they are.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={emailId}>Work email</Label>
            <Input
              ref={emailField}
              id={emailId}
              type="email"
              value={email}
              readOnly={!fresh}
              autoComplete="off"
              onChange={(event) => {
                setEmail(event.target.value)
                setErrors(({ email: _, ...rest }) => rest)
              }}
              aria-invalid={errors.email !== undefined || undefined}
              aria-describedby={errors.email !== undefined ? `${emailId}-error` : undefined}
              className="h-10 sm:h-9"
            />
            {errors.email !== undefined && (
              <p id={`${emailId}-error`} role="alert" className="text-xs text-destructive">
                {errors.email}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={roleId}>Role on {slug}</Label>
            <div className="relative">
              <select id={roleId} value={role} onChange={(event) => setRole(event.target.value as Role)} className={SELECT}>
                {ROLE_CHOICES.map((choice) => (
                  <option key={choice.role} value={choice.role} className="text-foreground">
                    {choice.label}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" className={CHEVRON} />
            </div>
            <ul className="grid gap-0.5 text-xs text-muted-foreground">
              {ROLE_CHOICES.map((choice) => (
                <li key={choice.role}>
                  <span className="font-medium text-foreground">{choice.label}</span>: {choice.help}
                </li>
              ))}
            </ul>
          </div>

          {formError !== "" && <Banner tone="error">{formError}</Banner>}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>
            <Button type="submit" disabled={inProgress} className="max-sm:h-11">
              {inProgress ? "Saving…" : fresh ? "Invite" : "Save role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The line to send, copied as it is. */
function InvitationLine({ text }: { text: string }) {
  const { state, copy, reset } = useCopy("Message copied")
  return (
    <Panel title="Send them the link" description="No email is sent: send this yourself. It opens nothing by itself, they still sign in.">
      {state === "failure" ? (
        <CopyFallback text={text} onClose={reset} />
      ) : (
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
          <p className="min-w-0 flex-1 text-sm wrap-anywhere">{text}</p>
          <Button variant="outline" size="sm" onClick={() => void copy(text)} className="max-md:h-10">
            {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
            {state === "copied" ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </Panel>
  )
}

function MemberRow({ member, now, unlocked, onEdit, onRemove }: { member: Member; now: number; unlocked: boolean; onEdit: () => void; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <span className="font-medium wrap-anywhere">{member.email}</span>
        <p className="text-xs text-muted-foreground">{roleLabel(member.role)}</p>
      </div>
      <span className="text-xs text-muted-foreground tabular-nums max-md:basis-full">
        changed {ago(now - member.updatedAt)}, invited by {member.invitedBy}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onEdit} className="max-md:h-10">
          {unlocked ? "Change role" : "Unlock to change"}
        </Button>
        <Button variant="outline" size="sm" onClick={onRemove} className="max-md:h-10">
          Remove
        </Button>
      </div>
    </li>
  )
}

function Content({ slug }: { slug: string }) {
  const { now, offset, sessionExpired } = useData()
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const serverNow = now + offset
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [editing, setEditing] = useState<Editing>({ open: false, opening: 0, email: null, role: "viewer" })
  const [removing, setRemoving] = useState<{ member: Member | null; open: boolean; inProgress: boolean; error: string }>({
    member: null,
    open: false,
    inProgress: false,
    error: "",
  })

  const reload = useCallback(async () => {
    const { status, body } = await readProjectMembers(slug)
    if (status === 401) return sessionExpired()
    if (status !== 200 || body === null || !Array.isArray(body.members)) {
      const message = body?.message ?? "The dashboard did not answer, or the steward did not."
      setLoaded((previous) => (previous.state === "ready" ? previous : { state: "failed", message }))
      return
    }
    setLoaded({ state: "ready", page: body })
  }, [slug, sessionExpired])

  useEffect(() => {
    void reload()
  }, [reload])

  function edit(member: Member | null) {
    // The unlock first: the dialog would only end in a 423.
    if (!actions.state.open) return actions.unlock()
    setEditing((previous) => ({ open: true, opening: previous.opening + 1, email: member?.email ?? null, role: member?.role ?? "viewer" }))
  }

  async function remove() {
    const member = removing.member
    if (member === null) return
    setRemoving((previous) => ({ ...previous, inProgress: true, error: "" }))
    const { status, body } = await removeProjectMember(slug, member.email)
    if (status === 401) {
      setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
      return sessionExpired()
    }
    if (status !== 200) {
      setRemoving((previous) => ({ ...previous, inProgress: false, error: body?.message ?? `Refused (${status}).` }))
      return
    }
    setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
    announce(body?.change === "remove" ? `${member.email} removed: ${slug} was their last project.` : `${member.email} no longer has a role on ${slug}.`)
    void reload()
  }

  const page = loaded.state === "ready" ? loaded.page : null

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        Who holds a role on {slug}, as its Project admin sees them. You give a role at most your own, on {slug} alone,
        after signing in again with your provider; taking one away needs nothing more.
      </p>

      {actions.unlockNotice !== null && <Banner tone="error">{actions.unlockNotice}</Banner>}
      {loaded.state === "loading" && <PanelSkeleton lines={4} />}
      {loaded.state === "failed" && (
        <Panel title="Members">
          <ErrorState title="Can't read the members" onRetry={() => void reload()}>
            {loaded.message}
          </ErrorState>
        </Panel>
      )}

      {page !== null && (
        <Panel
          title={`Members of ${slug}`}
          count={page.members.length}
          full
          actions={
            <Button size="sm" onClick={() => edit(null)} className="max-md:h-10">
              <Plus />
              {actions.state.open ? "Invite" : "Unlock to invite"}
            </Button>
          }
        >
          {page.members.length === 0 ? (
            <EmptyState icon={Contact} title="No member yet">
              Invite someone by their work email.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-divider">
              {page.members.map((member) => (
                <MemberRow
                  key={member.email}
                  member={member}
                  now={serverNow}
                  unlocked={actions.state.open}
                  onEdit={() => edit(member)}
                  onRemove={() => setRemoving({ member, open: true, inProgress: false, error: "" })}
                />
              ))}
            </ul>
          )}
        </Panel>
      )}

      {page !== null && <InvitationLine text={invitationLine(page.dashboardUrl, page.providerName)} />}

      {page !== null && (
        <RoleDialog
          key={editing.opening}
          slug={slug}
          editing={editing}
          allowedDomains={page.signIn.allowedDomains}
          onClose={() => setEditing((previous) => ({ ...previous, open: false }))}
          onSaved={(email, change) => {
            announce(change === "invite" ? `${email} invited to ${slug}.` : change === "role" ? `Role of ${email} on ${slug} saved.` : "Nothing changed.")
            void reload()
          }}
          onLocked={() => actions.unlock()}
          onSessionExpired={sessionExpired}
        />
      )}
      <AlertDialog
        open={removing.open}
        onOpenChange={(next) => {
          if (!next && !removing.inProgress) setRemoving((previous) => ({ ...previous, open: false }))
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-left max-sm:place-items-start">
            <AlertDialogTitle>
              Take {removing.member?.email} off {slug}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              They lose {slug} at their next request. If it was their last project, they are no member any more.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removing.error !== "" && <Banner tone="error">{removing.error}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={removing.inProgress} onClick={() => void remove()} className="max-sm:h-11">
              {removing.inProgress ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** A project's members, under `/site/members/?s=<slug>`, for its Project admins. */
export function ProjectMembersSection({ slug }: { slug: string }) {
  const { secrets } = useData()
  // The lock appears once the secrets were read: a steward that does not answer would refuse it.
  const actions = secrets.projects === null ? undefined : <SecretsLockControl />
  return (
    <SitePage slug={slug} section="members" actions={actions} skeleton={<PanelSkeleton lines={4} />}>
      {() => <Content slug={slug} />}
    </SitePage>
  )
}
