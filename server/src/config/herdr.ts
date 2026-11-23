/**
 * herdr integration settings: the pane flood guard, the socket path, and the write, launch, focus and tab label
 * switches. Parsers for `loadConfig` (`server/src/config.ts`); the herdr safety constants stay in `config.ts`.
 */
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, HERDR_SOCKET_ENV, MAX_PANES_ENV } from '../config-env.ts';
import { expandTilde } from './roots.ts';

/**
 * Sufit ŻYWYCH paneli Raroga — ZAPORA PRZECIWPOWODZIOWA, nie limit pracy (`RAROG_MAX_PANES`).
 *
 * The ceiling is not a permission boundary: the same phone has an SSH client over Tailscale, and a shell can start
 * any number of `claude` processes without asking Rarog. A low ceiling would take power from the owner in the
 * middle of normal work, not from an attacker.
 *
 * 30 jest tu z tego powodu i ten powód trzeba znać, żeby nie „poprawić" tej liczby w dół:
 * to nie jest granica uprawnień, tylko bezpiecznik na wypadek POWODZI — skryptu albo pętli,
 * która zaczyna zakładać panele bez opamiętania. Wartość ma być taka, żeby ręka jej NIGDY nie
 * dotknęła (manual use opens a few panes), a hodowla dotknęła w kilkanaście minut. Drugi bezpiecznik
 * tej ścieżki, throttle (1/5 s, 40/h), liczy TEMPO, nie sumę — dlatego sam nie wystarcza
 * i dlatego górna granica w ogóle istnieje.
 *
 * Obwodem bezpieczeństwa jest Tailscale plus klucz urządzenia, nie ta liczba. Szczegóły:
 * `docs/security-model.md`.
 */
export const DEFAULT_MAX_PANES = 30;

/**
 * Brak zmiennej = domyślna zapora (30). Ustawiona musi być liczbą całkowitą ≥ 1 — „0" nie
 * znaczy „bez limitu", tylko „ani jednego panelu", i właśnie dlatego zostaje odrzucone: cicha
 * zamiana tych dwóch znaczeń jest tym rodzajem pomyłki, po której bezpiecznik jest martwy.
 * Kto naprawdę chce bez sufitu, wpisuje liczbę, której nie osiągnie — sentinela na „wyłącz"
 * NIE MA, bo górna granica ma istnieć zawsze.
 */
export function parseMaxPanes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PANES;
  const max = Number(raw.trim());
  if (!Number.isInteger(max) || max < 1) {
    throw new ConfigError(
      `${MAX_PANES_ENV} must be an integer ≥ 1 (got: ${raw}).`,
    );
  }
  return max;
}

/** Domyślna ścieżka gniazda herdr (`~/.config/herdr/herdr.sock`). */
export function defaultHerdrSocket(home: string = os.homedir()): string {
  return path.join(home, '.config', 'herdr', 'herdr.sock');
}

/**
 * Killswitch kanału zapisu do ISTNIEJĄCYCH paneli. Domyślnie `true` — `0` zostawia Raroga
 * w trybie tylko do odczytu, bez zabijania podglądu 17 paneli.
 */
export function parseHerdrSend(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/**
 * Killswitch kanału TWORZENIA. Domyślnie `false` — opt-in, nie opt-out.
 *
 * Asymetria wobec `parseHerdrSend` jest celowa i jest całą treścią tej funkcji: pisanie do
 * panelu, który człowiek sam otworzył, jest o klasę mniejszą władzą niż uruchomienie procesu
 * w katalogu, którego nikt nie otwierał.
 */
export function parseHerdrLaunch(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * Czy wejście w transkrypt gasi `done` w herdr. Domyślnie `true` — opt-out, jak
 * `parseHerdrSend`, a nie opt-in.
 *
 * Domyślne „włączone" jest bezpieczne z tego samego powodu, dla którego to nie jest killswitch:
 * `agent.focus` to metoda mutująca, więc `RAROG_HERDR_SEND=0` gasi tę ścieżkę PRZED tą flagą.
 * Wyłącznik istnieje dla jednego kosztu, którego killswitch zapisu nie opisuje: przestawienia
 * widoku herdr na Macu w chwili, gdy ktoś przy nim siedzi.
 */
export function parseHerdrSeenFocus(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/**
 * Czy Rarog nazywa taby w herdr po założeniu. Domyślnie `true` — opt-out, jak
 * {@link parseHerdrSeenFocus} i z tej samej racji: obie mutacje (`tab.rename`, `pane.rename`)
 * gasi `RAROG_HERDR_SEND=0` przed tą flagą. Wyłącznik istnieje dla kosztu, którego killswitch
 * zapisu nie opisuje: „Rarog przemianował mi tab" (runbook w `docs/security-model.md`).
 */
export function parseHerdrTabLabels(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

export interface HerdrSocketOptions {
  home?: string;
  /**
   * Wstrzykiwany test „ten plik jest gniazdem”. Zwraca `null`, gdy pliku NIE MA — to jest
   * inna sytuacja niż „jest, ale nie jest gniazdem” (patrz komentarz w `parseHerdrSocket`).
   */
  isSocket?: (candidate: string) => boolean | null;
}

function realIsSocket(candidate: string): boolean | null {
  try {
    return statSync(candidate).isSocket();
  } catch {
    return null;
  }
}

/**
 * Waliduje `RAROG_HERDR_SOCKET`.
 *
 * Rozróżnienie, które trzeba zrozumieć przed zmianą tej funkcji:
 * - ścieżka względna, z `..` albo wskazująca na plik, który ISTNIEJE i NIE jest gniazdem
 *   → `ConfigError`, czyli serwer nie wstaje. To jest literówka w konfiguracji i cicha
 *   praca z takim ustawieniem znaczyłaby „integracja nigdy nie zadziała, a nikt nie wie",
 * - ścieżka poprawna, ale pliku NIE MA → to NIE jest błąd konfiguracji. herdr bywa
 *   uruchamiany po Rarogu, a `docs/security-model.md`, „Fail closed at start” mówi wprost: niedostępny socket = zero sesji herdr
 *   i baner, nigdy 500 i nigdy nieudany start.
 */
export function parseHerdrSocket(
  raw: string | undefined, opts: HerdrSocketOptions = {},
): string {
  const home = opts.home ?? os.homedir();
  const isSocket = opts.isSocket ?? realIsSocket;
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return defaultHerdrSocket(home);

  const expanded = expandTilde(trimmed, home);
  if (!path.isAbsolute(expanded)) {
    throw new ConfigError(`${HERDR_SOCKET_ENV} must be an absolute path (got: ${raw ?? ''}).`);
  }
  if (expanded.split(path.sep).includes('..')) {
    throw new ConfigError(`${HERDR_SOCKET_ENV} must not contain a ".." segment.`);
  }
  const socket = path.resolve(expanded);
  if (isSocket(socket) === false) {
    throw new ConfigError(`${HERDR_SOCKET_ENV}: ${socket} exists but is not a unix socket.`);
  }
  return socket;
}
