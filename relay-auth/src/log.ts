/**
 * The only module that builds registry log lines. The log gets ONLY allow-listed fields, each with a checked
 * shape (formatter shared with the push relay, `relay/src/log.ts`): event, route, response status and code,
 * rejected field, time, client version, gate, Apple response, hook decision, enforcement mode, configuration
 * problem.
 *
 * The core adds the full EndpointId (`endpoint`) ONLY to the `/v1/access` decision line in shadow mode or within
 * the `DIAG_UNTIL` window (Workers Logs retention 7 days). Never a signature, proof token or its digest, bearer,
 * IP address, the app's server list or an exception message: a field outside the list or a value with a wrong shape
 * is dropped before writing. Only the adapter writes to the console (`worker.ts`, `objects.ts`).
 */
import { RELAY_AUTH_GATES, RELAY_AUTH_PATHS } from '../../shared/src/relay-auth.ts';
import type { RelayAuthField } from '../../shared/src/relay-auth.ts';
import { createLogFormatter, logBool, logClient, logCode, logInt, logOneOf, logReason } from './wspolne.ts';

export const LOG_ROUTES = [...Object.keys(RELAY_AUTH_PATHS), 'unknown'] as const;

const FIELDS: readonly RelayAuthField[] = [
  'body', 'v', 'endpointId', 'issuedAt', 'proof', 'proof.kind', 'proof.environment', 'proof.token', 'servers',
  'server', 'sig',
];

const ENDPOINT_RE = /^[0-9a-f]{64}$/;

const LOG = createLogFormatter({
  event: logCode,
  route: logOneOf(LOG_ROUTES),
  status: logInt,
  code: logCode,
  field: logOneOf(FIELDS),
  ms: logInt,
  client: logClient,
  gate: logOneOf(RELAY_AUTH_GATES),
  fresh: logBool,
  apple_status: logInt,
  reason: logReason,
  cause: logCode,
  problem: logCode,
  decision: logOneOf(['allow', 'deny', 'error']),
  enforce: logBool,
  endpoint: (value) => typeof value === 'string' && ENDPOINT_RE.test(value),
});

/** Keeps only fields from the registry allow-list with a valid shape. */
export const filterLogFields = LOG.filter;

/** One JSON line for Workers Logs. */
export const formatLogLine = LOG.format;
