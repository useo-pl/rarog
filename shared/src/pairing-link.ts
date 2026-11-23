/**
 * Pairing link: the ONE definition of the build and parse rules. The parser accepts two prefixes with
 * the same fragment body: the custom scheme `rarog://pair#v=1&…` and the universal link `https://rarog.ai/pair#v=1&…`
 * ({@link PAIRING_LINK_HOST}). The builder writes the universal link.
 *
 * The server builds the link (`pairingLink` in `server/src/auth/admin.ts`; `rarog pair` calls the same function),
 * and the app reads it: `PairingLinkWire` in `RarogContract` is the Swift mirror of this module. The cases in
 * `shared/fixtures/pairing-links/manifest.json` (text → parse result and the rebuilt link, or an error code) keep
 * both sides in step; `shared/test/pairing-link.test.ts` and `PairingLinkWireTests` read them. Description:
 * `docs/implementation-spec.md`, "Device keys and pairing".
 *
 * The module is a leaf (no imports): pairing constants and address rules live here, and `rest.ts` re-exports them
 * and uses them in the response schemas (`iroh` in `PairResponse.server` and `GET /api/version`).
 *
 * Fragment fields: `v` (version), `u` (server HTTPS address), `k` (iroh server EndpointId), `r` (iroh server relay),
 * `c` (code). Transport: `u`, `k` with `r`, or both. The parser skips other fields (`t` too), so adding a field does
 * not change `v`. Each known field at most once.
 */

/** Wersja protokołu parowania — `v` w ciele `POST /api/pair` i w linku parowania (`…/pair#v=1&…`). */
export const PAIR_PROTOCOL_VERSION = 1;

/**
 * The app's custom scheme: the parser reads the pairing link `<scheme>://pair#v=…` like the universal link, so a link
 * from a server that writes this form still pairs. Ten sam co `CFBundleURLSchemes` apki, `PushRouting.scheme`,
 * `PairingLinkWire.scheme` i `LiveActivityPresentation.scheme` w Swift — zgodności pilnuje
 * `server/test/product-identity-guard.test.ts`.
 */
export const PAIRING_LINK_SCHEME = 'rarog';

/**
 * Host of the universal pairing link `https://<host>/pair#v=…`: the product site domain. The builder writes this
 * link (`pairingLink` in `server/src/auth/admin.ts`, which `rarog pair` calls too). The Swift mirror is
 * `PairingLinkWire.host`; `server/test/product-identity-guard.test.ts` keeps both, and the host of `pairingLink`, equal
 * to the domain of `ProductLinks` in the app.
 */
export const PAIRING_LINK_HOST = 'rarog.ai';

/**
 * Link prefixes the parser accepts before `#`, in lower case. Exact match only: no port, user, trailing slash, query,
 * `www` or plain `http`, so a near miss is `not-a-link` rather than a guess.
 */
const PAIRING_LINK_PREFIXES: readonly string[] = [`${PAIRING_LINK_SCHEME}://pair`, `https://${PAIRING_LINK_HOST}/pair`];

/** Kod parowania i sekret urządzenia: 32 losowe bajty w base64url bez dopełnienia (43 znaki). */
export const PAIRING_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * EndpointId serwera iroh (klucz publiczny Ed25519) w postaci, którą daje biblioteka: 64 znaki hex małymi
 * literami (`Display` typu `PublicKey` w `iroh-base`). Parser biblioteki przyjmuje też base32 (52 znaki);
 * link i odpowiedzi REST — wyłącznie tę jedną postać. To kształt, nie dowód: czy bajty są punktem krzywej,
 * sprawdza biblioteka przy połączeniu.
 */
export const IROH_ENDPOINT_ID_RE = /^[0-9a-f]{64}$/;

/** Dlaczego tekst nie jest linkiem parowania. Kolejność sprawdzeń: {@link parsePairingLink}. */
export const PAIRING_LINK_ERRORS = [
  'not-a-link', 'unsupported-version', 'duplicate-field', 'bad-address', 'bad-endpoint-id', 'bad-relay',
  'missing-relay', 'missing-endpoint-id', 'bad-code',
] as const;
export type PairingLinkError = typeof PAIRING_LINK_ERRORS[number];

/** Serwer iroh z linku (`k=`, `r=`) — ten sam kształt co `iroh` w odpowiedziach REST. */
export interface PairingLinkIroh {
  readonly endpointId: string;
  readonly relay: string;
}

/** Pola linku w postaci kanonicznej: co najmniej jedno z `server` i `iroh`. */
export interface PairingLinkFields {
  /** Adres bazowy serwera (`https://host[:port]` w brzmieniu z linku, bez ukośnika), {@link pairingServerUrl}. */
  readonly server: string | null;
  readonly iroh: PairingLinkIroh | null;
  readonly code: string;
}

export type PairingLinkResult =
  | { readonly ok: true; readonly fields: PairingLinkFields }
  | { readonly ok: false; readonly error: PairingLinkError };

/**
 * Białe znaki pomijane WSZĘDZIE, nie tylko z brzegów: link ich nie zawiera, a skopiowany z terminala bywa złamany
 * na końcu linii ekranu. Zbiór: `CharacterSet.whitespacesAndNewlines`, którym czytał link dawny parser apki
 * (kategoria Unicode Z*, U+0009–U+000D, U+0085, U+200B), i U+FEFF (BOM, który dawny parser na początku tekstu też
 * przepuszczał). Swift (`PairingLinkWire`) wypisuje ten sam zbiór jawnie, bez `CharacterSet`.
 */
const WHITESPACE_RE = /[\t-\r\u0085\u200b\ufeff\p{Z}]/gu;

/**
 * `schemat://host[:port][/]` po odkodowaniu wartości pola; host to literał IPv6 w nawiasach albo napis bez `@`, `:`,
 * nawiasów i znaków ścieżki.
 */
const ADDRESS_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(\[[^\]]*\]|[^/?#@:[\]]*)(?::([^/]*))?(\/?)$/;
/** IPv4 kropkowe bez zer wiodących. */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
/**
 * Nazwa DNS z liter ASCII, cyfr i myślników, z kropką na końcu albo bez (relaye n0 mają ją w adresie). Ostatnia
 * etykieta zaczyna się literą: host kończący się liczbą parser URL (WHATWG, crate `url` w iroh) czyta jako IPv4
 * i zapisuje inaczej, niż go podano.
 */
const DNS_HOST_RE = /^(?:[A-Za-z0-9-]+\.)*[A-Za-z][A-Za-z0-9-]*\.?$/;
/** Port 1–65535 bez zer wiodących (zakres sprawdza kod). */
const PORT_RE = /^[1-9][0-9]{0,4}$/;
/** Grupa adresu IPv6: 1–4 cyfry szesnastkowe. */
const IPV6_GROUP_RE = /^[0-9A-Fa-f]{1,4}$/;

/**
 * Literał IPv6 bez nawiasów według RFC 3986 (`IPv6address`): osiem grup, najwyżej jedno `::` w miejsce co najmniej
 * jednej grupy zer, IPv4 kropkowe najwyżej jako ostatnie dwie grupy. Bez strefy (`%25…`).
 */
function isIPv6(text: string): boolean {
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const end = halves.length === 2 ? tail : head;
  let count = head.length + tail.length;
  const last = end[end.length - 1];
  if (last?.includes('.') === true) {
    if (!IPV4_RE.test(last)) return false;
    end.pop();
    count += 1;
  }
  if (![...head, ...tail].every((group) => IPV6_GROUP_RE.test(group))) return false;
  return halves.length === 2 ? count <= 7 : count === 8;
}

/** Małe litery tylko w ASCII — reguły przyjmują wyłącznie ASCII, więc Unicode nie ma tu nic do mapowania. */
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Schemat, host i port adresu z linku w brzmieniu z linku albo `null`, gdy adres jest spoza reguł. */
function linkAddress(raw: string): { scheme: string; host: string; port: number | null } | null {
  const match = ADDRESS_RE.exec(raw);
  if (match === null) return null;
  const [, scheme = '', host = '', port] = match;
  const ipv6 = host.startsWith('[') && isIPv6(host.slice(1, -1));
  if (!ipv6 && !IPV4_RE.test(host) && !DNS_HOST_RE.test(host)) return null;
  if (port !== undefined && (!PORT_RE.test(port) || Number(port) > 65_535)) return null;
  return { scheme, host, port: port === undefined ? null : Number(port) };
}

/**
 * Adres serwera z pola `u=` w postaci kanonicznej albo `null`: `schemat://host[:port]` bez ukośnika, schemat i host
 * w brzmieniu z linku (bez zmiany wielkości liter: z tego adresu apka liczy nagłówek `Origin`, a serwer porównuje go
 * dosłownie z `RAROG_ORIGINS`), port jak go podano. Host: nazwa DNS, IPv4 albo literał IPv6 w nawiasach. Wyłącznie
 * `https`; `http` tylko na loopbacku `127.0.0.1` i `localhost` (serwer demo testów UI). Bez użytkownika, zapytania,
 * fragmentu i ścieżki innej niż `/`.
 */
export function pairingServerUrl(raw: string): string | null {
  const address = linkAddress(raw);
  if (address === null) return null;
  const [scheme, host] = [asciiLower(address.scheme), asciiLower(address.host)];
  const loopback = host === '127.0.0.1' || host === 'localhost';
  if (scheme !== 'https' && !(scheme === 'http' && loopback)) return null;
  return `${address.scheme}://${address.host}${address.port === null ? '' : `:${String(address.port)}`}`;
}

/**
 * Adres relaya iroh z pola `r=` w postaci kanonicznej albo `null`. Postać kanoniczna to zapis `RelayUrl` biblioteki
 * (crate `url`): `https://host[:port]/` — małe litery, ukośnik na końcu, port 443 pominięty, kropka na końcu hosta
 * zostaje (`https://euc1-1.relay.n0.iroh.link./`). Wyłącznie `https` i host DNS albo IPv4 (zapisu literału IPv6
 * crate `url` nie odtwarzamy); bez użytkownika, zapytania, fragmentu i ścieżki innej niż `/` (klient relaya i tak
 * podmienia ścieżkę na `/relay`).
 */
export function irohRelayUrl(raw: string): string | null {
  const address = linkAddress(raw);
  if (address === null || asciiLower(address.scheme) !== 'https' || address.host.startsWith('[')) return null;
  const port = address.port === null || address.port === 443 ? '' : `:${String(address.port)}`;
  return `https://${asciiLower(address.host)}${port}/`;
}

/** Wartość pola: `null` = pole bez wartości (bez `=` albo z procentem nie do odkodowania). */
type Item = { readonly name: string; readonly value: string | null };

/**
 * Fragment `a=1&b=2` → pola po odkodowaniu procentów (`decodeURIComponent`). Procent nie do odkodowania (jak
 * w dawnym parserze apki): w nazwie — pole pominięte jak nieznane; w wartości — pole obecne bez wartości, więc
 * błąd tego pola. Puste kawałki (`&&`, `&` na końcu) są pomijane.
 */
function fragmentItems(fragment: string): Item[] {
  const decode = (text: string): string | null => {
    try {
      return decodeURIComponent(text);
    } catch {
      return null;
    }
  };
  const items: Item[] = [];
  for (const piece of fragment.split('&')) {
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    const name = decode(eq < 0 ? piece : piece.slice(0, eq));
    if (name === null) continue;
    items.push({ name, value: eq < 0 ? null : decode(piece.slice(eq + 1)) });
  }
  return items;
}

/**
 * Text (pasted, from a QR code, a URL opened by the system) → link fields or an error code. Order of checks (the
 * first failure wins):
 * 1. `not-a-link`: after removing whitespace the text does not start with `rarog://pair#` or `https://rarog.ai/pair#`
 *    ({@link PAIRING_LINK_PREFIXES}, ASCII case-insensitive), `v` is missing, or `v` has no value (no `=`, or a percent
 *    sign that does not decode);
 * 2. `duplicate-field`: `v` more than once; `unsupported-version`: `v` other than {@link PAIR_PROTOCOL_VERSION};
 * 3. `duplicate-field`: `u`, `k`, `r` or `c` more than once;
 * 4. `bad-address` (`u` outside {@link pairingServerUrl}), `bad-endpoint-id` (`k` outside {@link IROH_ENDPOINT_ID_RE}),
 *    `bad-relay` (`r` outside {@link irohRelayUrl}): the field is present but wrong;
 * 5. `missing-relay` (`k` without `r`), `missing-endpoint-id` (`r` without `k`), `bad-address` (neither `u` nor `k`);
 * 6. `bad-code`: `c` missing or outside {@link PAIRING_CODE_RE}.
 */
export function parsePairingLink(text: string): PairingLinkResult {
  const fail = (error: PairingLinkError): PairingLinkResult => ({ ok: false, error });
  const compact = text.replace(WHITESPACE_RE, '');
  const hash = compact.indexOf('#');
  if (hash < 0) return fail('not-a-link');
  if (!PAIRING_LINK_PREFIXES.includes(asciiLower(compact.slice(0, hash)))) return fail('not-a-link');
  const items = fragmentItems(compact.slice(hash + 1));
  const all = (name: string): (string | null)[] => items.filter((item) => item.name === name).map((item) => item.value);

  const versions = all('v');
  if (versions.length === 0 || (versions.length === 1 && versions[0] === null)) return fail('not-a-link');
  if (versions.length > 1) return fail('duplicate-field');
  if (versions[0] !== String(PAIR_PROTOCOL_VERSION)) return fail('unsupported-version');
  if (['u', 'k', 'r', 'c'].some((name) => all(name).length > 1)) return fail('duplicate-field');
  /** Wartość pola: `undefined` = brak pola, `''` = pole bez wartości (obecne, więc sprawdzane jak puste). */
  const field = (name: string): string | undefined => {
    const [value] = all(name);
    return value === undefined ? undefined : value ?? '';
  };
  const [u, k, r, c] = [field('u'), field('k'), field('r'), field('c')];

  const server = u === undefined ? null : pairingServerUrl(u);
  if (u !== undefined && server === null) return fail('bad-address');
  if (k !== undefined && !IROH_ENDPOINT_ID_RE.test(k)) return fail('bad-endpoint-id');
  const relay = r === undefined ? null : irohRelayUrl(r);
  if (r !== undefined && relay === null) return fail('bad-relay');
  if (k !== undefined && relay === null) return fail('missing-relay');
  if (relay !== null && k === undefined) return fail('missing-endpoint-id');
  if (server === null && k === undefined) return fail('bad-address');
  if (c === undefined || !PAIRING_CODE_RE.test(c)) return fail('bad-code');
  const iroh = k !== undefined && relay !== null ? { endpointId: k, relay } : null;
  return { ok: true, fields: { server, iroh, code: c } };
}

/**
 * Fields → the universal link `https://rarog.ai/pair#v=1&u=…&k=…&r=…&c=…` (host {@link PAIRING_LINK_HOST}), which iOS
 * opens only in the app the domain names. Pola w postaci kanonicznej (wynik {@link parsePairingLink},
 * {@link pairingServerUrl}, {@link irohRelayUrl}); funkcja ich nie sprawdza. Adresy idą przez
 * `encodeURIComponent`, `k` i `c` bez zmian (hex i base64url). Kod na końcu: link ucięty przy kopiowaniu traci
 * kod, a nie adres. Bez `iroh` fragment jest bajt w bajt fragmentem sprzed pól `k`/`r`.
 */
export function buildPairingLink(fields: PairingLinkFields): string {
  const parts = [`v=${String(PAIR_PROTOCOL_VERSION)}`];
  if (fields.server !== null) parts.push(`u=${encodeURIComponent(fields.server)}`);
  if (fields.iroh !== null) parts.push(`k=${fields.iroh.endpointId}`, `r=${encodeURIComponent(fields.iroh.relay)}`);
  parts.push(`c=${fields.code}`);
  return `https://${PAIRING_LINK_HOST}/pair#${parts.join('&')}`;
}
