import type { ReactNode } from "react"
import { AppWindow, CalendarClock, Cog, FileQuestion, Files, Globe, KeyRound, Lock, ShieldAlert, type LucideIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ACCESS_WORDS, KIND_WORDS, accessKey, accessLines, type AccessKey, type Kind } from "@/lib/legend"
import type { Access } from "@/lib/sites"
import { cn } from "@/lib/utils"

/**
 * The icons that mean one thing everywhere (lib/legend.ts says it in
 * words): 16 px, lucide's, muted unless they carry a state. The facet menus
 * show the same icons beside the same words, which makes each menu the
 * legend of the rows below it.
 */

/** A project's kind: Files a static site, AppWindow an app, Cog background, CalendarClock scheduled, FileQuestion no manifest. */
export const KIND_ICON: Readonly<Record<Kind, LucideIcon>> = {
  static: Files,
  app: AppWindow,
  background: Cog,
  scheduled: CalendarClock,
  none: FileQuestion,
}

/** A general access: Globe public, Lock restricted, KeyRound anyone with the code, ShieldAlert a disagreement. */
export const ACCESS_ICON: Readonly<Record<AccessKey, LucideIcon>> = {
  public: Globe,
  restricted: Lock,
  code: KeyRound,
  mismatch: ShieldAlert,
}

/**
 * Public is the quiet default, muted; a site that keeps people out says so
 * in the text's colour; a disagreement is an error, in red.
 */
const ACCESS_COLOUR: Readonly<Record<AccessKey, string>> = {
  public: "text-muted-foreground",
  restricted: "text-foreground",
  code: "text-foreground",
  mismatch: "text-destructive",
}

/** An icon with its words: read by a screen reader, shown on hover, the first line strong. */
function LegendIcon({ icon: Icon, lines, className }: { icon: LucideIcon; lines: readonly string[]; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={lines.join(". ")} className={cn("inline-flex shrink-0", className)} />}
      >
        <Icon aria-hidden="true" className="size-4" />
      </TooltipTrigger>
      <TooltipContent className="grid max-w-72 justify-items-start gap-0.5 text-left">
        {lines.map((line, index) => (
          <span key={line} className={index === 0 ? "font-semibold" : "font-normal opacity-85"}>
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A project's kind, before its name. `detail` replaces the tooltip's second
 * line where the row knows more, a scheduled project's next run.
 */
export function KindIcon({ kind, detail, className }: { kind: Kind; detail?: string; className?: string }) {
  const words = KIND_WORDS[kind]
  return (
    <LegendIcon icon={KIND_ICON[kind]} lines={[words.label, detail ?? words.description]} className={cn("text-muted-foreground", className)} />
  )
}

/**
 * A site's general access as an icon, from `siteAccess`: the Access
 * section's words in its tooltip, the exempt paths of a restricted site, the
 * code of one that opens with it, both sides of a disagreement.
 */
export function AccessIcon({ access, slug, className }: { access: Access; slug?: string; className?: string }) {
  const key = accessKey(access)
  return <LegendIcon icon={ACCESS_ICON[key]} lines={accessLines(access, slug)} className={cn(ACCESS_COLOUR[key], className)} />
}

/** An icon and its word, as a facet menu or a sheet lists it: the legend itself. */
export function LegendEntry({ icon: Icon, tone, children }: { icon: LucideIcon; tone?: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone ?? "text-muted-foreground")} />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * What an access shows beside its icon: `label` for one site, a sheet's row
 * or a legend ("Access mismatch"), `facet` for the set a facet's item names
 * ("Mismatch"), `tone` the icon's colour.
 */
export function accessEntry(key: AccessKey): { icon: LucideIcon; label: string; facet: string; tone: string } {
  const words = ACCESS_WORDS[key]
  return { icon: ACCESS_ICON[key], label: words.label, facet: words.facet, tone: ACCESS_COLOUR[key] }
}

/** What a kind shows beside its icon: `label` for one project ("App"), `facet` for the set ("Apps"). */
export function kindEntry(kind: Kind): { icon: LucideIcon; label: string; facet: string } {
  const words = KIND_WORDS[kind]
  return { icon: KIND_ICON[kind], label: words.label, facet: words.facet }
}
