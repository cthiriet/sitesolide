import { useId } from "react"

/**
 * The landing page's three strata, taken as they are: the dashboard carries the
 * same mark as the landing, the topmost stratum carrying the accent and the
 * other two sinking towards the deep blue.
 *
 * The gradients are declared in the component rather than in the stylesheet, a
 * <defs> not being expressible in Tailwind utilities. Their ids go through
 * useId: they are global to the document, and two logos rendered together would
 * steal each other's colours.
 */
export function Logo({ className }: { className?: string }) {
  const prefix = useId()
  const low = `${prefix}-low`
  const middle = `${prefix}-middle`
  const high = `${prefix}-high`

  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={low} x1="3" y1="17" x2="29" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#33456b" />
          <stop offset="1" stopColor="#1d2b47" />
        </linearGradient>
        <linearGradient id={middle} x1="3" y1="11" x2="29" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5b6c92" />
          <stop offset="1" stopColor="#35446a" />
        </linearGradient>
        <linearGradient id={high} x1="3" y1="4" x2="29" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e8556b" />
          <stop offset="1" stopColor="#a51f3a" />
        </linearGradient>
      </defs>
      <path d="M16 16L29 22.5L16 29L3 22.5Z" fill={`url(#${low})`} />
      <path d="M16 9.5L29 16L16 22.5L3 16Z" fill={`url(#${middle})`} />
      <path d="M16 3L29 9.5L16 16L3 9.5Z" fill={`url(#${high})`} />
    </svg>
  )
}
