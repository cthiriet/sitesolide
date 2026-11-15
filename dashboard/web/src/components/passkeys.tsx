import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { KeyRound, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useData } from "@/components/data"
import { FormError, Panel } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { UnlockDialog } from "@/components/secrets-dialogs"
import { announcePasskeysChanged } from "@/hooks/use-owner-passkeys"
import { dateTime } from "@/lib/format"
import { refusalOf } from "@/lib/secrets"
import { PASSKEYS_PANEL_ID } from "@/lib/server-setup"
import { ceremonyMessage, passkeysSupported, readPasskeys, registerPasskey, removePasskey, type PasskeyView } from "@/lib/webauthn"

/** What the owner is told while they hold one passkey: a lost device would leave root's link as the only way in. */
const ONE_PASSKEY = "Add a second one on another device or a security key. Lose your only passkey and only root, over SSH, can let you back in."

/**
 * The owner's passkeys, on the Server page: listed by name, one added from
 * this browser, one removed. Adding and removing ask for the unlock, a fresh
 * assertion, which the steward checks; the last passkey stays, root removes
 * it over SSH. The steward verifies every ceremony: this panel only runs the
 * browser's prompt and relays.
 */
export function PasskeysPanel() {
  const { secrets } = useData()
  const actions = useSecretsActions()
  const [list, setList] = useState<PasskeyView[] | null>(null)
  const [problem, setProblem] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [unlock, setUnlock] = useState<{ purpose: string; then: () => void } | null>(null)
  const nameId = useId()
  const add = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    const { status, body } = await readPasskeys()
    if (status === 200 && body !== null && Array.isArray(body.passkeys)) {
      setList(body.passkeys)
      setProblem(body.readable === false ? "The server can't read its passkey list. No passkey signs in until root repairs it." : "")
    } else setProblem(ceremonyMessage(status, body as never))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const unlocked = secrets.until !== null && secrets.until > Date.now()

  /** Runs `work` once changes are unlocked, asking for the unlock first when they are not. */
  function whenUnlocked(purpose: string, work: () => Promise<void>) {
    if (unlocked) return void work()
    setUnlock({ purpose, then: () => void work() })
  }

  async function register() {
    setBusy(true)
    setProblem("")
    try {
      const result = await registerPasskey(name.trim() === "" ? "Passkey" : name.trim())
      if (result.ok) {
        setName("")
        announcePasskeysChanged()
        return void (await load())
      }
      if (result.status === 423) return secrets.setUnlockedUntil(null)
      setProblem(result.status <= 0 ? ceremonyMessage(result.status, null) : (actions.refusal(refusalOf(result.status, result.body)) ?? ""))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    setProblem("")
    try {
      const { status, body } = await removePasskey(id)
      if (status === 200 && body !== null) {
        announcePasskeysChanged()
        return setList(body.passkeys)
      }
      setProblem(actions.refusal(refusalOf(status, body)) ?? "")
    } finally {
      setBusy(false)
    }
  }

  function submit(event: SyntheticEvent) {
    event.preventDefault()
    if (busy || !passkeysSupported()) return
    whenUnlocked("add a passkey", register)
  }

  return (
    <Panel full id={PASSKEYS_PANEL_ID} title="Passkeys" count={list?.length} description="Sign in and unlock changes with your device. While one exists, the passwords are for recovery only.">
      <div className="grid gap-4 p-4">
        {list !== null && list.length === 0 && <p className="text-sm text-pretty">No passkey yet. Add one here, then a second on another device.</p>}
        {list !== null && list.length > 0 && (
          <ul aria-label="Passkeys" className="grid gap-2">
            {list.map((one) => (
              <li key={one.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="grid">
                  <span className="text-sm font-medium wrap-anywhere">{one.name}</span>
                  <span className="text-xs text-muted-foreground">
                    Added {dateTime(one.createdAt)}
                    {one.lastUsedAt === null ? ", never used" : `, last used ${dateTime(one.lastUsedAt)}`}
                  </span>
                </div>
                {list.length > 1 && (
                  <Button variant="outline" size="sm" disabled={busy} aria-label={`Remove ${one.name}`} onClick={() => whenUnlocked("remove a passkey", () => remove(one.id))}>
                    <Trash2 />
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {list !== null && list.length === 1 && <p className="text-sm text-pretty text-muted-foreground">{ONE_PASSKEY}</p>}
        <form noValidate onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2">
            <Label htmlFor={nameId}>Passkey name</Label>
            <Input id={nameId} value={name} maxLength={60} placeholder="Phone" onChange={(event) => setName(event.target.value)} className="h-10 sm:h-9" />
          </div>
          <Button ref={add} type="submit" disabled={busy || !passkeysSupported()} className="max-sm:h-11">
            <KeyRound />
            {busy ? "Waiting for the passkey…" : "Add a passkey"}
          </Button>
        </form>
        {!passkeysSupported() && <p className="text-sm text-muted-foreground">This browser doesn't offer passkeys.</p>}
        <FormError>{problem}</FormError>
      </div>
      <UnlockDialog
        open={unlock !== null}
        purpose={unlock?.purpose ?? null}
        onClose={() => setUnlock(null)}
        onUnlocked={(until) => {
          secrets.setUnlockedUntil(until)
          const then = unlock?.then ?? null
          setUnlock(null)
          then?.()
        }}
        onRefusal={actions.refusal}
        focusReturn={() => add.current ?? true}
      />
    </Panel>
  )
}
