/**
 * The durations and rules of a guest access, borrowed from the portal that
 * applies them.
 *
 * Unlike `types.ts`, this import does enter the bundle sent to the browser, and
 * that is deliberate: `borrowed/guests.ts` is pure, with no import and no call
 * to Bun, so the menu can only offer what the portal will accept.
 * `cleanLabel` takes the same road: the page validates a label with the
 * exact rule the portal will apply.
 */
export {
  DEFAULT_GUEST_DURATION_S,
  GUEST_DURATIONS,
  LABEL_MAX,
  cleanLabel,
  type Guest,
} from "../../../borrowed/guests"
