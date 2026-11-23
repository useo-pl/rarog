/**
 * Payload policy literals compiled into the relay. The same content stands in
 * `shared/fixtures/relay/alert-policy.json`, the contract with the server; the test `alert-policy-fixture.test.ts`
 * compares both places field by field.
 *
 * Localization keys have the `push.` prefix: the push key catalog in the app target and in the NSE,
 * then name and part, as in the package catalogs (`docs/localization.md`, "Keys").
 */

/**
 * Policy names for `ALERT_POLICY`. The only one is `v2`: the server sends v2 banners only, and a value outside the
 * list fails the configuration (`alert-policy-invalid`) instead of passing silently.
 */
export const ALERT_POLICIES = ['v2'] as const;
export type AlertPolicyName = typeof ALERT_POLICIES[number];

/** Placeholder text of the v2 banner: visible when the NSE does not decrypt the content in time. */
export const ALERT_PLACEHOLDER = { title: 'Rarog', body: 'Nowe powiadomienie' } as const;

/** The same placeholder text as app catalog keys (no `loc-args`: an argument is arbitrary plain text). */
export const ALERT_PLACEHOLDER_KEYS = {
  'title-loc-key': 'push.placeholder.title',
  'loc-key': 'push.placeholder.body',
} as const;

/**
 * The "finished" chime in a Live Activity update, equal to the server's `LIVE_ACTIVITY_CHIME`
 * (`notify/apns-payload.ts`).
 */
export const LIVE_ACTIVITY_CHIME = {
  title: 'Agent skończył',
  body: 'Wynik czeka w Rarogu',
  sound: 'skonczyl.caf',
} as const;

/** The chime as keys in the nested Live Activity form (`{title: {loc-key}, body: {loc-key}}`). */
export const LIVE_ACTIVITY_CHIME_KEYS = {
  title: 'push.chime.title',
  body: 'push.chime.body',
} as const;

/** Closed sets of top-level payload keys. The relay passes the `rarog` block through without reading it. */
export const TOP_LEVEL_KEYS = {
  alert: ['aps', 'rarog'],
  liveactivity: ['aps'],
} as const;

/** Closed sets of `aps` keys per push type. */
export const APS_KEYS = {
  alert: ['alert', 'badge', 'sound', 'thread-id', 'mutable-content'],
  liveactivity: ['timestamp', 'event', 'content-state', 'stale-date', 'dismissal-date', 'alert'],
} as const;
