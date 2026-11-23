/**
 * Znane dialogi (`KNOWN_DIALOGS`): zamknięta lista dialogów, które Rarog rozumie na tyle, żeby wystawić przyciski,
 * rozpoznawane w BLOKU dialogu po tytule albo zdaniu sygnatury i komplecie opcji. Lista jest odbiciem kontraktu
 * `KNOWN_DIALOG_IDS` (asercje typów w obu kierunkach).
 */
import type { KnownDialogId as ContractDialogId } from '@rarog/shared';
import type { DialogBlock } from './block.ts';
import { unbox } from './options.ts';
import type { ScreenOption } from './options.ts';
import type { ScreenDialog } from './parse.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';

/**
 * Dialog z {@link KNOWN_DIALOGS} w BLOKU (reguła 4): tytuł bloku z listy albo, gdy tytułu z listy
 * nie ma, zdanie sygnatury w treści bloku (od górnej kreski do pierwszej opcji, linie zawinięte
 * sklejone spacją). Do tego osobna opcja dla każdego wzorca `expect` — jedna etykieta nie zaspokaja
 * dwóch wzorców, więc dialog z samym „Yes” nie udaje pary Yes/No. Rodzaj i granicę sprawdza wołający.
 */
export function blockKnownDialog(
  lines: readonly string[], block: DialogBlock, firstOption: number, options: readonly ScreenOption[],
): KnownDialogId | null {
  if (block.ambiguous || block.top === -1) return null;
  const content = lines.slice(block.top + 1, firstOption).map(unbox).join(' ');
  for (const known of KNOWN_DIALOGS) {
    const titled = block.title?.kind === 'known' && block.title.id === known.id;
    const stated = block.title === null && known.content !== null && known.content.test(content);
    if (!titled && !stated) continue;
    const taken = new Set<string>();
    const complete = known.expect.every((pattern) => {
      const hit = options.find((opt) => !taken.has(opt.digit) && pattern.test(opt.label));
      if (hit === undefined) return false;
      taken.add(hit.digit);
      return true;
    });
    if (complete) return known.id;
  }
  return null;
}

/**
 * Dialogi, które Rarog ROZUMIE na tyle, żeby wystawić przyciski. Lista jest ZAMKNIĘTA.
 *
 * A match turns on the „Zatwierdź" button: the driver then sends cyfrę opcji twierdzącej, wybraną po TREŚCI etykiety, nigdy po pozycji.
 *
 * Dlaczego lista, a nie „narysuj przyciski z tego, co sparsowałeś": dialog bez odpowiednika
 * w jsonl to dokładnie ta sytuacja, w której Rarog NIE WIE, co zatwierdza (zaufanie katalogu,
 * zgoda MCP, wyjście z trybu plan). Generyczny Rarog do klikania w cudze dialogi byłby
 * najgroźniejszą funkcją w tym projekcie.
 *
 * Stan weryfikacji sygnatur (`rarog-spike`, claude 2.1.241):
 *
 * - `model` — **ZWERYFIKOWANY NA ŻYWO**. `dialog-model-switch.txt` jest zrzutem panelu.
 *   Nagłówek brzmi dokładnie „Switch model?" (bez nazwy modelu i bez spacji po „model"),
 *   a opcje niosą model docelowy: „1. Yes, switch to Opus 5" / „2. No, go back".
 * - `trust` — **ZWERYFIKOWANY NA ŻYWO** (integrator, `rarog-spike`, claude 3.1.6).
 *   `dialog-trust.txt` jest zrzutem panelu i obalił CAŁĄ wcześniejszą rekonstrukcję: żywy
 *   dialog nie ma ramki, nagłówek brzmi „Accessing workspace:”, a pytanie — „Quick safety
 *   check: Is this a project you created or one you trust?”. Zdania „Do you trust the files
 *   in this folder?” nie ma na ekranie w ogóle, więc stara sygnatura nie trafiała NIGDY
 *   i karta zaufania zostawała bez przycisków.
 *
 *   Zdanie jest ALTERNATYWĄ dwóch brzmień, a nie podmianą: starsze `claude` (i starszy zrzut)
 *   używały pytania o „files in this folder”, więc porzucenie go zamieniłoby jedną ślepą
 *   sygnaturę na drugą. Etykiety opcji różnią się między wersjami („Yes, proceed” vs
 *   „Yes, I trust this folder”), dlatego `expect` pilnuje wyłącznie prefiksów Yes/No —
 *   cyfra i tak idzie z TREŚCI etykiety, nigdy z pozycji.
 *
 * Sygnatura stoi w BLOKU dialogu (`blockKnownDialog`): `title` to tytuł pod górną kreską bloku,
 * `content` to zdanie w treści bloku od górnej kreski do opcji (tylko `trust`, którego starsze brzmienie nie
 * ma tytułu z listy). Wzorce po CAŁYM ekranie robiłyby z „Switch model” w scrollbacku albo w opisie komendy
 * dialog `model` z przyciskiem zatwierdzania nad zgodą `Bash`. Rodzaj `tool` i `question` znanym dialogiem
 * nie bywa.
 */
export const KNOWN_DIALOGS = [
  {
    id: 'trust',
    title: SCREEN_SIGNATURES.knownDialogTrustTitle.pattern,
    content: SCREEN_SIGNATURES.knownDialogTrust.pattern,
    expect: [SCREEN_SIGNATURES.knownDialogYesOption.pattern, SCREEN_SIGNATURES.knownDialogNoOption.pattern],
  },
  /*
   * Tytuł „Switch model?" dosłownie. Gałąź `|to ` USUNIĘTA: łapała każdy dialog
   * z „switch to X" w opcjach — m.in. „Change effort level?" z opcją „Yes, switch to high", który
   * dostawał wtedy etykietę „zmiana modelu". Dialogi bez tego tytułu obsługuje klasa `confirm`
   * (uniwersalna karta z dosłownymi opcjami).
   */
  {
    id: 'model',
    title: SCREEN_SIGNATURES.knownDialogModel.pattern,
    content: null,
    expect: [SCREEN_SIGNATURES.knownDialogYesOption.pattern, SCREEN_SIGNATURES.knownDialogNoOption.pattern],
  },
] as const;

export type KnownDialogId = (typeof KNOWN_DIALOGS)[number]['id'];

/*
 * Zamknięta lista sygnatur i jej odbicie w kontrakcie (`KNOWN_DIALOG_IDS`) muszą być tą samą
 * listą: identyfikator jedzie na telefon w `SessionSummary.herdrDialog` i to on decyduje,
 * jaką etykietę dostanie przycisk zatwierdzania. Para asercji typów pilnuje OBU kierunków —
 * dopisanie sygnatury tutaj bez wpisu w kontrakcie (albo odwrotnie) nie skompiluje się,
 * zamiast po cichu dać przycisk z generyczną etykietą.
 */
type _IdsMatchContract = KnownDialogId extends ContractDialogId ? true : never;
type _ContractMatchesIds = ContractDialogId extends KnownDialogId ? true : never;
const _idsMatchContract: _IdsMatchContract = true;
const _contractMatchesIds: _ContractMatchesIds = true;
void _idsMatchContract;
void _contractMatchesIds;

/**
 * Który dialog z zamkniętej listy stoi na ekranie — rozpoznanie z BLOKU, policzone w `parseOptions`
 * ({@link ScreenDialog.knownDialog}).
 *
 * Funkcja nie czyta ekranu: wzorzec po całym tekście dawałby przy sygnaturze w scrollbacku, w opisie
 * wywołania albo w komendzie przycisk zatwierdzania nad cudzym dialogiem. Parametr ekranu zostaje,
 * żeby wołający nie zmieniali się razem z regułą.
 *
 * @returns identyfikator sygnatury albo `null` (wtedy: wycinek ekranu i „Odrzuć", bez przycisków)
 */
export function matchKnownDialog(_text: string, dialog: ScreenDialog): KnownDialogId | null {
  return dialog.knownDialog;
}
