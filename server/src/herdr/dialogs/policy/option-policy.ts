/**
 * Polityka opcji z kanałem odpowiedzi (`docs/dialogs.md`, „Rules: what must not be relaxed”): JEDNO miejsce, które mówi, czy opcja dostaje na karcie
 * przycisk i czy jej cyfra może wyjść do panelu. Słownik eskalacji stoi w `escalation.ts`, lista dialogów tylko
 * z terminala w `terminal.ts`; tutaj stoi reguła nad nimi.
 *
 * Kanał rozstrzyga, co blokuje: cyfra wybiera i zatwierdza jedną opcję, więc przy formularzu wielokrotnego
 * wyboru tylko przełącza checkbox, a przy otwartej notatce wpisuje się jako tekst. Odpowiedź plikiem hooka niesie
 * tekst, więc ani wielokrotny wybór, ani notatka jej nie blokują. Eskalacja i dialog z listy terminalowej blokują
 * w każdym kanale.
 */
import { optionEscalates } from './escalation.ts';
import type { TerminalDialogId } from './terminal.ts';

/** Kanał odpowiedzi na kartę: cyfra do panelu albo plik hooka. */
export type OptionChannel = 'digit' | 'hook';

/** Powód blokady opcji, w kolejności pierwszeństwa. */
export type OptionBlock = 'terminal-dialog' | 'escalation' | 'multi-select' | 'notes-editing';

/** Opcja i jej dialog: etykieta z ekranu albo payloadu oraz stan formularza, z którego pochodzi. */
export interface OptionFacts {
  readonly label: string;
  /** Dialog z listy `TERMINAL_DIALOGS`; `null` = dialog spoza niej. */
  readonly terminalDialog: TerminalDialogId | null;
  /** Formularz wielokrotnego wyboru (sygnatury ekranu albo `multiSelect` autora pytania). */
  readonly multiSelect: boolean;
  /** Formularz w trybie edycji notatki (`ctrl+g to edit` w stopce). */
  readonly notesEditing: boolean;
}

export interface OptionPolicy {
  /**
   * Pole karty, w obu kanałach: opcja bez przycisku, a serwer odmawia jej wyboru. Eskalacja uprawnień
   * (`optionEscalates`) albo dialog z listy terminalowej (każda jego opcja).
   */
  readonly terminalOnly: boolean;
  /** Tylko kanał `digit`: cyfra tej opcji nie wychodzi. `terminalOnly`, wielokrotny wybór albo otwarta notatka. */
  readonly digitBlocked: boolean;
  /** Pierwszy powód blokady w tym kanale; `null` = opcja wolna. */
  readonly why: OptionBlock | null;
}

/** Werdykt polityki dla jednej opcji w danym kanale (patrz nagłówek modułu). */
export function optionPolicy(option: OptionFacts, channel: OptionChannel): OptionPolicy {
  const terminal: OptionBlock | null = option.terminalDialog !== null
    ? 'terminal-dialog'
    : optionEscalates(option.label) ? 'escalation' : null;
  const digit: OptionBlock | null = channel !== 'digit'
    ? null
    : option.multiSelect ? 'multi-select' : option.notesEditing ? 'notes-editing' : null;
  const why = terminal ?? digit;
  return { terminalOnly: terminal !== null, digitBlocked: channel === 'digit' && why !== null, why };
}
