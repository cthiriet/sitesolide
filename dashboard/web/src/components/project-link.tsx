import { useData } from "@/components/data"
import { TEXT_LINK } from "@/components/link"
import { InternalLink } from "@/components/navigation"
import { siteUrl, type Section } from "@/lib/pages"
import { cn } from "@/lib/utils"

/**
 * A project's name wherever a machine page lists it, People, Tokens and
 * Connectors, in their rows and their sheets: a link to its site, its
 * Overview unless the page is about one of its sections (People's to
 * Access, where the role is changed). A project the server does not serve,
 * a token's project not deployed yet, a grant left to a removed site, a
 * registry's leftover, stays plain text: its page would only say there is no
 * such site. Before the first snapshot, every name is a link.
 */
export function ProjectLink({ slug, section = "overview", className }: { slug: string; section?: Section; className?: string }) {
  const { snapshot } = useData()
  const served = snapshot === null || snapshot.sites.some((site) => site.slug === slug)
  if (!served) return <span className={cn("min-w-0 truncate", className)}>{slug}</span>
  return (
    <InternalLink href={siteUrl(slug, section)} className={cn(TEXT_LINK, "min-w-0 truncate", className)}>
      {slug}
    </InternalLink>
  )
}
