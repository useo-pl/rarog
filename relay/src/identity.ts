/**
 * The APNs topic the relay sends under. ONE source in the relay code: the topic allow-list of
 * `/v1/pass` and the `apns-topic` header in `/v1/push` take the value from here. Agreement with `IOS_BUNDLE_ID`
 * (`scripts/ios-identity.sh`) is enforced by `server/test/product-identity-guard.test.ts` (reads this line by regex).
 *
 * Entries under any other app topic get no pass and are sent with the owner's key,
 * so the allow-list has one topic.
 */
export const APP_TOPIC = 'ai.rarog.app';

/** Suffix of the Live Activity update topic (Apple): `<bundle id>.push-type.liveactivity`. */
export const LIVE_ACTIVITY_TOPIC_SUFFIX = '.push-type.liveactivity';

export const PUSH_TYPES = ['alert', 'liveactivity'] as const;
export type PushType = typeof PUSH_TYPES[number];

export const APNS_ENVIRONMENTS = ['development', 'production'] as const;
export type ApnsEnvironment = typeof APNS_ENVIRONMENTS[number];

/** Topic from `/v1/pass` (the app's bundle id): whether the relay issues passes under it at all. */
export function isAllowedTopic(topic: string): boolean {
  return topic === APP_TOPIC;
}

/** The `apns-topic` that `/v1/push` requires for the pass type. */
export function apnsTopicFor(type: PushType): string {
  return type === 'liveactivity' ? `${APP_TOPIC}${LIVE_ACTIVITY_TOPIC_SUFFIX}` : APP_TOPIC;
}

export const isPushType = (value: unknown): value is PushType =>
  typeof value === 'string' && (PUSH_TYPES as readonly string[]).includes(value);

export const isApnsEnvironment = (value: unknown): value is ApnsEnvironment =>
  typeof value === 'string' && (APNS_ENVIRONMENTS as readonly string[]).includes(value);
