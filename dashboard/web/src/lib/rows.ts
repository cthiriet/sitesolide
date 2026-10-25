/**
 * What a click on a list's row does. Pure, tested by tests/sites.test.ts
 * and tests/list-state.test.ts; components/data-table.tsx wires it.
 */
import type { Click } from "./pages"

/**
 * What a click on a row does, outside its link or button.
 *
 * The name is the real link, or the button that opens the row's sheet: the
 * one for the keyboard and for screen readers. The rest of the row follows
 * the click in code rather than through a link stretched over the whole row:
 * a link laid on top would stop you selecting an address, a path or a number.
 * A click on an element that already acts (link, button, field, menu) belongs
 * to it; a click that ends a text selection does nothing. Cmd, Ctrl and the
 * middle button open a page in a new tab, as on a link; Shift and Alt do
 * nothing. A row that opens a sheet has no tab to open: its caller treats
 * "tab" as "page".
 */
export function rowClickOutcome(click: Click, interactive: boolean, selection: string): "page" | "tab" | null {
  if (click.defaultPrevented || interactive || selection !== "") return null
  if (click.button === 1) return "tab"
  if (click.button !== 0 || click.shiftKey || click.altKey) return null
  return click.metaKey || click.ctrlKey ? "tab" : "page"
}

/** The elements that keep their click to themselves, inside a clickable row. */
export const INTERACTIVE = "a, button, input, textarea, select, label, [role='button'], [role='menuitem']"
