/**
 * Kontrakt rejestru urządzeń relaya iroh `/v1/*` (Worker `rarog-relay-auth`, katalog `relay-auth/`): kształty żądań
 * i odpowiedzi `v: 1`, tekst do podpisu Ed25519 i walidacja kształtu żądań apki.
 *
 * JEDNA definicja po stronie TypeScript: Worker importuje ten moduł ścieżką względną, a apka ma lustro
 * `RelayAuthWire` w `RarogContract`. Zgodność obu stron pilnują przypadki
 * `shared/fixtures/relay-auth/manifest.json` (ciało → wynik walidacji, tekst do podpisu co do bajtu, podpis kluczem
 * testowym, odpowiedzi), które czytają `shared/test/relay-auth.test.ts` i `RelayAuthWireTests`. Opis tras, macierz
 * kodów i stan Workera: `relay-auth/README.md`.
 *
 * Moduł jest liściem: importuje tylko liść `pairing-link.ts`, więc Worker nie ciągnie `zod` ani `node:*`.
 *
 * Zasady kontraktu:
 * - każde ciało JSON ma `v: 1`; pola tylko dochodzą, nieznane pola obie strony pomijają, zmiana łamiąca to `/v2/`;
 * - czasy (`issuedAt`, `expiresAt`) to całkowite sekundy epoki UTC;
 * - trasy apki (`/v1/app/*`) podpisuje klucz iroh apki (Ed25519; `endpointId` to jego klucz publiczny) nad tekstem
 *   o stałym układzie ({@link relayAuthSigningText}), nie nad JSON-em: tekst nie zależy od kolejności kluczy, odstępów
 *   ani zapisu liczb w ciele;
 * - trasy administracyjne (`/v1/admin/*`) uwierzytelnia bearer, bez podpisu;
 * - wyjątek `POST /v1/access` (hak `access.http` relaya iroh): bez ciała, bearer i nagłówek
 *   {@link RELAY_AUTH_ENDPOINT_HEADER}, odpowiedź `200` z ciałem dokładnie `true` albo `403` z ciałem `false`.
 */
import { IROH_ENDPOINT_ID_RE } from './pairing-link.ts';

/** Wersja kontraktu w ciałach (`v`). */
export const RELAY_AUTH_PROTOCOL_VERSION = 1;

/** Pierwsza linia tekstu do podpisu: wiąże podpis z tym kontraktem i jego wersją. */
export const RELAY_AUTH_SIGNING_DOMAIN = 'rarog-relay-auth/v1';

/** Nagłówek wersji klienta na trasach JSON (`rarog-app/<wersja>`); ta sama nazwa co w przekaźniku push. */
export const RELAY_AUTH_CLIENT_HEADER = 'x-rarog-relay-client';

/** Nagłówek z EndpointId klienta relaya w żądaniu haka `POST /v1/access` (małymi literami, jak w `Headers.get`). */
export const RELAY_AUTH_ENDPOINT_HEADER = 'x-iroh-endpoint-id';

/** Ciała odpowiedzi `POST /v1/access`: zgoda (`200`) i odmowa (`403`). Inne odpowiedzi nie są decyzją. */
export const RELAY_AUTH_ACCESS_ALLOW = 'true';
export const RELAY_AUTH_ACCESS_DENY = 'false';

/** Dopuszczalna różnica `issuedAt` wobec zegara Workera, w obie strony (sekundy). */
export const RELAY_AUTH_CLOCK_SKEW_SECONDS = 300;

/** Najwięcej serwerów w `renew` (lista zapisanych serwerów apki). */
export const RELAY_AUTH_SERVERS_MAX = 32;

/** Sufit długości tokenu dowodu bramki (znaki). */
export const RELAY_AUTH_PROOF_TOKEN_MAX_CHARS = 8192;

/**
 * Który rejestr pilnuje którego relaya iroh: klucz = relay w postaci kanonicznej pola `r=` linku parowania
 * (`irohRelayUrl`), wartość = origin Workera rejestru (bez ukośnika). Relay spoza mapy (własny relay użytkownika) nie
 * ma rejestru: apka nie woła Workera dla serwera na takim relayu. Zgodność z `DEFAULT_IROH_RELAY` (`rarog setup`),
 * `WORKER_URL` adaptera haka (`relay-vps/access-adapter.conf`) i trasą Workera (`relay-auth/wrangler.toml`) pilnuje
 * `server/test/relay-auth-mapa.test.ts`; lustro Swift `RelayAuthWire.registries`, pole `registries` w manifeście.
 */
export const RELAY_AUTH_REGISTRIES: Readonly<Record<string, string>> = {
  'https://relay.rarog.ai/': 'https://relay-auth.rarog.ai',
};

/** Trasy apki: podpisane kluczem iroh apki. */
export const RELAY_AUTH_APP_ROUTES = ['register', 'renew', 'sponsor', 'forget'] as const;
export type RelayAuthAppRoute = typeof RELAY_AUTH_APP_ROUTES[number];

/** Trasy administracyjne: bearer administratora. */
export const RELAY_AUTH_ADMIN_ROUTES = ['deny', 'allow'] as const;
export type RelayAuthAdminRoute = typeof RELAY_AUTH_ADMIN_ROUTES[number];

export type RelayAuthRoute = RelayAuthAppRoute | RelayAuthAdminRoute | 'health' | 'access';

/** Ścieżka każdej trasy kontraktu. */
export const RELAY_AUTH_PATHS: Readonly<Record<RelayAuthRoute, string>> = {
  register: '/v1/app/register',
  renew: '/v1/app/renew',
  sponsor: '/v1/app/sponsor',
  forget: '/v1/app/forget',
  deny: '/v1/admin/deny',
  allow: '/v1/admin/allow',
  health: '/v1/health',
  access: '/v1/access',
};

/** Metoda każdej trasy: `GET` tylko dla `/v1/health`. */
export const RELAY_AUTH_METHODS: Readonly<Record<RelayAuthRoute, 'GET' | 'POST'>> = {
  register: 'POST',
  renew: 'POST',
  sponsor: 'POST',
  forget: 'POST',
  deny: 'POST',
  allow: 'POST',
  health: 'GET',
  access: 'POST',
};

/** Rodzaj bramki wejścia do rejestru: DeviceCheck albo próbny push APNs. Worker przyjmuje jeden naraz. */
export const RELAY_AUTH_GATES = ['devicecheck', 'apns'] as const;
export type RelayAuthGate = typeof RELAY_AUTH_GATES[number];

/** Środowisko usługi Apple, w której apka dostała token dowodu (profil podpisu apki). */
export const RELAY_AUTH_ENVIRONMENTS = ['development', 'production'] as const;
export type RelayAuthEnvironment = typeof RELAY_AUTH_ENVIRONMENTS[number];

/** Podpis Ed25519: 64 bajty jako 128 znaków hex małymi literami. */
export const RELAY_AUTH_SIG_RE = /^[0-9a-f]{128}$/;
/**
 * Token DeviceCheck: base64 standardowe z dopełnieniem (`Data.base64EncodedString()`), niepuste: grupy po cztery
 * znaki, `=` tylko w ostatniej grupie.
 */
export const RELAY_AUTH_DEVICECHECK_TOKEN_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Token urządzenia APNs jako hex; ten sam wzorzec co `APNS_TOKEN_RE` w `rest.ts` (test). */
export const RELAY_AUTH_APNS_TOKEN_RE = /^[0-9a-fA-F]{32,512}$/;

/** `issuedAt`: całkowite sekundy epoki, dodatnie, najwyżej dziesięć cyfr. */
const ISSUED_AT_MAX = 9_999_999_999;

/** Dowód bramki: token z usługi Apple i środowisko, w którym go wydano. */
export interface RelayAuthProof {
  readonly kind: RelayAuthGate;
  readonly environment: RelayAuthEnvironment;
  readonly token: string;
}

/** Pola wspólne tras apki. `sig` = podpis tekstu {@link relayAuthSigningText} (hex). */
interface RelayAuthSigned {
  readonly v: 1;
  readonly endpointId: string;
  readonly issuedAt: number;
  readonly sig: string;
}

/** `POST /v1/app/register`: wpis apki za dowodem bramki. */
export interface RelayAuthRegisterRequest extends RelayAuthSigned {
  readonly proof: RelayAuthProof;
}

/** `POST /v1/app/renew`: przedłużenie wpisu apki i poręczeń serwerów z listy. */
export interface RelayAuthRenewRequest extends RelayAuthSigned {
  readonly servers: readonly string[];
}

/** `POST /v1/app/sponsor`: poręczenie serwera (EndpointId serwera iroh) przez apkę. */
export interface RelayAuthSponsorRequest extends RelayAuthSigned {
  readonly server: string;
}

/** `POST /v1/app/forget`: usunięcie wpisu apki i jej poręczeń. */
export type RelayAuthForgetRequest = RelayAuthSigned;

export interface RelayAuthAppRequests {
  readonly register: RelayAuthRegisterRequest;
  readonly renew: RelayAuthRenewRequest;
  readonly sponsor: RelayAuthSponsorRequest;
  readonly forget: RelayAuthForgetRequest;
}

/** Żądanie apki przed podpisem: wszystko poza `sig` (z tego powstaje tekst do podpisu). */
export type RelayAuthUnsigned<R extends RelayAuthAppRoute> = Omit<RelayAuthAppRequests[R], 'sig'>;

/** `POST /v1/admin/deny` i `POST /v1/admin/allow`: odmowa albo jej zdjęcie dla EndpointId. */
export interface RelayAuthAdminRequest {
  readonly v: 1;
  readonly endpointId: string;
}

/** 200 `register`: wpis apki z terminem. */
export interface RelayAuthRegisterResponse {
  readonly v: 1;
  readonly endpointId: string;
  readonly expiresAt: number;
}

/** 200 `renew`: nowy termin wpisu i serwery z listy bez żywego poręczenia tej apki (apka woła dla nich `sponsor`). */
export interface RelayAuthRenewResponse {
  readonly v: 1;
  readonly expiresAt: number;
  readonly unsponsored: readonly string[];
}

/** 200 `sponsor`: poręczenie serwera z terminem. */
export interface RelayAuthSponsorResponse {
  readonly v: 1;
  readonly server: string;
  readonly expiresAt: number;
}

/** 200 `forget`: wpisu nie ma (także gdy go nie było). */
export interface RelayAuthForgetResponse {
  readonly v: 1;
  readonly forgotten: true;
}

/** 200 `deny` i `allow`: stan odmowy po zmianie. */
export interface RelayAuthAdminResponse {
  readonly v: 1;
  readonly endpointId: string;
  readonly denied: boolean;
}

/**
 * `GET /v1/health`: `ok` = Worker przyjmuje rejestracje, `gate` = bramka z konfiguracji (`null`: nie wybrana albo
 * zła wartość), `enforce` = egzekwowanie odmów w `/v1/access` (`false` = tryb cienia).
 */
export interface RelayAuthHealthResponse {
  readonly v: 1;
  readonly ok: boolean;
  readonly version: string;
  readonly gate: RelayAuthGate | null;
  readonly enforce: boolean;
}

/** Kod błędu → status HTTP. Każdy błąd to `{v: 1, error, …pola}`; `gate-mismatch` niesie `gate` (bramkę Workera). */
export const RELAY_AUTH_ERROR_STATUS = {
  'bad-request': 400,
  'gate-mismatch': 400,
  'bad-signature': 401,
  'clock-skew': 401,
  unauthorized: 401,
  denied: 403,
  'not-found': 404,
  'not-registered': 404,
  'method-not-allowed': 405,
  'kind-conflict': 409,
  'proof-rejected': 422,
  'quota-exceeded': 429,
  limited: 429,
  internal: 500,
  'not-implemented': 501,
  'gate-unreachable': 502,
  unavailable: 503,
} as const;
export type RelayAuthErrorCode = keyof typeof RELAY_AUTH_ERROR_STATUS;
export const RELAY_AUTH_ERRORS = Object.keys(RELAY_AUTH_ERROR_STATUS) as RelayAuthErrorCode[];

export interface RelayAuthErrorResponse {
  readonly v: 1;
  readonly error: RelayAuthErrorCode;
  readonly gate?: RelayAuthGate;
}

/** Pole, na którym walidacja kształtu stanęła (`body` = ciało nie jest obiektem JSON). */
export type RelayAuthField =
  | 'body' | 'v' | 'endpointId' | 'issuedAt' | 'proof' | 'proof.kind' | 'proof.environment' | 'proof.token'
  | 'servers' | 'server' | 'sig';

export type RelayAuthParsed<R extends RelayAuthAppRoute> =
  | { readonly ok: true; readonly request: RelayAuthAppRequests[R] }
  | { readonly ok: false; readonly error: 'bad-request'; readonly field: RelayAuthField };

/** EndpointId iroh w jedynej postaci kontraktu: 64 znaki hex małymi literami (`IROH_ENDPOINT_ID_RE`). */
export const isRelayAuthEndpointId = (value: unknown): value is string =>
  typeof value === 'string' && IROH_ENDPOINT_ID_RE.test(value);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** Token dowodu w kształcie swojego rodzaju bramki, do {@link RELAY_AUTH_PROOF_TOKEN_MAX_CHARS} znaków. */
function isProofToken(kind: RelayAuthGate, value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > RELAY_AUTH_PROOF_TOKEN_MAX_CHARS) return false;
  return kind === 'devicecheck' ? RELAY_AUTH_DEVICECHECK_TOKEN_RE.test(value) : RELAY_AUTH_APNS_TOKEN_RE.test(value);
}

type FieldsResult =
  | { readonly ok: true; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly field: RelayAuthField };

/** Pola trasy po polach wspólnych, w kolejności kontraktu; wynik ma tylko pola znane. */
function routeFields(route: RelayAuthAppRoute, body: Readonly<Record<string, unknown>>, endpointId: string):
  FieldsResult {
  const fail = (field: RelayAuthField): FieldsResult => ({ ok: false, field });
  switch (route) {
    case 'register': {
      const proof = body['proof'];
      if (!isObject(proof)) return fail('proof');
      const { kind, environment, token } = proof;
      if (!isOneOf(RELAY_AUTH_GATES, kind)) return fail('proof.kind');
      if (!isOneOf(RELAY_AUTH_ENVIRONMENTS, environment)) return fail('proof.environment');
      if (!isProofToken(kind, token)) return fail('proof.token');
      return { ok: true, fields: { proof: { kind, environment, token } } };
    }
    case 'renew': {
      const servers = body['servers'];
      if (!Array.isArray(servers) || servers.length > RELAY_AUTH_SERVERS_MAX) return fail('servers');
      if (!servers.every(isRelayAuthEndpointId) || new Set(servers).size !== servers.length) return fail('servers');
      return { ok: true, fields: { servers: [...servers] } };
    }
    case 'sponsor': {
      const server = body['server'];
      if (!isRelayAuthEndpointId(server) || server === endpointId) return fail('server');
      return { ok: true, fields: { server } };
    }
    case 'forget':
      return { ok: true, fields: {} };
  }
}

/**
 * Ciało żądania apki (JSON po parsowaniu) → żądanie albo pole, na którym kształt się nie zgadza. Kolejność sprawdzeń
 * (pierwsza porażka wygrywa) to kolejność pól w kontrakcie: obiekt, `v`, `endpointId`, `issuedAt`, pola trasy, `sig`.
 * Pola trasy:
 * - `register`: `proof` (obiekt), `proof.kind` ({@link RELAY_AUTH_GATES}), `proof.environment`
 *   ({@link RELAY_AUTH_ENVIRONMENTS}), `proof.token` (kształt rodzaju: base64 DeviceCheck albo hex APNs);
 * - `renew`: `servers` — lista EndpointId bez powtórzeń, najwyżej {@link RELAY_AUTH_SERVERS_MAX}, może być pusta;
 * - `sponsor`: `server` — EndpointId inny niż `endpointId`;
 * - `forget`: bez pól.
 *
 * Nieznane pola odpadają z wyniku i nie wchodzą do podpisu. To kształt, nie dowód: podpis, termin `issuedAt`
 * i zgodność `proof.kind` z bramką Workera sprawdza Worker.
 */
export function parseRelayAuthRequest<R extends RelayAuthAppRoute>(route: R, body: unknown): RelayAuthParsed<R> {
  const fail = (field: RelayAuthField): RelayAuthParsed<R> => ({ ok: false, error: 'bad-request', field });
  if (!isObject(body)) return fail('body');
  if (body['v'] !== RELAY_AUTH_PROTOCOL_VERSION) return fail('v');
  const { endpointId, issuedAt } = body;
  if (!isRelayAuthEndpointId(endpointId)) return fail('endpointId');
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > ISSUED_AT_MAX) {
    return fail('issuedAt');
  }
  const fields = routeFields(route, body, endpointId);
  if (!fields.ok) return fail(fields.field);
  const sig = body['sig'];
  if (typeof sig !== 'string' || !RELAY_AUTH_SIG_RE.test(sig)) return fail('sig');
  const request = { v: RELAY_AUTH_PROTOCOL_VERSION, endpointId, issuedAt, ...fields.fields, sig };
  return { ok: true, request: request as unknown as RelayAuthAppRequests[R] };
}

/** Linie pól trasy w tekście do podpisu, w kolejności kontraktu. */
function signingLines(route: RelayAuthAppRoute, request: RelayAuthUnsigned<RelayAuthAppRoute>): string[] {
  switch (route) {
    case 'register': {
      const { proof } = request as RelayAuthUnsigned<'register'>;
      return [proof.kind, proof.environment, proof.token];
    }
    case 'renew':
      return [(request as RelayAuthUnsigned<'renew'>).servers.join(',')];
    case 'sponsor':
      return [(request as RelayAuthUnsigned<'sponsor'>).server];
    case 'forget':
      return [];
  }
}

/**
 * Tekst, który apka podpisuje kluczem iroh (Ed25519), a Worker sprawdza kluczem publicznym `endpointId`. Linie
 * rozdziela `\n`, bez `\n` na końcu:
 *
 * ```
 * rarog-relay-auth/v1
 * <ścieżka trasy, np. /v1/app/register>
 * <endpointId>
 * <issuedAt dziesiętnie>
 * <pola trasy, po jednym w linii>
 * ```
 *
 * Pola trasy: `register` — `proof.kind`, `proof.environment`, `proof.token` (trzy linie); `renew` — `servers`
 * rozdzielone przecinkiem (jedna linia, pusta przy pustej liście); `sponsor` — `server`; `forget` — żadnych.
 * Wartości dosłownie, jak w ciele (walidacja wyklucza w nich `\n` i przecinek). Pole spoza tej listy nie wchodzi do
 * podpisu; nowe pole podpisane to nowa wersja kontraktu.
 */
export function relayAuthSigningText<R extends RelayAuthAppRoute>(route: R, request: RelayAuthUnsigned<R>): string {
  return [
    RELAY_AUTH_SIGNING_DOMAIN, RELAY_AUTH_PATHS[route], request.endpointId, String(request.issuedAt),
    ...signingLines(route, request),
  ].join('\n');
}

/** Bajty UTF-8 tekstu {@link relayAuthSigningText} (tekst jest ASCII). */
export const relayAuthSigningBytes = <R extends RelayAuthAppRoute>(route: R, request: RelayAuthUnsigned<R>):
  Uint8Array => new TextEncoder().encode(relayAuthSigningText(route, request));
