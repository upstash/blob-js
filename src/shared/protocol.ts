/**
 * The version of the upload route protocol: what `uploadHandler` and `@upstash/blob/browser` (and
 * the React hooks on top of it) say to each other. It is not the package version: a browser bundle
 * and the server it talks to ship on their own schedules, and blob-py's handler speaks the same
 * protocol from a different package entirely.
 *
 * It crosses the wire as a top-level `protocol` key in the JSON body, beside `phase` or
 * `constraints`, never a header, so it needs no CORS change: the server puts it on the GET
 * constraints document and on the phase 'begin' answer, the client puts it on every POST. The other
 * answers and the errors carry none. Anything missing, or not a JSON number with an integer value
 * of at least 1 (a boolean is not one), is 1, which is what every release before the field existed
 * spoke. Both sides ignore keys they do not know; the rest of this depends on it.
 *
 * Every change is additive. Neither side has a minimum and nothing is ever refused over the
 * number: a newer client uses a feature only once the server has advertised a protocol that has it,
 * and a newer server answers an older client the way that client expects. At 1 there is nothing
 * to gate, so the server does not read the client's number yet; protocolOf() is how it will.
 *
 * The GET number is cached for up to two minutes, and a rolling deploy or a rollback can answer
 * with an older server than the one that advertised it. So a feature used at 'begin' is gated on
 * the GET number and survives an answer without it, and a bare upload(), which sends no GET, never
 * uses one; anything after 'begin' is gated on its answer.
 *
 * 1: phases begin, parts, end and cancel; the GET constraints document.
 */
export const UPLOAD_PROTOCOL = 1;

/** The protocol the other side sent. Missing, or anything but a positive integer, is 1. */
export function protocolOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}
