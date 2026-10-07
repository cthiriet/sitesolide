import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, ChevronDown, Contact, Copy, Plus, Trash2 } from "lucide-react"
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
import { Banner, EmptyState, ErrorState, INPUT_DIALOG, PageBody, PageHeader, Panel, PanelSkeleton } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { putMember, readMembers, removeMember } from "@/lib/api"
import { ago } from "@/lib/format"
import {
  ROLE_CHOICES,
  invitationLine,
  memberRefusal,
  rolesFromRows,
  rolesSummary,
  rowsFromRoles,
  validateMemberForm,
  type MemberErrors,
  type RoleRow,
} from "@/lib/members"
import type { MemberView, MembersPageResponse, Role } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The members: people the super admin invites by email, who sign in with the
 * portal's identity provider and hold a role on each project. Machine level,
 * beside Team, and the super admin's alone.
 *
 * The page reads `/api/members` itself: the registry is the steward's, and
 * changes only through this page and `sitesolide members`. Inviting or
 * changing roles needs the dashboard unlocked, as creating a token does;
 * removing does not, so that closing someone out never waits for a password.
 * No email is sent: the page gives the line to send.
 */

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; page: MembersPageResponse }

type Editing = { open: boolean; opening: number; member: MemberView | null }

/** The guest dialog's select, the one native control the page styles: see guest-dialogs.tsx. */
const SELECT =
  "h-10 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent pr-9 pl-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-9 sm:text-sm dark:bg-input/30"

const CHEVRON = "pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"

/** The invitation, or a member's roles changed: one form, the email fixed for a change. */
function MemberDialog({
  open,
  member,
  projects,
  allowedDomains,
  onClose,
  onSaved,
  onLocked,
  onSessionExpired,
}: {
  open: boolean
  /** null: a new member. */
  member: MemberView | null
  projects: readonly string[]
  allowedDomains: readonly string[]
  onClose: () => void
  onSaved: (member: MemberView, change: "invite" | "role" | "none") => void
  onLocked: () => void
  onSessionExpired: () => void
}) {
  const [email, setEmail] = useState(member?.email ?? "")
  const [rows, setRows] = useState<RoleRow[]>(() => (member === null ? [{ slug: projects[0] ?? "", role: "viewer" }] : rowsFromRoles(member.roles)))
  const [errors, setErrors] = useState<MemberErrors>({})
  const [formError, setFormError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const emailField = useRef<HTMLInputElement>(null)
  const emailId = useId()
  const rolesId = useId()

  // A role on a project since removed is listed, so that it is kept or taken off knowingly.
  const choices = [...new Set([...projects, ...rows.map((row) => row.slug).filter((slug) => slug !== "")])].sort()

  function setRow(index: number, row: RoleRow) {
    setRows((before) => before.map((one, at) => (at === index ? row : one)))
    setErrors(({ roles: _, ...rest }) => rest)
  }

  async function save(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return
    const faults = validateMemberForm(email, rows, member === null ? allowedDomains : [])
    setErrors(faults)
    setFormError("")
    if (faults.email !== undefined) return emailField.current?.focus()
    if (faults.roles !== undefined) return
    setInProgress(true)
    try {
      const { status, body } = await putMember(email.trim().toLowerCase(), rolesFromRows(rows))
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
        if (refusal.field === null) return setFormError(refusal.message)
        return setErrors({ [refusal.field]: refusal.message })
      }
      onSaved(body.member, body.change)
      onClose()
    } finally {
      setInProgress(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onClose()
      }}
    >
      <DialogContent className={cn("max-h-[calc(100svh-2rem)] gap-5 overflow-y-auto sm:max-w-lg", INPUT_DIALOG)} initialFocus={() => emailField.current}>
        <form noValidate onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{member === null ? "Invite a member" : `Roles of ${member.email}`}</DialogTitle>
            <DialogDescription className="text-pretty">
              {member === null
                ? "They sign in with their work account, and see only the projects you give them a role on."
                : "The roles below replace theirs: a project left out is one they no longer see."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={emailId}>Work email</Label>
            <Input
              ref={emailField}
              id={emailId}
              type="email"
              value={email}
              readOnly={member !== null}
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

          <fieldset aria-describedby={rolesId} className="grid gap-2">
            <legend className="mb-2 text-sm leading-none font-medium">Roles</legend>
            <ul className="grid gap-2">
              {rows.map((row, index) => (
                <li key={index} className="flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <select aria-label="Project" value={row.slug} onChange={(event) => setRow(index, { ...row, slug: event.target.value })} className={SELECT}>
                      {choices.map((slug) => (
                        <option key={slug} value={slug} className="text-foreground">
                          {slug}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" className={CHEVRON} />
                  </div>
                  <div className="relative w-36 shrink-0">
                    <select
                      aria-label={`Role on ${row.slug}`}
                      value={row.role}
                      onChange={(event) => setRow(index, { ...row, role: event.target.value as Role })}
                      className={SELECT}
                    >
                      {ROLE_CHOICES.map((choice) => (
                        <option key={choice.role} value={choice.role} className="text-foreground">
                          {choice.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" className={CHEVRON} />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Take ${row.slug} off`}
                    disabled={rows.length === 1}
                    onClick={() => setRows((before) => before.filter((_, at) => at !== index))}
                    className="text-muted-foreground max-md:size-10"
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={choices.length === 0}
                onClick={() => setRows((before) => [...before, { slug: choices.find((slug) => !before.some((row) => row.slug === slug)) ?? choices[0] ?? "", role: "viewer" }])}
                className="max-md:h-10"
              >
                <Plus />
                Add a project
              </Button>
            </div>
            <ul id={rolesId} className="grid gap-0.5 text-xs text-muted-foreground">
              {ROLE_CHOICES.map((choice) => (
                <li key={choice.role}>
                  <span className="font-medium text-foreground">{choice.label}</span>: {choice.help}
                </li>
              ))}
            </ul>
            {errors.roles !== undefined && (
              <p role="alert" className="text-xs text-destructive">
                {errors.roles}
              </p>
            )}
          </fieldset>

          {formError !== "" && <Banner tone="error">{formError}</Banner>}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>
            <Button type="submit" disabled={inProgress} className="max-sm:h-11">
              {inProgress ? "Saving…" : member === null ? "Invite" : "Save roles"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The line to send, copied as it is: where to go and with which account. */
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

function MemberRow({ member, now, onEdit, onRemove }: { member: MemberView; now: number; onEdit: () => void; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <span className="font-medium wrap-anywhere">{member.email}</span>
        <p className="text-xs text-muted-foreground">{rolesSummary(member.roles)}</p>
      </div>
      <span className="text-xs text-muted-foreground tabular-nums max-md:basis-full">
        invited {ago(now - member.createdAt)} by {member.invitedBy}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onEdit} className="max-md:h-10">
          Change roles
        </Button>
        <Button variant="outline" size="sm" onClick={onRemove} className="max-md:h-10">
          Remove
        </Button>
      </div>
    </li>
  )
}

export function MembersPage() {
  const { now, offset, sessionExpired } = useData()
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const serverNow = now + offset
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [editing, setEditing] = useState<Editing>({ open: false, opening: 0, member: null })
  const [removing, setRemoving] = useState<{ member: MemberView | null; open: boolean; inProgress: boolean; error: string }>({
    member: null,
    open: false,
    inProgress: false,
    error: "",
  })

  const reload = useCallback(async () => {
    const { status, body } = await readMembers()
    if (status === 401) return sessionExpired()
    if (status !== 200 || body === null || !Array.isArray(body.members)) {
      setLoaded((previous) => (previous.state === "ready" ? previous : { state: "failed" }))
      return
    }
    setLoaded({ state: "ready", page: body })
  }, [sessionExpired])

  useEffect(() => {
    void reload()
  }, [reload])

  function edit(member: MemberView | null) {
    // The unlock first, as for a token: the dialog would only end in a 423.
    if (!actions.state.open) return actions.unlock()
    setEditing((previous) => ({ open: true, opening: previous.opening + 1, member }))
  }

  async function remove() {
    const member = removing.member
    if (member === null) return
    setRemoving((previous) => ({ ...previous, inProgress: true, error: "" }))
    const { status, body } = await removeMember(member.email)
    if (status === 401) {
      setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
      return sessionExpired()
    }
    if (status !== 200) {
      setRemoving((previous) => ({ ...previous, inProgress: false, error: body?.message ?? `Refused (${status}).` }))
      return
    }
    setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
    announce(`${member.email} removed.`)
    void reload()
  }

  const page = loaded.state === "ready" ? loaded.page : null

  return (
    <>
      <PageHeader title="Members" actions={<SecretsLockControl />} />
      <PageBody>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          A member signs in to this dashboard with their work account, through the portal's identity provider, and sees only
          the projects you give them a role on. A Developer or a Project admin also restarts their projects' services.
        </p>

        {loaded.state === "loading" && <PanelSkeleton lines={4} />}
        {loaded.state === "failed" && (
          <Panel title="Members">
            <ErrorState title="Can't read the members" onRetry={() => void reload()}>
              The dashboard did not answer, or the steward did not.
            </ErrorState>
          </Panel>
        )}

        {page !== null && !page.available && <Banner tone="attention">{page.reason}</Banner>}
        {page !== null && page.available && !page.signIn.configured && (
          <Banner tone="attention">
            Signing in with a work account isn't set up on this machine: members can't sign in until the portal has an
            identity provider. See the portal's README, "Signing in with a work account".
          </Banner>
        )}

        {page !== null && page.available && (
          <Panel
            title="Members"
            count={page.members.length}
            full
            actions={
              <Button size="sm" onClick={() => edit(null)} disabled={page.projects.length === 0} className="max-md:h-10">
                <Plus />
                {actions.state.open ? "Invite" : "Unlock to invite"}
              </Button>
            }
          >
            {page.members.length === 0 ? (
              <EmptyState icon={Contact} title="No member yet">
                Invite someone by their work email, with a role on each project they work on.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-divider">
                {page.members.map((member) => (
                  <MemberRow
                    key={member.email}
                    member={member}
                    now={serverNow}
                    onEdit={() => edit(member)}
                    onRemove={() => setRemoving({ member, open: true, inProgress: false, error: "" })}
                  />
                ))}
              </ul>
            )}
          </Panel>
        )}

        {page !== null && page.available && <InvitationLine text={invitationLine(page.dashboardUrl, page.providerName)} />}
      </PageBody>

      {page !== null && (
        <MemberDialog
          key={editing.opening}
          open={editing.open}
          member={editing.member}
          projects={page.projects}
          allowedDomains={page.signIn.allowedDomains}
          onClose={() => setEditing((previous) => ({ ...previous, open: false }))}
          onSaved={(member, change) => {
            announce(change === "invite" ? `${member.email} invited.` : change === "role" ? `Roles of ${member.email} saved.` : "Nothing changed.")
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
            <AlertDialogTitle>Remove {removing.member?.email}?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              They are signed out at once, and refused at their next request. Invite them again to give them back a role.
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
