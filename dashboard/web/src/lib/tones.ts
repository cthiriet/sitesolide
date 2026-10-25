/**
 * The page's four status tones, and their classes. Pure.
 *
 * A tone states a judgement, never a decoration: `ok` running and up to date,
 * `attention` worth a look, `error` to deal with, `neutral` a piece of
 * information. The colours are the tokens from styles/global.css (`ok`,
 * `attention`, `destructive`), never the Tailwind palette: the red is the
 * error colour, not the brand's, and it only serves errors.
 *
 * The classes are spelled out in full: Tailwind only generates the ones it
 * reads in the source, and tests/tones.test.ts checks it.
 */
import type { Severity, Verdict } from "./verdict"

export type Tone = "ok" | "attention" | "error" | "neutral"

/** A dot, a bar, a tick: the solid fill. */
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok",
  attention: "bg-attention",
  error: "bg-destructive",
  neutral: "bg-faint",
}

/**
 * The soft halo around a status dot, the landing page's: the dot's own colour
 * at about a sixth, three pixels wide. Added to a dot, never to a bar.
 */
export const TONE_HALO: Record<Tone, string> = {
  ok: "ring-3 ring-ok/16",
  attention: "ring-3 ring-attention/18",
  error: "ring-3 ring-destructive/16",
  neutral: "ring-3 ring-faint/20",
}

/** A word on its own, with no fill. */
export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok-text",
  attention: "text-attention-text",
  error: "text-destructive",
  neutral: "text-muted-foreground",
}

/**
 * A pill: its hairline, its tinted fill and its text, contrasts measured in
 * global.css. The hairline only shows on a pill that draws a border.
 */
export const TONE_PILL: Record<Tone, string> = {
  ok: "border-ok/25 bg-ok/10 text-ok-text",
  attention: "border-attention/30 bg-attention/12 text-attention-text",
  error: "border-destructive/25 bg-destructive/8 text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
}

/**
 * A count on a solid badge, over an icon or beside a navigation entry: a fill
 * dark enough in light, and light enough in dark, for the card's colour to
 * read on it at 4.5:1 whatever lies below. The contrasts are in global.css.
 */
export const TONE_BADGE: Record<Tone, string> = {
  ok: "bg-ok-text text-card",
  attention: "bg-attention-text text-card",
  error: "bg-destructive text-card",
  neutral: "bg-muted text-muted-foreground",
}

/** A banner: the rule and the fill, barely tinted. */
export const TONE_BANNER: Record<"attention" | "error", string> = {
  attention: "border-attention/40 bg-attention/8",
  error: "border-destructive/35 bg-destructive/6",
}

/** A discrepancy's tone: a banner or an icon only know two of them. */
export function severityTone(severity: Severity): Extract<Tone, "error" | "attention"> {
  return severity === "error" ? "error" : "attention"
}

/** A stale snapshot is said in red: it can no longer assert anything. */
export function verdictTone(verdict: Verdict): Tone {
  switch (verdict.tone) {
    case "ok":
      return "ok"
    case "warning":
      return "attention"
    case "error":
    case "stale":
      return "error"
  }
}
