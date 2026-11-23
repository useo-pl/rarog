/**
 * The only entry into the push relay code (`relay/src/`): modules shared by both Workers, imported by relative path,
 * because `relay/` is a separate pnpm project outside the workspace. No other `relay-auth/` file imports from
 * `relay/` (guard in `test/wspolne.test.ts`). `jwt.ts` pulls `@noble/curves` from `relay/node_modules`, so the
 * typecheck, tests and build of this Worker need both projects installed.
 *
 * - `apns.ts`: Apple call with a time cap and recognition of a rejected token (test push of the `apns` gate);
 * - `jwt.ts`: Apple provider JWT ES256 (`kid` = Key ID, `iss` = Team ID) from a PKCS#8 PEM key, deterministic
 *   signature (the same provider token for DeviceCheck and APNs);
 * - `client-key.ts`: rate-limit key from the client address (IPv6 cut to /64);
 * - `bytes.ts`: UTF-8, base64, hex, SHA-256;
 * - `identity.ts`: the app's APNs topic (test push);
 * - `log.ts`: field shape checks and the line formatter with an allow-list (registry list: `log.ts` in this directory).
 */
export { APNS_ORIGINS, APNS_TIMEOUT_MS, callApns, isTokenRejection } from '../../relay/src/apns.ts';
export type { ApnsCall, ApnsFetch, ApnsOutcome } from '../../relay/src/apns.ts';
export { ProviderTokens, apnsKeyScalar, jwtIat, signProviderToken } from '../../relay/src/jwt.ts';
export { UNKNOWN_BUCKET, clientBucket } from '../../relay/src/client-key.ts';
export { base64Decode, base64url, hex, sha256Hex, utf8 } from '../../relay/src/bytes.ts';
export { APP_TOPIC } from '../../relay/src/identity.ts';
export {
  createLogFormatter, logBool, logClient, logCode, logInt, logOneOf, logReason,
} from '../../relay/src/log.ts';
export type { LogCheck, LogFields, LogFormatter } from '../../relay/src/log.ts';
