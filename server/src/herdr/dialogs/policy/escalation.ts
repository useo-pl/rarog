/**
 * Słownik eskalacji uprawnień (`docs/dialogs.md`, „Rules: what must not be relaxed”) — JEDNA definicja tego, czego telefon nie zatwierdza zwykłym „Zatwierdź”:
 * markery eskalacji w treści dialogu i w etykiecie opcji, fraza deeskalacji, ostrzeżenie `cd` przed gitem,
 * ucięta zgoda na odczyt i przełącznik trybu sesji.
 *
 * Wzorce wyglądu pochodzą z rejestru sygnatur. Reguły wyboru opcji nad tym słownikiem: `policy/options.ts`.
 */
import { OPTION_LINE_PATTERN, foldApostrophes } from '../screen/options.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';

/**
 * Markery dialogów o PODNIESIONYCH uprawnieniach — te NIGDY nie są `confirm`.
 *
 * Uniwersalna karta potwierdzenia (silnik dialogów) rysuje przyciski z dosłownych
 * etykiet dowolnego dialogu tej klasy. Dialogi, których skutkiem jest rozszerzenie uprawnień
 * (zaufanie katalogu, bypass, „nie pytaj więcej"), zostają poza nią ŚWIADOMIE: zaufanie ma
 * własną sygnaturę z osobną obsługą (`KNOWN_DIALOGS`, karencja), a reszta — wycinek ekranu
 * i „Odrzuć (Esc)". Jedno tapnięcie z telefonu nie ma prawa trwale zmienić uprawnień panelu.
 */
export const ESCALATION_MARKER_PATTERN = SCREEN_SIGNATURES.escalationContent.pattern;

/**
 * Markery eskalacji w ETYKIECIE OPCJI — szersze niż {@link ESCALATION_MARKER_PATTERN}.
 *
 * Tą listą `affirmativeOption` (`policy/options.ts`) odsiewa opcje szersze niż jednorazowa zgoda
 * (jeden słownik dla jednej reguły eskalacji: z dwoma karta ekranowa
 * przepuściłaby „Yes, approve … for the rest of this session", które ścieżka jsonl odrzuca). Gołe `always`, `this session` i `rest of` są tu celowo: rozszerzenie
 * zgody w CZASIE jest eskalacją tak samo jak rozszerzenie w zakresie.
 *
 * `auto mode`: dialog `ExitPlanMode` ma opcję „Yes, and use
 * auto mode", która przestawia CAŁĄ SESJĘ w tryb wykonujący zmiany bez pytania. To eskalacja
 * w czystej postaci, a żaden inny człon (`auto-accept`) w nią nie trafia —
 * bez niego jedno tapnięcie „Zatwierdź" mogłoby wybrać właśnie ją.
 *
 * `yes, and allow` (zrzut
 * `dialog-permission-ask-rule-auto.txt`): w trybie auto reguła `Ask` rysuje opcję „Yes, and
 * allow /private/tmp/claude access and pnpm build and … commands" — to dopisanie TRWAŁYCH reguł
 * uprawnień, czyli eskalacja, tylko bez słów „don't ask again"/„always". Bez tego członu
 * `affirmativeOption` widziałoby dwie zwykłe opcje „Yes…" i odbierałoby karcie zatwierdzanie.
 *
 * Ta lista jest JEDYNYM słownikiem eskalacji: `affirmativeOption` odsiewa przez
 * `optionEscalates`, nie przez własną kopię (dwie kopie rozjeżdżają się).
 */
export const OPTION_ESCALATION_PATTERN = SCREEN_SIGNATURES.escalationOption.pattern;

/**
 * Czy ta OPCJA eskaluje uprawnienia („always allow…", „don't ask again…")?
 *
 * Polityka uniwersalnej karty klasyfikuje OPCJE, nie całe dialogi.
 * Skutek zależy od RODZAJU karty: na karcie PYTANIA opcja eskalująca zostaje
 * `terminalOnly` (bez przycisku, serwer odmawia cyfry), a na karcie ZGODY dostaje WŁASNY,
 * jawny przycisk z dosłowną etykietą — decyzja `allow-always`, cyfrę wybiera `alwaysOption`
 * (`policy/options.ts`). Granica eskalacji: trwałą zmianę uprawnień wolno zatwierdzić
 * z telefonu wyłącznie przyciskiem, który NAZYWA tę zmianę jej własną etykietą — nigdy
 * zwykłym „Zatwierdź" (tego dalej pilnuje `affirmativeOption`, odsiewając eskalację).
 */
export function optionEscalates(label: string): boolean {
  // „Exit plan mode?": „Yes, and switch to default (ask each time) for this session"
  // zapalało marker „this session", choć tryb `default` PYTA o każde narzędzie. Wycinamy
  // WYŁĄCZNIE tę frazę — każdy inny marker w tej samej etykiecie dalej znaczy eskalację.
  const folded = foldApostrophes(label).replace(DEESCALATION_OPTION_PATTERN, ' ');
  return OPTION_ESCALATION_PATTERN.test(folded);
}

/** Fraza trybu, który pyta o każde narzędzie — patrz {@link optionEscalates}. */
const DEESCALATION_OPTION_PATTERN = SCREEN_SIGNATURES.deescalationOption.pattern;

/**
 * Czy to zgoda na ODCZYT katalogu z UCIĘTĄ etykietą („Yes, allow reading from <katalog> from this…")?
 *
 * W panelu 63 kolumny etykieta zawija się na trzy linie, a trzecia („project") nakłada się na linię
 * następnej opcji (zrzuty odmów, fixture `dialog-permission-odczyt-z-projektu-waski.txt`).
 * Taka opcja dalej jest eskalacją, ale przycisk „zawsze" ma nazywać zmianę jej WŁASNĄ, pełną
 * etykietą — ucięta do tego nie wystarcza i zostaje w terminalu.
 */
export function readGrantTruncated(label: string): boolean {
  const folded = foldApostrophes(label);
  return READ_GRANT_MARKER_PATTERN.test(folded) && !READ_GRANT_COMPLETE_PATTERN.test(folded.trim());
}

const READ_GRANT_MARKER_PATTERN = SCREEN_SIGNATURES.readGrantMarker.pattern;
const READ_GRANT_COMPLETE_PATTERN = SCREEN_SIGNATURES.readGrantComplete.pattern;

/**
 * Marker eskalacji w TREŚCI regionu — z pominięciem linii opcji.
 *
 * Bez tego wyjątku opcja „Yes, and always allow…", obecna w KAŻDYM dialogu zgody na Bash,
 * zapalałaby marker treści i ubijała całą kartę, czyli trzymała każdą zgodę na narzędzie poza
 * Rarogiem. Treść (pytanie, nagłówek) sprawdzamy osobno, bo
 * dialog, którego SKUTKIEM jest eskalacja („Enable bypass permissions?"), ma zostać bez
 * przycisków niezależnie od brzmienia etykiet.
 */
export function contentEscalates(region: readonly string[]): boolean {
  const content = region
    .filter((line) => !OPTION_LINE_PATTERN.test(line))
    .join('\n')
    .replace(CD_ADVISORY_PATTERN, '');
  return ESCALATION_MARKER_PATTERN.test(foldApostrophes(content));
}

/**
 * Ostrzeżenie CLI w zgodzie na `Bash` z `cd` przed gitem — ZDEJMOWANE z treści przed testem
 * eskalacji.
 *
 * Zmierzone na CLI 2.1.265: pod komendą `cd /tmp && … git init …`
 * CLI dopisuje „This command changes directory before running git, which can execute untrusted
 * hooks from the target directory. Approve only if you trust it." Dwa słowa z tego zdania
 * („untrusted", „trust") trafiałyby w {@link ESCALATION_MARKER_PATTERN}, więc zwykła zgoda z opcjami
 * „Yes" / „No" jechałaby na telefon jako karta bez przycisków („odpowiedz w terminalu"). To zdanie
 * jest INFORMACJĄ o komendzie, nie dialogiem, którego skutkiem jest rozszerzenie uprawnień —
 * opcje pod nim są jednorazowe, a ich eskalację i tak osobno sprawdza `optionEscalates`.
 * Sygnatura jest ZAMKNIĘTA (całe zdanie, odstępy jako `\s+` przez zawijanie w wąskim panelu):
 * żaden inny tekst ze słowem „trust" przez ten wyjątek nie przechodzi.
 */
const CD_ADVISORY_PATTERN = SCREEN_SIGNATURES.cdAdvisory.pattern;

/**
 * Opcja, która przełącza TRYB uprawnień sesji, zamiast dopisać regułę.
 *
 * Brzmienia z żywych zrzutów: „switch to auto mode" (Bash, 2.1.285+), „switch to accept
 * edits" (Edit/Write), „use auto mode" (plan), „switch to default" („Exit plan mode?",
 * 2.1.293) i „bypass permissions" (plan z wyborem bypass).
 */
export const MODE_SWITCH_PATTERN = SCREEN_SIGNATURES.modeSwitchOption.pattern;
