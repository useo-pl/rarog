/**
 * Wersja serwera, jego możliwości i system maszyny — z JEDNEGO źródła.
 *
 * Wersja to pole `version` z `package.json` korzenia repo (`rarog`), czytane RAZ, przy pierwszym
 * imporcie modułu, czyli przy starcie serwera: podbicie wersji bez restartu nie zmienia tego, co
 * serwer raportuje, i tak ma być — raportuje kod, który działa. Wersja nie jest literałem w kodzie,
 * więc nie rozjedzie się z `package.json`.
 *
 * Wersję raportują `GET /health` (publiczny), `GET /api/version`, linia startu w `server.log`
 * i zrzut diagnostyczny odmowy, więc wartość przechodzi przez wąski wzorzec znaków: `package.json`
 * jest w repo, ale literówka nie ma prawa wejść do publicznej odpowiedzi ani rozbić linii logu.
 */
import { readFileSync } from 'node:fs';
import type { ServerSystem } from '@rarog/shared/rest';
import { ROOT_PACKAGE_JSON } from './install/mode.ts';

/** `package.json` korzenia instalacji (`server/src/install/mode.ts`). */
export { ROOT_PACKAGE_JSON };

/**
 * Dozwolony zapis wersji: cyfry, litery, kropka, plus i minus (semver z dopiskiem), do 64 znaków. Ten sam wzorzec
 * sprawdza wersję paczki w manifeście kopii hooka (`herdr/hook-config.ts`).
 */
export const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

/** Pole `version` z podanego `package.json`; brak, zły typ albo zły zapis = wyjątek przy starcie. */
export function readPackageVersion(file: URL | string = ROOT_PACKAGE_JSON): string {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown } | null;
  const version = parsed?.version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`${String(file)}: pole "version" brakuje albo ma zły zapis`);
  }
  return version;
}

/** Wersja serwera raportowana przez `/health` i `/api/version` (`config.version`). */
export const RAROG_VERSION: string = readPackageVersion();

/**
 * Możliwości serwera ogłaszane w `GET /api/version` (`capabilities`) i w odpowiedzi `POST /api/pair`: lista
 * nazw, po których apka pozna, czy serwer umie rzecz, której ona potrzebuje, zamiast zgadywać po numerze
 * wersji. Nazwa raz ogłoszona nie zmienia znaczenia; zniknąć może tylko razem z możliwością.
 *
 * - `device-auth` — nagłówek `Authorization: Rarog-Device <id>.<sekret>` w REST, SSE i WebSockecie;
 * - `pair` — `POST /api/pair` z kodem z linku `https://rarog.ai/pair#v=1&…` (kod z `rarog pair` na Macu);
 * - `pair-from-device` — `POST /api/pairings` (kod dla nowego urządzenia wydaje sparowane), `GET /api/devices`,
 *   `GET /api/devices/me` i `POST /api/devices/forget`;
 * - `push-relay` — serwer umie wysyłać pushe przez przekaźnik: wpis z przepustką idzie przekaźnikiem, a
 *   `POST /api/push/apns/status` może nieść `degradedReason` (`pass-missing`, `env-mismatch`). Możliwość kodu,
 *   nie konfiguracji: czy przekaźnik jest ustawiony (`RAROG_PUSH_RELAY_URL`), widać po statusie tokenu;
 * - `push-e2e-v2` — serwer umie wysłać baner z treścią zaszyfrowaną kluczem push urządzenia (nazwa
 *   zostaje stała), w formacie 3 (blok `rarog` `{v: 3, kid, n, c}`) wpisowi, który zadeklarował `pushFormats`
 *   z 3 w `POST /api/push/apns`. Możliwość kodu, nie konfiguracji: stoi także przy `RAROG_PUSH_E2E=0` (wtedy banerów
 *   nie ma).
 * - `companion` — serwer zna kontrakt agenta głosowego: `POST /api/sessions/:id/companion/ask` i pole
 *   `companionEnabled` w `GET /api/version`. Możliwość kodu, nie konfiguracji: czy agent działa (`RAROG_COMPANION`,
 *   klucz OpenAI i głos Soniox), mówi `companionEnabled`.
 * - `companion-sessions` — the server knows the contract of the voice agent's mode across sessions:
 *   `GET /api/sessions/:id/companion/turns` and the field `companionSessions` in `GET /api/version`. A capability of
 *   the code, not of the configuration: whether the mode works (`RAROG_COMPANION_SESSIONS` next to a working voice
 *   agent) says `companionSessions`.
 */
export const SERVER_CAPABILITIES: readonly string[] = [
  'device-auth', 'pair', 'pair-from-device', 'push-relay', 'push-e2e-v2', 'companion', 'companion-sessions',
];

/**
 * `inbox` — the server keeps an Inbox card per session: `GET /api/stream?inbox=1` adds the Inbox heads, and
 * `GET /api/inbox`, `GET /api/inbox/:sessionId` and `POST /api/inbox/:sessionId/remove|restore` answer. A capability of
 * the configuration, unlike the list above: absent with `RAROG_INBOX=0`, and then the app hides its Inbox.
 */
export const INBOX_CAPABILITY = 'inbox';

/**
 * `files` — the session file routes answer: `GET /api/sessions/:id/files?dir=` lists a directory of the session and
 * `GET /api/sessions/:id/files/raw?path=` sends one file of it. A capability of the configuration, like the Inbox:
 * absent while the routes are off, and then the app builds its file tree from the changes of `git-status` alone.
 */
export const FILES_CAPABILITY = 'files';

/**
 * `file-index` — `GET /api/sessions/:id/files/index` answers with the index of a session's files, which the app
 * searches. Announced with {@link FILES_CAPABILITY} and under the same switch; an app that does not see it searches
 * only the directories it has listed.
 */
export const FILE_INDEX_CAPABILITY = 'file-index';

/**
 * The capabilities announced now: {@link SERVER_CAPABILITIES}, plus {@link INBOX_CAPABILITY} when the Inbox is on and
 * {@link FILES_CAPABILITY} with {@link FILE_INDEX_CAPABILITY} when the session file routes answer (missing `files` =
 * they do not).
 */
export function serverCapabilities(features: { readonly inbox: boolean; readonly files?: boolean }): string[] {
  return [
    ...SERVER_CAPABILITIES,
    ...(features.inbox ? [INBOX_CAPABILITY] : []),
    ...(features.files === true ? [FILES_CAPABILITY, FILE_INDEX_CAPABILITY] : []),
  ];
}

/**
 * System maszyny serwera dla `GET /api/version` (`system`): `darwin` → `macos`, `linux` → `linux`, każdy inny
 * `process.platform` → `other`. Z tego pola apka bierze słowo maszyny („Mac” albo „VPS”).
 *
 * @param platform wstrzykiwalny system (testy); produkcja bierze `process.platform`.
 */
export function serverSystem(platform: NodeJS.Platform = process.platform): ServerSystem {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'other';
}
