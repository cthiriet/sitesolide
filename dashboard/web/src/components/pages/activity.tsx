import { useData } from "@/components/data"
import { PageBody, PageHeader } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { SecretsLog } from "@/components/secrets-log"

/**
 * The steward's activity across the whole machine: the unlocks, which belong to
 * no site, and each site's operations, with no values at all. The lock is in
 * the header, which holds for the whole machine.
 */
export function ActivityPage() {
  const { secrets } = useData()
  // No lock until something has been read: a steward that does not answer would refuse.
  const actions = secrets.projects === null ? undefined : <SecretsLockControl />
  return (
    <>
      <PageHeader title="Activity" actions={actions} />
      <PageBody>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          Everything the steward did on this server: unlocks, reads, changes, restarts and portal changes. Each
          site shows its own under Secrets.
        </p>
        <SecretsLog />
      </PageBody>
    </>
  )
}
