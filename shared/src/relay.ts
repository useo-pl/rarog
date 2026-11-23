/**
 * Kontrakt przekaźnika push `/v1/*` od strony SERWERA Raroga: schematy zod żądań, które serwer wysyła,
 * i odpowiedzi, które czyta.
 *
 * Przekaźnik (`relay/`) to osobny projekt bez importu z `shared/`: waliduje sam, a zgodność obu końców pilnują
 * fixture'y JSON w `shared/fixtures/relay/` (`manifest.json` + plik na przypadek). Ten moduł czyta je
 * `shared/test/relay-fixtures.test.ts` (każde ciało przechodzi swój schemat), a żądania produkuje kod serwera
 * (`server/src/notify/relay-sender.ts`, test `server/test/relay-fixtures-producenci.test.ts`). Opis tras, macierz
 * odpowiedzi i jednostki: `relay/README.md`.
 *
 * Zasady kontraktu, które dotyczą klienta:
 * - każde ciało ma `v: 1`; nieznane pola odpowiedzi klient pomija (`z.object`), a łamiąca zmiana to `/v2/`;
 * - `expiresAt` to ISO 8601 UTC, `timestamp` z APNs — ms epoki bez zmian;
 * - `payload` w `/v1/push` to ŁAŃCUCH JSON, który idzie do Apple bajt w bajt.
 */
import { z } from 'zod';
import { APNS_ENVIRONMENTS, APNS_TOKEN_RE, BUNDLE_ID_RE } from './rest.ts';

/** Wersja kontraktu w ciałach (`v`). */
export const RELAY_PROTOCOL_VERSION = 1;

/**
 * Temat APNs apki, pod którym przekaźnik wydaje przepustki i wysyła (bundle id Raroga). JEDNO źródło po
 * stronie serwera: temat, który serwer BEZ klucza APNs przyjmuje w rejestracji, i warunek zamówienia przepustki.
 * Zgodność z `IOS_BUNDLE_ID` (`scripts/ios-identity.sh`) i z allow-listą przekaźnika (`APP_TOPIC` w
 * `relay/src/identity.ts`) pilnuje `server/test/product-identity-guard.test.ts`.
 */
export const RELAY_APP_TOPIC = 'ai.rarog.app';

/**
 * Tekst zastępczy banera: `aps.alert` ładunku v2 — to widać, gdy NSE nie
 * odszyfruje treści albo apka jej nie zna. JEDNO źródło po stronie serwera; ta sama wartość stoi w polityce
 * przekaźnika (`alert.placeholder` w `shared/fixtures/relay/alert-policy.json`, `ALERT_PLACEHOLDER` w
 * `relay/src/alert-policy.ts`) — zgodność pilnuje `shared/test/relay-fixtures.test.ts`. Inny tekst odrzuca
 * polityka `v2` przekaźnika (`payload-rejected`, reguła `alert`).
 */
export const RELAY_ALERT_PLACEHOLDER = { title: 'Rarog', body: 'Nowe powiadomienie' } as const;

/**
 * Nagłówek z wersją klienta (`rarog-server/<wersja>`): przekaźnik go WYMAGA na trasach POST, razem
 * z `Content-Type: application/json` (bez nich 400 `bad-request`), i loguje wersję.
 */
export const RELAY_CLIENT_HEADER = 'x-rarog-relay-client';

/** Typ pusha przepustki — ten sam co `apns-push-type` wysyłek, które otwiera. */
export const RELAY_PUSH_TYPES = ['alert', 'liveactivity'] as const;
export type RelayPushType = typeof RELAY_PUSH_TYPES[number];

/** Kody błędów per trasa (kopia listy przekaźnika; fixture'y pokrywają każdy). */
export const RELAY_PASS_ERRORS = [
  'bad-request', 'topic-not-allowed', 'pass-invalid', 'token-rejected', 'relay-limited', 'apns-error',
  'apns-unreachable', 'environment-unavailable',
] as const;
export const RELAY_PUSH_ERRORS = [
  'bad-request', 'payload-rejected', 'pass-invalid', 'relay-limited', 'apns-unreachable', 'environment-unavailable',
] as const;
export const RELAY_ROUTING_ERRORS = ['not-found', 'method-not-allowed', 'internal'] as const;

const version = z.literal(RELAY_PROTOCOL_VERSION);
const tokenSchema = z.string().regex(APNS_TOKEN_RE);
/** Przepustka jest dla serwera nieprzezroczysta: drukowalne ASCII bez spacji, z sufitem. */
export const RELAY_PASS_RE = /^[\x21-\x7e]{1,512}$/;
const passSchema = z.string().regex(RELAY_PASS_RE);
const isoSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'expiresAt: data ISO');

/** `POST /v1/pass` — przepustka dla tokenu urządzenia (`alert`) albo aktywności (`liveactivity` + `devicePass`). */
export const relayPassRequestSchema = z.object({
  v: version,
  token: tokenSchema,
  environment: z.enum(APNS_ENVIRONMENTS),
  type: z.enum(RELAY_PUSH_TYPES),
  topic: z.string().regex(BUNDLE_ID_RE),
  devicePass: passSchema.optional(),
}).refine((body) => (body.type === 'liveactivity') === (body.devicePass !== undefined),
  'devicePass wyłącznie (i zawsze) przy liveactivity');
export type RelayPassRequest = z.infer<typeof relayPassRequestSchema>;

/** `POST /v1/push` — gotowe żądanie APNs z przepustką; `payload` to łańcuch JSON. */
export const relayPushRequestSchema = z.object({
  v: version,
  pass: passSchema,
  token: tokenSchema,
  environment: z.enum(APNS_ENVIRONMENTS),
  headers: z.record(z.string(), z.string()),
  payload: z.string(),
});
export type RelayPushRequest = z.infer<typeof relayPushRequestSchema>;

/** Przepustka z terminem (odpowiedź `/v1/pass` i `renewedPass` w `/v1/push`). */
export const relayIssuedPassSchema = z.object({ pass: passSchema, expiresAt: isoSchema });
export type RelayIssuedPass = z.infer<typeof relayIssuedPassSchema>;

/** 200 `/v1/pass`. */
export const relayPassResponseSchema = z.object({ v: version, pass: passSchema, expiresAt: isoSchema });

/** 200 `/v1/push` — odpowiedź Apple lustrem (także 4xx i 5xx Apple), z odnowioną przepustką, gdy była potrzebna. */
export const relayPushResponseSchema = z.object({
  v: version,
  apnsStatus: z.number().int().min(100).max(599),
  reason: z.string().optional(),
  timestamp: z.number().int().optional(),
  renewedPass: relayIssuedPassSchema.optional(),
});
export type RelayPushResponse = z.infer<typeof relayPushResponseSchema>;

/** Każdy błąd przekaźnika: `{v, error, …pola}`; pola zależne od kodu (`token-rejected`, `apns-error`, `payload-rejected`). */
export const relayErrorSchema = z.object({
  v: version,
  error: z.enum([...new Set([...RELAY_PASS_ERRORS, ...RELAY_PUSH_ERRORS, ...RELAY_ROUTING_ERRORS])] as
    [string, ...string[]]),
  apnsStatus: z.number().int().optional(),
  reason: z.string().optional(),
  timestamp: z.number().int().optional(),
  rule: z.string().optional(),
});
export type RelayError = z.infer<typeof relayErrorSchema>;

/** `GET /v1/health` (diagnostyka; serwer Raroga go nie woła). */
export const relayHealthResponseSchema = z.object({
  v: version,
  ok: z.boolean(),
  version: z.string(),
  environments: z.array(z.enum(APNS_ENVIRONMENTS)),
  alertPolicy: z.string(),
});
