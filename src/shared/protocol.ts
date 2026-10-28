/**
 * The version of the upload route protocol: what `uploadHandler` and `@upstash/blob/browser` (and
 * the React hooks on top of it) say to each other. It is not the package version: a browser bundle
 * and the server it talks to ship on their own schedules, and blob-py's handler speaks the same
 * protocol from a different package entirely.
 *
 * One rule: every upload route JSON body carries it as a top-level `protocol` key, beside `phase`
 * or `constraints`. The client puts it on every POST; the server on the GET constraints document and
 * on every 2xx answer to a POST (begin, parts, end and cancel). Error answers carry none. It is
 * never a header, so it needs no CORS change.
 * Anything missing, or not a JSON number with an integer value of at least 1 (a boolean is not one),
 * is 1, which is what every release before the field existed spoke. Both sides ignore keys they do
 * not know; the rest of this depends on it.
 *
 * Every change is additive. Neither side has a minimum and nothing is ever refused over the number:
 * a newer server answers an older client the way that client expects, and a newer client sends new
 * keys only where a server that ignores them still does the right thing. At 1 there is nothing to
 * gate, so the server does not read the client's number yet; protocolOf() is how it will.
 *
 * One upload is many requests over minutes or days, and on a deploy or a rollback instances of two
 * releases answer it side by side. So each answer is read by its own number, never by one an earlier
 * call returned: 'end' can reach an older server than 'begin' did. For the same reason the
 * completion token never bumps its own `v` for an additive field, because an older instance refuses
 * a token it does not know, and a newer instance treats a token without the field as the old
 * behavior, because an older 'begin' minted it. The GET number is cached for up to two minutes and
 * a bare upload() sends no GET, so a client choosing what to send at 'begin' can be wrong about the
 * server: what it sends has to be one of those new keys an older server safely ignores.
 *
 * 1: phases begin, parts, end and cancel; the GET constraints document.
 */
export const UPLOAD_PROTOCOL = 1;

/** The protocol the other side sent. Missing, or anything but a positive integer, is 1. */
export function protocolOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}
