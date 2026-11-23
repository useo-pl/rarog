/**
 * Rejestr kształtów warstwy 2: dialogi CLI, które dostają przyciski z bloku na ekranie.
 *
 * Kształt to blok zmierzony na żywym CLI i przejrzany przez właściciela, z plikiem w zestawie kontrolnym
 * (`server/test/fixtures/herdr/kontrolny/`, pole `shape` w `manifest.json`). Dopasowanie kształtu jest dowodem końca
 * bloku: kształt przypina rodzaj góry, tytuł, treść, komplet par cyfra–etykieta i linie pod opcjami, więc blok ucięty,
 * dopisany albo podmieniony nie pasuje. Dialog spoza rejestru dostaje kartę bez przycisków, także gdy ma stopkę.
 *
 * Rejestr jest jak `SCREEN_SIGNATURES` (`screen/signatures.ts`): każdy wpis to literał wyglądu CLI z wersją i datą
 * pomiaru. Wzorce treści i etykiet NIE mają kotwic: `match.ts` dopasowuje je zawsze do CAŁEGO tekstu (treść po
 * sklejeniu linii, ogon surowej linii opcji). Grupa nazwana `value` przechwytuje wartość dialogu (nazwę modelu); ta
 * sama wartość musi stać w treści i w każdej etykiecie, która ją niesie.
 *
 * Nowy kształt: zrzut w zestawie kontrolnym z werdyktem `buttons`, przegląd etykiet pod eskalację uprawnień i wpis
 * tutaj.
 * Pilnuje tego test manifestu w `server/test/dialogs-layer2-block.test.ts`.
 *
 * The module also holds `PICKER_SHAPES`: measured pickers whose own lines between the options and the footer the
 * layer 2 rule (`verdict.ts`) reads as part of the block. Their test:
 * `server/test/dialogi-warstwa2-werdykt-korpus.test.ts`.
 */
import type { BlockTopKind } from '../screen/region.ts';

/** Para opcji kształtu: cyfra i wzorzec całego ogona surowej linii za `N. `. */
export interface ShapeOption {
  readonly digit: string;
  readonly label: RegExp;
}

/** Wpis rejestru: jeden zmierzony kształt bloku. */
export interface BlockShape {
  readonly id: string;
  /** Wersja CLI ostatniego pomiaru kształtu. */
  readonly cli: string;
  /** Zrzut z tego pomiaru w `fixtures/herdr/` (ścieżka jak w `manifest.json`), z werdyktem `buttons`. */
  readonly fixture: string;
  /** Wartość `waitingFor` z rejestru procesów CLI w chwili zrzutu (klasa dialogu z pomiaru zestawu kontrolnego). */
  readonly waitingFor: string;
  /** Zmierzone rodzaje góry bloku; rodzaj spoza listy daje brak kształtu. */
  readonly tops: readonly BlockTopKind[];
  /** Tytuł bloku dosłownie (pierwsza niepusta linia pod górą bez białych znaków na brzegach). */
  readonly title: string;
  /** Wzorzec treści po sklejeniu linii (`Block.bodyText`), z grupą `value`. */
  readonly body: RegExp;
  /** Komplet par w kolejności ekranu; innych linii między opcjami nie ma. */
  readonly options: readonly ShapeOption[];
  /** Jak dialog przyjmuje decyzję: cyfra wybiera i zatwierdza. */
  readonly submit: 'digit';
  /** Niepuste linie pod ostatnią opcją, dosłownie (bez brzegowych spacji); `[]` = nic pod opcjami. */
  readonly below: readonly string[];
  /** Cyfry, które dostają przycisk (dalej filtruje je polityka opcji). */
  readonly buttons: readonly string[];
  /** Cyfra opcji z rolą „zatwierdź”; jej etykieta pochodzi z tej samej pary z {@link options}. */
  readonly allow: string;
  /** Komenda, której potwierdzeniem jest dialog: wartość z kształtu porównuje się z jej argumentem. */
  readonly command: 'model' | 'effort';
}

/**
 * Surowa linia opcji kształtu: wcięcie spacjami, opcjonalny marker fokusu `❯` ze spacjami, cyfra, kropka, jedna
 * spacja i ogon (etykieta). Nic poza wcięciem i markerem nie jest zdejmowane: ramka, checkbox, `↓` i `↑` przed
 * cyfrą łamią wzorzec.
 */
export const SHAPE_OPTION_LINE = {
  pattern: /^ *(?:❯ +)?(\d)\. (.*)$/u,
  cli: '2.1.316',
} as const;

/**
 * Nazwa modelu w „Switch model?”: rodzina wielką literą, wersja z kropkami, opcjonalnie „(1M context)”. Zmierzone
 * w zestawie kontrolnym (CLI 2.1.316): Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5. „(1M context)” po nazwie stoi
 * w dialogu pauzy sesji (`dialog-session-paused-2.1.309.txt`); w „Switch model?” go nie zmierzono.
 */
const MODEL_NAME = String.raw`[A-Z][a-z]{1,15} \d{1,2}(?:\.\d{1,2}){0,2}(?: \(1M context\))?`;

/**
 * Rejestr kształtów — lista ZAMKNIĘTA.
 *
 * - `model-confirm` — „Switch model?” po wyborze w pickerze `/model` i po komendzie `/model <alias>`. CLI 2.1.314
 *   i 2.1.316: treść „Your next response will be slower and use more tokens” i „This
 *   conversation is cached for the current model. Switching to <model> means the full history gets re-read.”, opcje
 *   „Yes, switch to <model>” i „No, go back”, bez stopki. Góra: kreska ze statusem sesji, gdy CLI pokazuje wskaźnik
 *   effortu, i goła kreska po jego zniknięciu (`potwierdzenie-model-opus-2.1.316.txt`). Klasa rejestru CLI:
 *   `dialog open`. Treść z CLI 2.1.241 („…re-read on your next message.”, `dialog-model-switch.txt`) to inny wzorzec
 *   i do kształtu nie pasuje. Etykiety bez eskalacji: „Yes, switch to” zmienia model sesji, „No, go back”
 *   zamyka dialog.
 *
 * „Change effort level?” kształtu nie ma: na CLI 2.1.316 dialog nie stanął (lista `missing` manifestu).
 */
export const BLOCK_SHAPES: readonly BlockShape[] = [
  {
    id: 'model-confirm',
    cli: '2.1.316',
    fixture: 'kontrolny/potwierdzenie-model-2.1.316.txt',
    waitingFor: 'dialog open',
    tops: ['status', 'bare'],
    title: 'Switch model?',
    body: new RegExp(
      String.raw`Your next response will be slower and use more tokens This conversation is cached for the current `
        + String.raw`model\. Switching to (?<value>${MODEL_NAME}) means the full history gets re-read\.`,
      'u',
    ),
    options: [
      { digit: '1', label: new RegExp(String.raw`Yes, switch to (?<value>${MODEL_NAME})`, 'u') },
      { digit: '2', label: /No, go back/u },
    ],
    submit: 'digit',
    below: [],
    buttons: ['1', '2'],
    allow: '1',
    command: 'model',
  },
];

/**
 * A measured picker for the layer 2 rule (`verdict.ts`): a list whose options carry a description in a column and
 * whose digit picks the option at once. Its entry names the lines between the last option and the key footer that
 * belong to the picker and give no button. The rule reads such a line as part of the block instead of `extra-below`,
 * only under the literal title of the entry; the end proof stays the footer. A picker whose digit only highlights the
 * option has no entry, and neither has one whose digit does more than its label says.
 */
export interface PickerShape {
  readonly id: string;
  /** CLI version of the measurement that showed what a digit does in the picker. */
  readonly cli: string;
  /** Capture of that measurement in `fixtures/herdr/` (path as in `kontrolny/manifest.json`). */
  readonly fixture: string;
  /** Block title, literal (the first non-empty line under the top, trimmed). */
  readonly title: string;
  /**
   * Lines between the last option and the footer, each a pattern anchored to the whole trimmed line. Each may stand
   * once, after a blank line; any other line there is `extra-below`.
   */
  readonly settings: readonly RegExp[];
}

/**
 * Pickers — a CLOSED list, empty today. The mechanism stays for a measured picker whose digit is safe to offer.
 *
 * The `/model` picker ("Select model") has no entry on purpose: a digit there acts as Enter, and the footer says what
 * Enter does, "Enter to set as default · s to use this session only · Esc to cancel" (CLI 2.1.323, account with a
 * subscription). A digit button would change the default model of every new session under a label that does not say
 * so. The rule refuses such a footer before it reads the options (`sets-default`, `verdict.ts`), with or without an
 * entry here, so the picker gets a card without buttons; the phone changes the model with the command
 * `/model <alias>` and "Switch model?".
 */
export const PICKER_SHAPES: readonly PickerShape[] = [];
