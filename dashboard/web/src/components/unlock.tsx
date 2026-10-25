import type { ComponentProps, ReactNode } from "react"
import { Lock, LockOpen, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { useOptionalSecretsActions, useSecretsActions, type RequireOptions } from "@/components/secrets-actions"
import { PAGE_TITLE_ID } from "@/lib/pages"
import { TONE_PILL } from "@/lib/tones"
import { cn } from "@/lib/utils"

/**
 * Just-in-time unlock: no page carries an *Unlock changes* button. A write
 * says what it does, *New token*, *Add*, *Restore*, carries a small lock
 * glyph while changes are locked, and when pressed asks for the unlock, then
 * performs. While unlocked, the page header shows one attention pill,
 * *Unlocked, 9 min*, whose x locks again.
 *
 * The confirmations stay what they were: the unlock comes first, then the
 * action opens its own dialog as before. What a role does not allow is not
 * offered at all; the steward judges anyway.
 */

/** The write's options: `purpose` names it in the unlock's title, `resume` is said again on a person's way back. */
export type WriteOptions = RequireOptions

/**
 * The hook under every write control, for a control that is neither a
 * button nor a menu item: a form's submit, a checkbox, a select. `locked`
 * while a press would ask for the unlock first; `run` performs, or asks first.
 */
export function useWrite(): { locked: boolean; run: (action: () => void, options?: WriteOptions) => void } {
  const actions = useSecretsActions()
  return { locked: !actions.state.open, run: actions.require }
}

/**
 * The glyph a write carries while changes are locked: small, after the
 * label, in the label's colour. Its words reach a screen reader.
 */
export function LockGlyph({ className }: { className?: string }) {
  return (
    <>
      <Lock aria-hidden="true" data-icon="inline-end" className={cn("size-3! opacity-70", className)} strokeWidth={2.25} />
      <span className="sr-only">, asks to unlock first</span>
    </>
  )
}

type WriteButtonProps = Omit<ComponentProps<typeof Button>, "onClick"> &
  WriteOptions & {
    /** The write itself, run at once while unlocked, after the unlock otherwise. */
    onPress: () => void
    /** False for a write the steward takes without the unlock: *Restrict*, *Revoke*. The button is then a plain one. */
    unlock?: boolean
  }

/**
 * A button that writes. It says what it does, never *Unlock to ...*; while
 * locked it carries the lock glyph, and a press asks for the unlock first.
 * Any `Button` prop applies, `variant` and `size` included.
 *
 *   <WriteButton onPress={openCreation} purpose="create a token" resume="New token">
 *     <Plus />
 *     New token
 *   </WriteButton>
 */
export function WriteButton({ onPress, unlock = true, beforeLeave, resume, purpose, children, ...props }: WriteButtonProps) {
  const { locked, run } = useWrite()
  return (
    <Button
      {...props}
      onClick={() => (unlock ? run(onPress, { beforeLeave, resume, purpose }) : onPress())}
    >
      {children}
      {unlock && locked && <LockGlyph />}
    </Button>
  )
}

type WriteMenuItemProps = Omit<ComponentProps<typeof DropdownMenuItem>, "onClick"> &
  WriteOptions & {
    onPress: () => void
    unlock?: boolean
  }

/** A row menu's item that writes: the same rule as `WriteButton`, the glyph at the item's end. */
export function WriteMenuItem({ onPress, unlock = true, beforeLeave, resume, purpose, children, className, ...props }: WriteMenuItemProps) {
  const { locked, run } = useWrite()
  return (
    <DropdownMenuItem
      {...props}
      onClick={() => (unlock ? run(onPress, { beforeLeave, resume, purpose }) : onPress())}
      className={cn("h-9", className)}
    >
      {children}
      {unlock && locked && <LockGlyph className="ml-auto" />}
    </DropdownMenuItem>
  )
}

/**
 * The header's pill while changes are unlocked: "Unlocked, 9 min", in
 * attention, since a value is then one press away; its x locks again at
 * once. Nothing while locked. Locking takes focus to the page's title: the
 * pill it was on is gone.
 */
export function UnlockedPill({ className }: { className?: string }): ReactNode {
  const actions = useOptionalSecretsActions()
  if (actions === null || !actions.state.open) return null
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border pr-0.5 pl-2 text-xs font-medium whitespace-nowrap tabular-nums",
        TONE_PILL.attention,
        className,
      )}
    >
      <LockOpen aria-hidden="true" className="size-3.5" />
      {/* Not a live region: a minute less is not news. The unlock and the lock are announced when they happen. */}
      {actions.state.label}
      <button
        type="button"
        aria-label="Lock changes now"
        title="Lock now"
        disabled={actions.locking}
        onClick={() => {
          document.getElementById(PAGE_TITLE_ID)?.focus()
          actions.lock()
        }}
        // A 20 px x with a hit area of 40 px on a phone, 28 px elsewhere, so that a thumb finds it.
        className="relative inline-grid size-5 place-items-center rounded-sm outline-none after:absolute after:-inset-2.5 hover:bg-attention/15 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:after:-inset-1"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  )
}
