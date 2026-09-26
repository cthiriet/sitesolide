/**
 * The page's four status tones, and their classes. Pure.
 *
 * A tone states a judgement, never a decoration: `ok` running and up to date,
 * `attention` worth a look, `error` to deal with, `neutral` a piece of
 * information. The colours are the tokens from styles/global.css (`ok`,
 * `attention`, `destructive`), never the Tailwind palette: the red is the one
 * from the sitesolide seal, and it only serves errors.
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
  neutral: "bg-muted-foreground",
}

/** A word on its own, with no fill. */
export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok-text",
  attention: "text-attention-text",
  error: "text-destructive",
  neutral: "text-muted-foreground",
}

/** A pill: the tinted fill and its text, contrasts measured in global.css. */
export const TONE_PILL: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok-text",
  attention: "bg-attention/12 text-attention-text",
  error: "bg-destructive/10 text-destructive",
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
