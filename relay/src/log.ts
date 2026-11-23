/**
 * The only module that builds relay log lines, and the field allow-list shared with the iroh relay
 * registry (`relay-auth/src/log.ts` builds its own list from the same checks, {@link createLogFormatter}).
 *
 * The log gets ONLY allow-listed fields, each with a checked shape: route, environment, push type,
 * response status and code, APNs status and reason word, rejection rule, time, the pass `kid`, the client version
 * from `X-Rarog-Relay-Client` (`clientHeaderOf` in `core.ts`). Never a token, token digest, pass, payload or
 * `authorization` header: a field outside the list or a value with a wrong shape is dropped before writing. The list
 * is the second line of defense; the first is that the core never passes such values here (spy test on all paths,
 * `log.test.ts`). The test also checks that only `worker.ts` writes to the console (only writing a finished line).
 */
import { KID_RE } from './pass.ts';

const CODE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REASON_RE = /^[A-Za-z]{1,64}$/;
/** `X-Rarog-Relay-Client: rarog-server/<version>`: the `name/version` shape. */
const CLIENT_RE = /^[a-z][a-z0-9-]{0,31}\/[0-9A-Za-z.+-]{1,32}$/;

export const ROUTES = ['pass', 'push', 'health', 'unknown'] as const;
export type Route = typeof ROUTES[number];

/** Shape check of one allow-list field's value. */
export type LogCheck = (value: unknown) => boolean;

/** Code: lowercase letters, digits and hyphen, starting with a letter, up to 64 characters. */
export const logCode: LogCheck = (value) => typeof value === 'string' && CODE_RE.test(value);
/** Safe integer. */
export const logInt: LogCheck = (value) => typeof value === 'number' && Number.isSafeInteger(value);
export const logBool: LogCheck = (value) => typeof value === 'boolean';
/** Apple's reason word: letters only, up to 64 characters. */
export const logReason: LogCheck = (value) => typeof value === 'string' && REASON_RE.test(value);
/** Client version in the `name/version` shape. */
export const logClient: LogCheck = (value) => typeof value === 'string' && CLIENT_RE.test(value);
/** One of the values of a closed list. */
export const logOneOf = (list: readonly string[]): LogCheck =>
  (value) => typeof value === 'string' && list.includes(value);

export type LogFields = Readonly<Record<string, unknown>>;
export type LogLine = Record<string, string | number | boolean>;

export interface LogFormatter {
  /** Keeps only allow-listed fields with a valid shape. */
  readonly filter: (fields: LogFields) => LogLine;
  /** One JSON line for Workers Logs. */
  readonly format: (fields: LogFields) => string;
}

/** Log line formatter with an allow-list: field name → value shape check. */
export function createLogFormatter(whitelist: Readonly<Record<string, LogCheck>>): LogFormatter {
  const filter = (fields: LogFields): LogLine => {
    const out: LogLine = {};
    for (const [key, value] of Object.entries(fields)) {
      const check = Object.hasOwn(whitelist, key) ? whitelist[key] : undefined;
      if (check !== undefined && check(value)) out[key] = value as string | number | boolean;
    }
    return out;
  };
  return { filter, format: (fields) => JSON.stringify(filter(fields)) };
}

/** Push relay allow-list: field name → allowed value shape. */
const RELAY_LOG = createLogFormatter({
  event: logCode,
  route: logOneOf(ROUTES),
  status: logInt,
  code: logCode,
  env: logOneOf(['development', 'production']),
  type: logOneOf(['alert', 'liveactivity']),
  apns_status: logInt,
  reason: logReason,
  rule: logCode,
  cause: logCode,
  problem: logCode,
  ms: logInt,
  kid: (value) => typeof value === 'string' && KID_RE.test(value),
  renewed: logBool,
  client: logClient,
});

/** Keeps only fields from the relay allow-list with a valid shape. */
export const filterLogFields = RELAY_LOG.filter;

/** One JSON line for Workers Logs. */
export const formatLogLine = RELAY_LOG.format;
