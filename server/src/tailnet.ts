/**
 * Nazwa tailnetu, w którym stoi serwer — jedna linijka dla nagłówka AGENCI w kliencie
 * („do jakiego Tailscale'a jestem połączony, jeżeli jestem").
 *
 * DLACZEGO SERWER, A NIE KLIENT. Telefon wchodzi do Raroga po publicznym DNS
 * (np. `rarog.example.com`), a nie po nazwie MagicDNS — z `location.hostname` nie da się
 * odczytać ani tailnetu, ani tego, czy w ogóle jedziemy przez tailnet. Trasy spoza tailnetu
 * nie ma (`docs/security-model.md`, warstwa 1: DNS publiczny → adres 100.x, zero port-forwardu),
 * więc „serwer widzi tailnet X" znaczy dla klienta dokładnie „jesteś w X".
 *
 * TRZY REGUŁY TEGO PLIKU:
 * 1. **Tylko odczyt.** Wołamy `tailscale status --json --peers=false` — bez `--peers` nie ma
 *    tu ani jednego adresu cudzego urządzenia, a `status` niczym w tailnecie nie steruje.
 * 2. **Nic nie rzuca.** Brak binarki, wyłączony backend, popsuty JSON, timeout — wszystko to
 *    ten sam wynik `null`, czyli „nie wiemy" i nagłówek zostaje pusty. Ficzer-ozdoba nie ma
 *    prawa wywrócić `/api/version`, po którym idą flagi mikrofonu i terminala.
 * 3. **Wynik ma termin ważności.** Odpytywanie procesu przy każdym żądaniu byłoby spawnem
 *    per request; stan Tailscale'a zmienia się w skali minut, nie milisekund.
 */
import { execFile } from 'node:child_process';
import { TAILNET_ENV_PASSTHROUGH } from './config-env.ts';

/**
 * Gdzie szukamy CLI. W środowisku serwera (`env -i`) PATH jest szczątkowy, a na Macu
 * z App Store binarka NIE leży w żadnym `bin` — siedzi w pakiecie aplikacji. Lista jest
 * zamknięta i absolutna: żadnego szukania po PATH, żadnej powłoki, zero interpolacji.
 *
 * Ścieżki macOS stoją pierwsze, w niezmienionej kolejności, więc na Macu wygrywa ta sama binarka
 * co dotąd. Dwie ostatnie to pakiety Tailscale dla Linuksa (`/usr/bin`, a `/usr/sbin` w części
 * dystrybucji); na Macu ich nie ma, więc próba kończy się od razu błędem `ENOENT`.
 */
export const TAILSCALE_BINARIES: readonly string[] = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
  '/usr/sbin/tailscale',
];

/**
 * Sufit czasu na `status --json`. Zdrowy tailscaled odpowiada w kilkudziesięciu ms; sufit jest
 * na przypadek demona w połowie startu — `/api/version` ma odpowiadać od razu i mówić `null`,
 * a nie czekać, bo od tej odpowiedzi zależy pokazanie mikrofonu i wiersza terminala.
 */
export const TAILNET_TIMEOUT_MS = 1_500;

/** Termin ważności odczytu. Logowanie/wylogowanie z tailnetu widać najdalej po minucie. */
export const TAILNET_TTL_MS = 60_000;

/** Sufit długości nazwy — do nagłówka i tak wchodzi jedna linijka, a wejście jest obce. */
export const TAILNET_NAME_MAX = 64;

/** Surowy odczyt CLI: `stdout` albo `null`, gdy proces nie wystartował/nie odpowiedział. */
export type TailnetRunner = () => Promise<string | null>;

/**
 * Nazwa tailnetu z `tailscale status --json`.
 *
 * `CurrentTailnet.Name` to nazwa, którą człowiek widzi w konsoli Tailscale (np. `example.com`);
 * `MagicDNSSuffix` (np. `example.ts.net`) jest zapasem dla starszych wydań CLI, które pierwszego
 * pola nie mają. Stan inny niż `Running` (`Stopped`, `NeedsLogin`, `NoState`) to `null`, a nie
 * ostatnia znana nazwa: nagłówek ma mówić „jesteś w tailnecie", więc wyłączony Tailscale musi
 * z niego zniknąć, a nie zostawiać nieaktualnej etykiety.
 */
export function parseTailnetName(raw: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const status = json as {
    BackendState?: unknown;
    MagicDNSSuffix?: unknown;
    CurrentTailnet?: { Name?: unknown } | null;
  } | null;
  if (status === null || typeof status !== 'object') return null;
  if (status.BackendState !== 'Running') return null;
  const candidates = [status.CurrentTailnet?.Name, status.MagicDNSSuffix];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    // Znaki sterujące i białe znaki po brzegach lecą precz — to wejście z obcego procesu.
    const name = candidate.trim().replace(/[\p{Cc}\p{Cf}]/gu, '');
    if (name === '') continue;
    return name.slice(0, TAILNET_NAME_MAX);
  }
  return null;
}

/**
 * `TERM` MUSI BYĆ NIEPUSTY w środowisku CLI — zmierzone na wydaniu z App Store
 * (1.102.3). Bez niego `tailscale status` nie odpowiada w ogóle: wypisuje „The Tailscale GUI
 * failed to start" i kończy się KODEM 0, czyli wygląda jak sukces ze śmieciem zamiast JSON-a.
 * Serwer chodzi pod launchd z jawnym środowiskiem (`env -i`), gdzie `TERM`-a nie ma i być
 * nie musi — dokładamy go tutaj, w jedynym miejscu, które go potrzebuje, zamiast rozszerzać
 * listę przepustek serwera o zmienną, która z Rarogiem nie ma nic wspólnego.
 */
export const TAILSCALE_TERM = 'dumb';

/**
 * Środowisko procesu CLI. Co ze środowiska SERWERA do niego wchodzi — lista ZAMKNIĘTA `TAILNET_ENV_PASSTHROUGH`
 * (rejestr `config-env.ts`), ta sama reguła co przy `claude agents --json` (`LIVE_SESSIONS_ENV_PASSTHROUGH`)
 * i przy powłoce PTY (`TERM_ENV_PASSTHROUGH`). Sekrety Raroga (`SONIOX_API_KEY`, klucz APNs, klucz iroh)
 * nie mają jak wejść do obcej binarki, bo nie ma tu `...process.env`. Zmierzone: CLI odpowiada
 * nawet z samym `PATH` i `TERM`, więc lista jest krótka z konieczności, a nie z ostrożności.
 *
 * Wynik: przepustki z listy plus niepusty `TERM` (patrz wyżej).
 */
export function tailnetEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of TAILNET_ENV_PASSTHROUGH) {
    const value = base[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  // Pusty `TERM` jest dla CLI tym samym co brak — traktujemy go tak samo.
  const inherited = base['TERM'];
  env['TERM'] = inherited === undefined || inherited === '' ? TAILSCALE_TERM : inherited;
  return env;
}

/**
 * Domyślny runner: pierwsza binarka z {@link TAILSCALE_BINARIES}, która odpowie JSON-em.
 *
 * `execFile` bez powłoki i bez `cwd` — argumenty są literałami, więc nie ma tu czego wstrzyknąć.
 * Nieudane wywołanie (brak pliku, brak prawa, timeout, niezerowy kod) ORAZ odpowiedź, która nie
 * zaczyna się od `{`, przechodzą do następnej ścieżki; wyczerpanie listy daje `null`. Warunek
 * na `{` nie jest ostrożnością na zapas: to jedyne, po czym poznać opisany wyżej przypadek
 * „kod 0, a w środku komunikat o GUI".
 */
export function spawnTailscaleStatus(
  binaries: readonly string[] = TAILSCALE_BINARIES,
  timeoutMs = TAILNET_TIMEOUT_MS,
): TailnetRunner {
  const env = tailnetEnv();
  return async () => {
    for (const bin of binaries) {
      const out = await new Promise<string | null>((resolve) => {
        execFile(bin, ['status', '--json', '--peers=false'], {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 256 * 1024,
          encoding: 'utf8',
          windowsHide: true,
          env,
        }, (error, stdout) => { resolve(error === null ? stdout : null); });
      });
      if (out !== null && out.trimStart().startsWith('{')) return out;
    }
    return null;
  };
}

/**
 * Odczyt z terminem ważności i pojedynczym lotem — ta sama para mechanizmów, co przy sondzie
 * herdr w `/health` ({@link ../health.ts cacheProbe}) i z tych samych dwóch powodów: TTL ścina
 * ruch rozłożony w czasie, a wspólna obietnica ścina SZCZYT (dziesięć równoległych żądań =
 * jeden spawn, nie dziesięć). Osobna implementacja, bo tamta jest sondą boolowską, a tu wynik
 * jest nazwą; łączenie ich dałoby generyk, który po obu stronach czyta się gorzej niż dziesięć
 * linijek na miejscu.
 */
export function tailnetReader(
  run: TailnetRunner = spawnTailscaleStatus(),
  opts: { ttlMs?: number; now?: () => number } = {},
): () => Promise<string | null> {
  const ttlMs = opts.ttlMs ?? TAILNET_TTL_MS;
  const now = opts.now ?? Date.now;
  let value: string | null = null;
  let readAt = -Infinity;
  let inFlight: Promise<string | null> | null = null;
  return () => {
    if (now() - readAt < ttlMs) return Promise.resolve(value);
    inFlight ??= run()
      .then((raw) => (raw === null ? null : parseTailnetName(raw)))
      .catch(() => null)
      .then((name) => {
        value = name;
        readAt = now();
        inFlight = null;
        return name;
      });
    return inFlight;
  };
}
