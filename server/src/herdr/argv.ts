/**
 * Argumenty `claude` dla `agent.start` — budowa i ZAMKNIĘTA allow-lista.
 *
 * Jedyne miejsce w Rarogu, które składa `args` dla `agent.start`.
 *
 * **Fakt, który dyktuje kształt tego modułu:** `agent.start` nie robi `execve`.
 * `herdr agent start --help` mówi wprost „Existing pane at an interactive shell prompt",
 * a błąd `agent_pane_busy` przy zajętym panelu potwierdza, że herdr WPISUJE LINIĘ POLECEŃ
 * DO PTY. Każdy element `args` jest więc tekstem w POWŁOCE. `assertSendable`
 * (`commands/guard.ts`) czyści znaki sterujące TERMINALA, nie metaznaki powłoki — `$( )`,
 * backtick, `'`, `\n` przechodzą przez nią nietknięte. Dlatego wartości muszą przejść przez
 * {@link ARG_VALUE_PATTERN}, a żaden tekst od człowieka nie ma prawa tu trafić:
 * prompt startowy jedzie `agent.prompt` po `interactive_ready`, nigdy w argv.
 *
 * Allow-lista jest sprawdzana PO ZBUDOWANIU tablicy, a nie tylko przy budowie: budowniczy może
 * się pomylić, a `agent.start` uruchamia PROCES na Macu użytkownika.
 */
import { EFFORT_LEVELS, MODEL_ID_PATTERN, PERMISSION_MODES } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { ENGINE_SESSION_ID_PATTERN } from '../transcript-import.ts';
import { HerdrError } from './types.ts';
import type { HerdrLaunchRequest } from './types.ts';
import { ULTRACODE_FLAG_VALUE } from './ultracode.ts';

/**
 * Flagi, które Rarog ma prawo podać `claude`. Lista jest ZAMKNIĘTA.
 *
 * Świadomie nigdy: `--dangerously-skip-permissions` (obchodzi całą ścieżkę zgód),
 * `--system-prompt` / `--append-system-prompt` (cudza sesja, cudze reguły), `--mcp-config`
 * i `--settings` (trwała konfiguracja poza sesją), `--continue` (niedeterministyczne:
 * „ostatnia rozmowa w cwd" zależy od tego, kto pisał ostatni), `--add-dir` (rozszerza zasięg
 * poza `cwd`), i cokolwiek innego zaczynającego się od `-`.
 */
export const ALLOWED_CLAUDE_FLAGS: ReadonlySet<string> = new Set([
  '--session-id', '--model', '--effort', '--permission-mode', '--resume',
]);

/** Jedyna flaga bez wartości. */
export const VALUELESS_CLAUDE_FLAGS: ReadonlySet<string> = new Set(['--fork-session']);

/**
 * Flagi wymienione w planie jako zablokowane NA STAŁE.
 *
 * Nie są używane przez kod produkcyjny (allow-lista i tak odrzuca wszystko spoza siebie) —
 * istnieją po to, żeby test wymieniał je z nazwiska. Dopisanie którejkolwiek do
 * {@link ALLOWED_CLAUDE_FLAGS} ma wywalić test, a nie przejść jako „drobna zmiana".
 */
export const FORBIDDEN_CLAUDE_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions', '--system-prompt', '--append-system-prompt',
  '--mcp-config', '--settings', '--add-dir', '--continue',
];

/**
 * Alfabet WARTOŚCI argumentów. Nic spoza niego nie ma prawa trafić do linii poleceń powłoki.
 *
 * Brak spacji, cudzysłowów, `$`, backticka, `;`, `|`, `&`, `<`, `>`, `(`, `)`, `\` i znaków
 * końca linii jest tu celem, a nie skutkiem ubocznym: to jedyna rzecz, która stoi między
 * polem formularza a `$(…)` wykonanym w powłoce panelu.
 *
 * Nawiasy kwadratowe (dla `--model opus[1m]`) są w zsh znakami globu, więc
 * ich obecność tu jest ZMIERZONA, nie założona: `herdr agent start … -- --model opus[1m]`
 * postawił panel ze stopką „Opus 5:1M" — herdr nie oddaje argumentów powłoce dosłownie
 * (`nomatch` nie przewrócił startu). Kształt sufiksu i tak pilnuje `MODEL_ID_PATTERN`
 * (tylko `[1m]`), a nawias sam w sobie nie otwiera podpowłoki ani cytowania.
 */
export const ARG_VALUE_PATTERN = /^[A-Za-z0-9._:@=[\]-]{1,64}$/;

/**
 * Argument niezgodny z allow-listą albo wartość spoza alfabetu.
 *
 * Osobna klasa z kodem `bad-request` (router → 400, nie 500): zły argument to zawsze błąd
 * żądania albo pomyłka programisty, nigdy awaria herdr.
 */
export class HerdrArgvError extends HerdrError {
  override readonly code = 'bad-request';
  override readonly name = 'HerdrArgvError';
}

/** Wzorzec elementu, który wolno zacytować w komunikacie błędu (nie przemyci treści). */
const SAFE_TO_QUOTE = /^--[a-z][a-z-]{0,40}$/;

/**
 * Zdanie „element spoza allow-listy” z opisem elementu.
 *
 * Wartości NIE są cytowane: element spoza schematu może być promptem użytkownika albo
 * sekretem, a komunikat błędu bywa logowany. Nazwa flagi jest bezpieczna (zamknięty alfabet),
 * więc ją pokazujemy — bez tego diagnoza „coś jest nie tak z argumentami" byłaby ślepa.
 * Reszta odmów dotyczy flagi, która już przeszła allow-listę (albo literału z tego modułu),
 * więc jej nazwa zawsze pasuje do {@link SAFE_TO_QUOTE} i stoi w zdaniu wprost.
 */
function notAllowed(position: number, element: string): HerdrArgvError {
  return new HerdrArgvError(SAFE_TO_QUOTE.test(element)
    ? say('herdr.argv-not-allowed.quoted', { position, flag: element })
    : say('herdr.argv-not-allowed.by-length', { position, length: element.length }));
}

/**
 * Sprawdza CAŁĄ tablicę argumentów: ściśle naprzemienna sekwencja `[flaga, wartość, …]`
 * z jedynym wyjątkiem na flagi bez wartości.
 *
 * Reguła nie brzmi „nie zaczyna się od `-`", tylko „wygląda dokładnie tak, jak ma wyglądać":
 * każdy element jest albo flagą z allow-listy, albo wartością bezpośrednio po niej.
 * Argument POZYCYJNY (prompt!) nie pasuje do żadnego z tych dwóch przypadków i rzuca.
 *
 * @throws {HerdrArgvError} przy pustej tablicy, elemencie spoza schematu, powtórzonej fladze,
 *                          fladze bez wartości albo wartości spoza {@link ARG_VALUE_PATTERN}
 */
export function assertAllowedArgs(args: readonly string[]): void {
  // Pusta tablica znaczy „uruchom `claude` bez `--session-id`" — a wtedy Rarog nie zna
  // ścieżki jsonl i cała warstwa treści jest zgadywaniem. To nigdy nie jest poprawne.
  if (args.length === 0) {
    throw new HerdrArgvError(say('herdr.argv-empty'));
  }

  const seen = new Set<string>();
  let i = 0;
  while (i < args.length) {
    const flag = args[i];
    if (flag === undefined) {
      throw new HerdrArgvError(say('herdr.argv-missing-position', { position: i }));
    }
    if (seen.has(flag)) {
      // Powtórzona flaga nigdy nie wychodzi z `buildClaudeArgs`, więc znaczy tylko jedno:
      // ktoś dokleił argumenty poza tym modułem.
      throw new HerdrArgvError(say('herdr.argv-repeated.quoted', { flag, position: i }));
    }
    seen.add(flag);

    if (VALUELESS_CLAUDE_FLAGS.has(flag)) {
      i += 1;
      continue;
    }
    if (!ALLOWED_CLAUDE_FLAGS.has(flag)) {
      throw notAllowed(i, flag);
    }

    const value = args[i + 1];
    if (value === undefined) {
      throw new HerdrArgvError(say('herdr.argv-no-value.quoted', { flag }));
    }
    if (value.startsWith('-')) {
      throw new HerdrArgvError(say('herdr.argv-value-like-flag.quoted', { flag }));
    }
    if (!ARG_VALUE_PATTERN.test(value)) {
      throw new HerdrArgvError(say('herdr.argv-value-charset.quoted', { flag }));
    }
    i += 2;
  }
}

/** Wartość semantycznie poprawna, ale spoza alfabetu → jeden komunikat, jedno miejsce. */
function assertValue(flag: string, value: string): string {
  if (!ARG_VALUE_PATTERN.test(value)) {
    throw new HerdrArgvError(say('herdr.argv-value-charset.quoted', { flag }));
  }
  return value;
}

/**
 * Zlecenie Raroga → tablica argumentów `claude`.
 *
 * **ZERO argumentów pozycyjnych** — funkcja nie ma nawet parametru na prompt i mieć go nie
 * będzie (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
 * Kolejność flag jest kontraktem: `--session-id`, `--resume` (+ `--fork-session`),
 * `--model`, `--effort`, `--permission-mode`.
 *
 * Brak `req.model` → BRAK flagi `--model` (model domyślny konta) — to jest ścieżka DOMYŚLNA,
 * a nie przypadek brzegowy. Tak samo `effort` i `permissionMode`.
 *
 * `req.ultracode === true` zajmuje miejsce `--effort`: wartość `ultracode` (docs: włącza ultracode
 * i ustawia poziom `xhigh`). Druga linia obrony po kontrakcie: poziom inny niż `xhigh` razem z ultracode rzuca,
 * bo CLI i tak wstałoby na `xhigh`. Wartość `ultracode` w `req.effort` dalej odpada — to nie poziom.
 *
 * `bypassPermissions` jest tu zwykłą wartością: o tym, czy wolno go użyć, decyduje
 * `#assertPermissionMode` w managerze (`RAROG_YOLO_ROOTS`). Ten moduł nie zna konfiguracji
 * i nie ma prawa jej udawać.
 *
 * Wartości są walidowane DWUKROTNIE: semantycznie (kształt uuid/modelu/effortu/trybu)
 * i alfabetem {@link ARG_VALUE_PATTERN}. Na koniec cała tablica przechodzi przez
 * {@link assertAllowedArgs} — bramka jest po budowie, nie przed nią.
 *
 * @param sessionId UUID wylosowany przez RAROGA i podawany przez `--session-id`; dzięki niemu
 *                  ścieżka pliku jsonl jest znana ZANIM agent wystartuje
 * @throws {HerdrArgvError} przy każdej wartości, której nie wolno wpisać do powłoki
 */
export function buildClaudeArgs(req: HerdrLaunchRequest, sessionId: string): string[] {
  if (!ENGINE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new HerdrArgvError(say('herdr.argv-session-id-shape'));
  }
  if (req.fork === true && req.resumeFrom === undefined) {
    throw new HerdrArgvError(say('herdr.argv-fork-without-resume'));
  }
  if (req.resumeFrom !== undefined && req.resumeFrom === sessionId) {
    // Wznowienie „samego siebie" dałoby dwóch pisarzy na jednym pliku jsonl.
    throw new HerdrArgvError(say('herdr.argv-resume-same'));
  }

  const args: string[] = [];

  /*
   * `--session-id` wchodzi TYLKO wtedy, gdy Rarog naprawdę nadaje sesji nowy identyfikator:
   * przy świeżej sesji i przy rozwidleniu. Przy zwykłym wznowieniu CLI odmawia wprost —
   * zmierzone w `rarog-spike`:
   *
   *     Error: --session-id can only be used with --continue or --resume
   *            if --fork-session is also specified.
   *
   * `claude` kończył się wtedy natychmiast, panel wracał do powłoki, a sesja w Rarogu
   * lądowała w `done` z „panel zniknął z herdr". Wznowiona sesja ZACHOWUJE swój uuid, więc
   * ścieżka jsonl jest znana bez podawania czegokolwiek — to `resumeFrom` jest jej adresem.
   */
  const forking = req.fork === true;
  if (req.resumeFrom === undefined || forking) {
    args.push('--session-id', assertValue('--session-id', sessionId));
  }

  if (req.resumeFrom !== undefined) {
    if (!ENGINE_SESSION_ID_PATTERN.test(req.resumeFrom)) {
      throw new HerdrArgvError(say('herdr.argv-resume-shape'));
    }
    args.push('--resume', assertValue('--resume', req.resumeFrom));
    if (forking) args.push('--fork-session');
  }

  if (req.model !== undefined) {
    if (!MODEL_ID_PATTERN.test(req.model)) {
      throw new HerdrArgvError(say('herdr.argv-model-shape'));
    }
    args.push('--model', assertValue('--model', req.model));
  }

  if (req.effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(req.effort)) {
    throw new HerdrArgvError(say('herdr.argv-effort'));
  }
  if (req.ultracode === true) {
    if (req.effort !== undefined && req.effort !== 'xhigh') {
      throw new HerdrArgvError(say('herdr.argv-ultracode-effort'));
    }
    args.push('--effort', assertValue('--effort', ULTRACODE_FLAG_VALUE));
  } else if (req.effort !== undefined) {
    args.push('--effort', assertValue('--effort', req.effort));
  }

  if (req.permissionMode !== undefined) {
    if (!(PERMISSION_MODES as readonly string[]).includes(req.permissionMode)) {
      throw new HerdrArgvError(say('herdr.argv-permission-mode'));
    }
    args.push('--permission-mode', assertValue('--permission-mode', req.permissionMode));
  }

  assertAllowedArgs(args);
  return args;
}
