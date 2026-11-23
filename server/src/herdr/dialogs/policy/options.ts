/**
 * Wybór opcji dialogu zgody po TREŚCI etykiety (`docs/dialogs.md`, „Rules: what must not be relaxed”): która opcja znaczy „tak, ten jeden
 * raz", a która „tak, i nie pytaj więcej".
 *
 * Słownik eskalacji jest jeden — `policy/escalation.ts` (`optionEscalates`, `readGrantTruncated`,
 * `MODE_SWITCH_PATTERN`); tutaj stoją wyłącznie reguły wyboru nad nim. Remis albo brak kandydata = `null`,
 * czyli żaden klawisz.
 */
import { foldApostrophes } from '../screen/options.ts';
import { MODE_SWITCH_PATTERN, optionEscalates, readGrantTruncated } from './escalation.ts';
import type { ScreenOption } from '../screen/options.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';

/** Etykieta twierdząca („Yes…”) — kandydat obu przycisków zgody. */
const AFFIRMATIVE_OPTION_PATTERN = SCREEN_SIGNATURES.affirmativeOption.pattern;

/**
 * Opcja „tak, ten jeden raz" — jedyna, którą wolno zatwierdzić z telefonu.
 *
 * Kontrakt `respondPermission(reqId, 'allow')` nie niesie etykiety (i nie będzie: pochodzi
 * sprzed integracji herdr), a dialog CLI ma zwykle TRZY opcje, z których dwie są twierdzące:
 * „Yes" i „Yes, and don't ask again for pnpm commands in /Users/u/Projects/atlas". Ta druga
 * zmienia KONFIGURACJĘ uprawnień projektu na trwałe — jedno kliknięcie z telefonu wyłączałoby
 * pytania o całą klasę komend, i to bez pokazania, że o to chodzi.
 *
 * Dlatego reguła jest wąska i fail-closed:
 *
 * 1. kandydatem jest wyłącznie etykieta zaczynająca się od „yes",
 * 2. odpada każda, która obiecuje WIĘCEJ niż ten jeden raz („don't ask again", „always",
 *    „this session", „allow all", „Yes, and allow … commands" — pełna lista:
 *    `OPTION_ESCALATION_PATTERN`),
 * 3. zostaje DOKŁADNIE jedna → jej cyfra; zero albo więcej → `null`, czyli brak wysyłki.
 *
 * Angielskie brzmienia są tu świadomie: dialogi zgody Claude Code są po angielsku niezależnie
 * od języka rozmowy. Zmiana CLI na inne teksty ma dać `null` (kartę bez skutku), a nie strzał
 * w przypadkową opcję — dlatego dopasowanie jest po TREŚCI, nie po pozycji.
 *
 * Apostrof składamy przed dopasowaniem (`foldApostrophes`, zmierzone): żywe CLI
 * pisze „Yes, and don’t ask again for: cd *" z U+2019, a wzorzec z prostym `'` nie trafiałby
 * w niego wcale — kandydatami byłyby wtedy DWIE opcje „Yes…" i fail-closed odebrałby
 * zatwierdzanie karcie, w której człowiek widział zwykłe „Yes".
 */
export function affirmativeOption(options: readonly ScreenOption[]): ScreenOption | null {
  // Słownik eskalacji jest JEDEN — `OPTION_ESCALATION_PATTERN` przez `optionEscalates`.
  // Własna, węższa kopia tutaj rozjechałaby się z parserem: człon dopisany do listy (np.
  // „Yes, and allow … access and … commands" w trybie auto) nie działałby tutaj, KANDYDACI
  // byliby dwaj i fail-closed odbierałby karcie zatwierdzanie.
  const candidates = options.filter((option) => {
    const label = foldApostrophes(option.label);
    return AFFIRMATIVE_OPTION_PATTERN.test(label) && !optionEscalates(label);
  });
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

/**
 * Opcja „Yes, and don't ask again…" — twierdząca ORAZ eskalująca, dokładnie jedna.
 *
 * Lustrzane odbicie {@link affirmativeOption}: tamten ODSIEWA eskalację (przycisk „Zatwierdź"
 * ma znaczyć „ten jeden raz"), ten jej WYMAGA. Etykieta jedzie na kartę DOSŁOWNIE:
 * użytkownik czyta dokładnie to, co zatwierdzi, a dziennik zapisze ją przy cyfrze.
 *
 * Dwie opcje eskalujące ZDARZAJĄ SIĘ (zmierzone na CLI 2.1.285 i 2.1.293 w trybie
 * manual): zgoda Bash ma „Yes, and always allow access to <katalog> from this project" ORAZ
 * „Yes, and switch to auto mode". Druga zmienia TRYB sesji, nie dopisuje reguły, więc przy
 * kilku kandydatach odpadają przełączniki trybu ({@link MODE_SWITCH_PATTERN}) — przycisk
 * „zawsze" dostaje reguła, o ile zostaje dokładnie jedna. Każdy inny remis = `null`
 * (fail-closed, nigdy zgadywanie, którą rozszerzyć uprawnienia). Pojedynczy przełącznik trybu
 * zostaje kandydatem („Yes, and use auto mode" przy planie, „switch to accept edits"
 * przy edycji).
 *
 * Zgoda na odczyt katalogu z UCIĘTĄ etykietą (`readGrantTruncated`, wąski panel) kandydatem
 * nie jest: przycisk ma nazywać zmianę pełną etykietą, a ucięta mówi „…from this" bez zakresu.
 */
export function alwaysOption(options: readonly ScreenOption[]): ScreenOption | null {
  const candidates = options.filter((option) => {
    const label = foldApostrophes(option.label);
    return AFFIRMATIVE_OPTION_PATTERN.test(label) && optionEscalates(label) && !readGrantTruncated(label);
  });
  if (candidates.length === 1) return candidates[0] ?? null;
  const rules = candidates.filter((option) => !MODE_SWITCH_PATTERN.test(option.label));
  return rules.length === 1 ? rules[0] ?? null : null;
}
