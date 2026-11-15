import { useEffect, useState } from "react"
import { readSession } from "@/lib/api"
import { NO_PASSKEYS, PASSKEYS_CHANGED, ownerPasskeys, readPasskeys, type OwnerPasskeys } from "@/lib/webauthn"

/**
 * The owner's passkeys as the steward keeps them: the session's word on
 * whether they hold one, and the listing for how many, read again whenever
 * one is added or removed on this page (`PASSKEYS_CHANGED`). Nothing is
 * asked for a person, who has no passkey of the owner's: `NO_PASSKEYS`.
 */
export function useOwnerPasskeys(owner: boolean): OwnerPasskeys {
  const [state, setState] = useState<OwnerPasskeys>(NO_PASSKEYS)
  useEffect(() => {
    if (!owner) return
    let live = true
    const load = async () => {
      const [session, listing] = await Promise.all([readSession(), readPasskeys()])
      if (!live) return
      setState(ownerPasskeys(session.status === 200 ? session.body?.passkeys : null, listing.status === 200 ? listing.body : null))
    }
    const reload = () => void load()
    reload()
    window.addEventListener(PASSKEYS_CHANGED, reload)
    return () => {
      live = false
      window.removeEventListener(PASSKEYS_CHANGED, reload)
    }
  }, [owner])
  return state
}

/** Tells the page that the owner's passkeys changed. */
export function announcePasskeysChanged(): void {
  window.dispatchEvent(new Event(PASSKEYS_CHANGED))
}
