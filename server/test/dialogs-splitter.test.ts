/**
 * Rozdzielacz warstw (`dialogs/router.ts`): pełna tabela klasa z rejestru CLI × zrzut hooka × ekran, zamknięte
 * listy werdyktów i powodów, wejścia rozdzielacza (`routeHookOf`, `routeScreenOf`) i werdykt na fixture'ach
 * z panelu. Werdykt idzie dziś wyłącznie do dziennika; decyzji „jaka karta” ani klawiszy nie zmienia.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_DIALOG_CLASSES, type CliDialogClass } from '@rarog/shared';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import {
  DIALOG_ROUTES, DIALOG_ROUTE_REASONS, routeAllowsDigit, routeDialog, routeHookOf, routeScreenOf,
  type DialogRoute, type DialogRouteReason, type RouteHook, type RouteScreen,
} from '../src/herdr/dialogs/router.ts';

const CLASSES: readonly (CliDialogClass | null)[] = [...CLI_DIALOG_CLASSES, null];
const HOOKS: readonly RouteHook[] = ['none', 'main', 'agent'];
const SCREENS: readonly RouteScreen[] = ['block', 'form', 'none'];

type Row = readonly [CliDialogClass | null, RouteHook, RouteScreen, DialogRoute, DialogRouteReason];

/** Cała tabela: każda klasa (i brak klasy) × zrzut × ekran, wypisana ręcznie, nie wyliczona z kodu. */
const TABLE: readonly Row[] = [
  ['permission', 'none', 'block', 'terminal-only', 'permission-no-dump'],
  ['permission', 'none', 'form', 'terminal-only', 'permission-no-dump'],
  ['permission', 'none', 'none', 'terminal-only', 'permission-no-dump'],
  ['permission', 'main', 'block', 'layer1', 'permission-dump'],
  ['permission', 'main', 'form', 'layer1', 'permission-dump'],
  ['permission', 'main', 'none', 'layer1', 'permission-dump'],
  ['permission', 'agent', 'block', 'layer1', 'permission-agent-dump'],
  ['permission', 'agent', 'form', 'layer1', 'permission-agent-dump'],
  ['permission', 'agent', 'none', 'layer1', 'permission-agent-dump'],
  ['sandbox', 'none', 'block', 'terminal-only', 'sandbox'],
  ['sandbox', 'none', 'form', 'terminal-only', 'sandbox'],
  ['sandbox', 'none', 'none', 'terminal-only', 'sandbox'],
  ['sandbox', 'main', 'block', 'terminal-only', 'sandbox'],
  ['sandbox', 'main', 'form', 'terminal-only', 'sandbox'],
  ['sandbox', 'main', 'none', 'terminal-only', 'sandbox'],
  ['sandbox', 'agent', 'block', 'terminal-only', 'sandbox'],
  ['sandbox', 'agent', 'form', 'terminal-only', 'sandbox'],
  ['sandbox', 'agent', 'none', 'terminal-only', 'sandbox'],
  ['input', 'none', 'block', 'none', 'input-shape'],
  ['input', 'none', 'form', 'question-form', 'input-form'],
  ['input', 'none', 'none', 'none', 'input-shape'],
  ['input', 'main', 'block', 'none', 'input-shape'],
  ['input', 'main', 'form', 'question-form', 'input-form'],
  ['input', 'main', 'none', 'none', 'input-shape'],
  ['input', 'agent', 'block', 'none', 'input-shape'],
  ['input', 'agent', 'form', 'question-form', 'input-form'],
  ['input', 'agent', 'none', 'none', 'input-shape'],
  ['dialog', 'none', 'block', 'layer2', 'dialog-block'],
  ['dialog', 'none', 'form', 'none', 'dialog-shape'],
  ['dialog', 'none', 'none', 'none', 'dialog-shape'],
  ['dialog', 'main', 'block', 'layer2', 'dialog-block'],
  ['dialog', 'main', 'form', 'none', 'dialog-shape'],
  ['dialog', 'main', 'none', 'none', 'dialog-shape'],
  ['dialog', 'agent', 'block', 'layer2', 'dialog-block'],
  ['dialog', 'agent', 'form', 'none', 'dialog-shape'],
  ['dialog', 'agent', 'none', 'none', 'dialog-shape'],
  ['worker', 'none', 'block', 'none', 'worker-class'],
  ['worker', 'none', 'form', 'none', 'worker-class'],
  ['worker', 'none', 'none', 'none', 'worker-class'],
  ['worker', 'main', 'block', 'none', 'worker-class'],
  ['worker', 'main', 'form', 'none', 'worker-class'],
  ['worker', 'main', 'none', 'none', 'worker-class'],
  ['worker', 'agent', 'block', 'none', 'worker-class'],
  ['worker', 'agent', 'form', 'none', 'worker-class'],
  ['worker', 'agent', 'none', 'none', 'worker-class'],
  ['goal', 'none', 'block', 'none', 'other-class'],
  ['goal', 'none', 'form', 'none', 'other-class'],
  ['goal', 'none', 'none', 'none', 'other-class'],
  ['goal', 'main', 'block', 'none', 'other-class'],
  ['goal', 'main', 'form', 'none', 'other-class'],
  ['goal', 'main', 'none', 'none', 'other-class'],
  ['goal', 'agent', 'block', 'none', 'other-class'],
  ['goal', 'agent', 'form', 'none', 'other-class'],
  ['goal', 'agent', 'none', 'none', 'other-class'],
  ['other', 'none', 'block', 'none', 'other-class'],
  ['other', 'none', 'form', 'none', 'other-class'],
  ['other', 'none', 'none', 'none', 'other-class'],
  ['other', 'main', 'block', 'none', 'other-class'],
  ['other', 'main', 'form', 'none', 'other-class'],
  ['other', 'main', 'none', 'none', 'other-class'],
  ['other', 'agent', 'block', 'none', 'other-class'],
  ['other', 'agent', 'form', 'none', 'other-class'],
  ['other', 'agent', 'none', 'none', 'other-class'],
  [null, 'none', 'block', 'none', 'no-class'],
  [null, 'none', 'form', 'none', 'no-class'],
  [null, 'none', 'none', 'none', 'no-class'],
  [null, 'main', 'block', 'none', 'dump-no-class'],
  [null, 'main', 'form', 'none', 'dump-no-class'],
  [null, 'main', 'none', 'none', 'dump-no-class'],
  [null, 'agent', 'block', 'none', 'dump-no-class'],
  [null, 'agent', 'form', 'none', 'dump-no-class'],
  [null, 'agent', 'none', 'none', 'dump-no-class'],
];

describe('rozdzielacz: tabela klasa × zrzut × ekran', () => {
  it.each(TABLE)('%s, zrzut %s, ekran %s → %s (%s)', (cliDialog, hook, screen, route, reason) => {
    expect(routeDialog({ cliDialog, hook, screen })).toEqual({ route, reason });
  });

  it('tabela pokrywa każdą kombinację dokładnie raz', () => {
    const keys = TABLE.map(([c, h, s]) => `${String(c)}|${h}|${s}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(CLASSES.length * HOOKS.length * SCREENS.length);
  });

  it('każdy werdykt i każdy powód z zamkniętych list ma wiersz w tabeli', () => {
    expect(new Set(TABLE.map((row) => row[3]))).toEqual(new Set(DIALOG_ROUTES));
    expect(new Set(TABLE.map((row) => row[4]))).toEqual(new Set(DIALOG_ROUTE_REASONS));
  });

  it('cyfrę dopuszczają wyłącznie formularz pytania i dialog CLI warstwy 2', () => {
    expect(DIALOG_ROUTES.filter(routeAllowsDigit)).toEqual(['question-form', 'layer2']);
  });
});

/**
 * „Cyfra nie trafia do zgody na narzędzie” na poziomie rozdzielacza: klasa `permission` i `sandbox` nigdy nie daje
 * werdyktu z cyfrą, niezależnie od zrzutu i od tego, co stoi na ekranie (także dialog zgody rozpoznany jako
 * potwierdzenie, np. `WebFetch`). Dziś werdykt tylko się loguje; strażnik po stronie drivera (zero
 * `#sendDigit` przy tych klasach) jest potrzebny dopiero wtedy, gdy rozdzielacz zacznie decydować.
 */
describe('rozdzielacz: zgoda na narzędzie nigdy cyfrą', () => {
  const CONSENT: readonly CliDialogClass[] = ['permission', 'sandbox'];

  it('każda kombinacja zrzutu i ekranu przy klasie permission i sandbox', () => {
    for (const cliDialog of CONSENT) {
      for (const hook of HOOKS) {
        for (const screen of SCREENS) {
          const { route } = routeDialog({ cliDialog, hook, screen });
          expect(routeAllowsDigit(route), `${cliDialog}/${hook}/${screen} → ${route}`).toBe(false);
        }
      }
    }
  });

  it('każdy ekran z fixture’ów przy klasie permission i sandbox', () => {
    const screens = fixtureScreens();
    expect(screens.length).toBeGreaterThan(100);
    for (const [name, text] of screens) {
      for (const cliDialog of CONSENT) {
        for (const hook of HOOKS) {
          const { route } = routeDialog({ cliDialog, hook, screen: routeScreenOf(text) });
          expect(routeAllowsDigit(route), `${name}: ${cliDialog}/${hook} → ${route}`).toBe(false);
        }
      }
    }
  });
});

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';

/** Ekran fixture'u; zrzut odmowy (`refusals/`) ma przed ekranem nagłówek, który tu odcinamy. */
function screen(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at === -1 ? raw : raw.slice(at + MARK.length);
}

/** Katalogi ekranów: fixture'y panelu (`fixtures/herdr/`, `measured/`, `queue/measured/`) i zrzuty odmów. */
const SCREEN_DIRS = ['', 'measured/', 'queue/measured/', 'refusals/'] as const;

/** Wszystkie ekrany `.txt` z {@link SCREEN_DIRS}. */
function fixtureScreens(): [string, string][] {
  return SCREEN_DIRS.flatMap((sub) => readdirSync(join(DIR, sub))
    .filter((file) => file.endsWith('.txt'))
    .map((file): [string, string] => [sub + file, screen(sub + file)]));
}

describe('routeScreenOf: ekran jako wejście rozdzielacza', () => {
  /**
   * Manifest: każdy ekran z {@link SCREEN_DIRS} → werdykt ekranu. Plik bez wpisu i wpis bez pliku przewracają test,
   * więc nowy fixture wymaga decyzji, czym jest jego ekran dla rozdzielacza.
   */
  const MANIFEST: Readonly<Record<string, RouteScreen>> = {
    'composer-empty-2.1.258.ansi.txt': 'none',
    'composer-ghost-suggestion-2.1.258.ansi.txt': 'none',
    'composer-region-empty-2.1.283.ansi.txt': 'none',
    'composer-region-leading-blank-2.1.283.ansi.txt': 'none',
    'composer-region-one-line-2.1.283.ansi.txt': 'none',
    'composer-region-wrapped-2.1.283.ansi.txt': 'none',
    'dialog-askuserquestion-2126.txt': 'form',
    'dialog-askuserquestion-linia-nazwy-2.1.281.txt': 'form',
    // Formularz pytania wypada z okna: nad opcjami zostaje luka, parser nie czyta dialogu.
    'dialog-askuserquestion-linia-nazwy-luka-2.1.281.txt': 'none',
    'dialog-askuserquestion-live.txt': 'form',
    'dialog-askuserquestion-multi-live-review.txt': 'form',
    'dialog-askuserquestion-multi-live-start.txt': 'form',
    'dialog-askuserquestion-multi-live-submit.txt': 'form',
    'dialog-askuserquestion-multi.txt': 'form',
    'dialog-askuserquestion-multiq-jednopytaniowy-submit.txt': 'form',
    'dialog-askuserquestion-multiq-pytanie-w-ramce.txt': 'form',
    'dialog-askuserquestion-multiq-review.txt': 'form',
    'dialog-askuserquestion-multiq-tab1-jednokrotne.txt': 'form',
    'dialog-askuserquestion-multiq-tab2-multiselect-next.txt': 'form',
    'dialog-askuserquestion-multiq-tab3-ostatnie.txt': 'form',
    'dialog-askuserquestion-notes.txt': 'form',
    'dialog-askuserquestion-preview.txt': 'form',
    'dialog-askuserquestion-scrollback.txt': 'form',
    'dialog-askuserquestion.txt': 'form',
    'dialog-automode-teach-2.1.258.txt': 'block',
    'dialog-background-work-exit-2.1.309.txt': 'block',
    'dialog-bash-ask-rule-2.1.295.txt': 'block',
    'dialog-bash-cytat-2.1.321.txt': 'block',
    'dialog-bash-kolejka-licznik-2.1.319.txt': 'block',
    'dialog-bash-licznik-block-2.1.316.txt': 'block',
    'dialog-bash-opis-telefon-2.1.302.txt': 'block',
    // Widok przewinięty: opcje dialogu poza ekranem.
    'dialog-bash-przewiniety-widok-2.1.295.txt': 'none',
    'dialog-bash-stechly-read-2.1.295.txt': 'block',
    'dialog-bash-stechly-read-szeroki-2.1.295.txt': 'block',
    'dialog-bash-subagent-naglowek-2.1.302.txt': 'block',
    'dialog-bash-subagent-telefon-2.1.302.txt': 'block',
    'dialog-bash-subagent-uciety-62x29-2.1.309.txt': 'block',
    'dialog-bash-uciety-naglowek-2.1.294.txt': 'block',
    'dialog-effort-change.txt': 'block',
    'dialog-exitplanmode-50kol-2.1.331.txt': 'block',
    'dialog-exitplanmode.txt': 'block',
    'dialog-model-switch.txt': 'block',
    'dialog-permission-ask-rule-auto.txt': 'block',
    'dialog-permission-cd-advisory-2.1.265.txt': 'block',
    'dialog-permission-mcp-supabase.txt': 'block',
    'dialog-permission-mcp.txt': 'block',
    'dialog-permission-odczyt-z-projektu-waski.txt': 'block',
    'dialog-permission-odczyt-z-projektu.txt': 'block',
    'dialog-permission-opis.txt': 'block',
    'dialog-permission-read-2.1.278.txt': 'block',
    'dialog-permission-subagent.txt': 'block',
    'dialog-permission-unsandboxed.txt': 'block',
    'dialog-permission.txt': 'block',
    'dialog-resume-summary-2.1.258.txt': 'block',
    'dialog-session-paused-2.1.309.txt': 'block',
    // Dialog zaufania bez numerów opcji: parser go nie czyta.
    'dialog-trust-2.1.293.txt': 'none',
    'dialog-trust-preapproved-2.1.332.txt': 'none',
    'dialog-trust.txt': 'block',
    'ekran-login-2.1.293.txt': 'none',
    'footer-auto-tacka.txt': 'none',
    'footer-auto.txt': 'none',
    'model-set-inline-2.1.258.txt': 'none',
    'measured/exitplanmode-2.1.258.txt': 'block',
    'measured/exitplanmode-2.1.278.txt': 'block',
    'measured/exitplanmode-2.1.293.txt': 'block',
    'measured/exitplanmode-2.1.328.txt': 'block',
    'measured/exitplanmode-bez-planu-2.1.293.txt': 'block',
    'measured/exitplanmode-bez-planu-2.1.322.txt': 'block',
    'measured/exitplanmode-bez-planu-2.1.328.txt': 'block',
    'measured/exitplanmode-bez-planu.txt': 'block',
    'measured/exitplanmode.txt': 'block',
    'measured/multiselect-2.1.258.txt': 'form',
    'measured/multiselect-2.1.278.txt': 'form',
    'measured/multiselect-2.1.285.txt': 'form',
    'measured/multiselect-2.1.293.txt': 'form',
    'measured/multiselect-2.1.328.txt': 'form',
    'measured/multiselect.txt': 'form',
    // Pickery `/effort` i `/model` w panelu 26 kolumn: suwak bez cyfr i lista modeli rodzaju `other` bez znanego
    // dialogu, czyli karta bez przycisków.
    'measured/picker-effort-2.1.312-26kol.txt': 'none',
    'measured/picker-model-2.1.312-26kol.txt': 'none',
    'measured/pytanie-jednokrotne-2.1.258.txt': 'form',
    'measured/pytanie-jednokrotne-2.1.278.txt': 'form',
    'measured/pytanie-jednokrotne-2.1.285.txt': 'form',
    'measured/pytanie-jednokrotne-2.1.293.txt': 'form',
    'measured/pytanie-jednokrotne-2.1.328.txt': 'form',
    'measured/pytanie-jednokrotne.txt': 'form',
    'measured/pytanie-preview-2.1.293.txt': 'form',
    'measured/pytanie-preview-2.1.328.txt': 'form',
    'measured/pytanie-preview.txt': 'form',
    'measured/wielopytaniowy-jednokrotne-2.1.258.txt': 'form',
    'measured/wielopytaniowy-jednokrotne-2.1.278.txt': 'form',
    'measured/wielopytaniowy-jednokrotne-2.1.285.txt': 'form',
    'measured/wielopytaniowy-jednokrotne-2.1.293.txt': 'form',
    'measured/wielopytaniowy-jednokrotne-2.1.328.txt': 'form',
    'measured/wielopytaniowy-jednokrotne.txt': 'form',
    'measured/wielopytaniowy-multiselect-2.1.258.txt': 'form',
    'measured/wielopytaniowy-multiselect-2.1.278.txt': 'form',
    'measured/wielopytaniowy-multiselect-2.1.285.txt': 'form',
    'measured/wielopytaniowy-multiselect-2.1.293.txt': 'form',
    'measured/wielopytaniowy-multiselect-2.1.328.txt': 'form',
    'measured/wielopytaniowy-multiselect-zakladka2-2.1.258.txt': 'form',
    'measured/wielopytaniowy-multiselect-zakladka2-2.1.278.txt': 'form',
    'measured/wielopytaniowy-multiselect-zakladka2-2.1.285.txt': 'form',
    'measured/wielopytaniowy-multiselect-zakladka2-2.1.293.txt': 'form',
    'measured/wielopytaniowy-multiselect-zakladka2-2.1.328.txt': 'form',
    'measured/wielopytaniowy-multiselect-zakladka2.txt': 'form',
    'measured/wielopytaniowy-multiselect.txt': 'form',
    'measured/zgoda-bash-2.1.258.txt': 'block',
    'measured/zgoda-bash-2.1.278.txt': 'block',
    'measured/zgoda-bash-2.1.285.txt': 'block',
    'measured/zgoda-bash-2.1.293.txt': 'block',
    'measured/zgoda-bash-2.1.328.txt': 'block',
    'measured/zgoda-bash-dluga-linia-2.1.311.txt': 'block',
    'measured/zgoda-bash-komenda-z-kreska-2.1.311.txt': 'block',
    'measured/zgoda-bash-opis-z-kreska-2.1.311.txt': 'block',
    'measured/zgoda-bash-wysoka-2.1.295.txt': 'block',
    'measured/zgoda-bash-wysoka-2.1.328.txt': 'block',
    'measured/zgoda-bash-wysoka.txt': 'block',
    'measured/zgoda-bash.txt': 'block',
    'measured/zgoda-drugi-edit-2.1.322.txt': 'block',
    'measured/zgoda-edit-2.1.258.txt': 'block',
    'measured/zgoda-edit-2.1.278.txt': 'block',
    'measured/zgoda-edit-2.1.285.txt': 'block',
    'measured/zgoda-edit-2.1.293.txt': 'block',
    'measured/zgoda-edit-2.1.322.txt': 'block',
    'measured/zgoda-edit-2.1.328.txt': 'block',
    'measured/zgoda-edit.txt': 'block',
    'measured/zgoda-mcp-2.1.293.txt': 'block',
    'measured/zgoda-mcp-2.1.322.txt': 'block',
    'measured/zgoda-mcp-2.1.328.txt': 'block',
    'measured/zgoda-mcp-argumenty-2.1.322.txt': 'block',
    'measured/zgoda-mcp.txt': 'block',
    'measured/zgoda-notebookedit-2.1.311.txt': 'block',
    // Panel 26 kolumn: stopka łamie się na dwie linie, parser czyta rodzaj `other` bez znanego dialogu, więc
    // ekran nie widzi bloku. Klasa `permission` z rejestru i tak nie daje cyfry (tabela wyżej).
    'measured/zgoda-notebookedit-delete-2.1.322.txt': 'block',
    'measured/zgoda-notebookedit-insert-2.1.322.txt': 'block',
    'measured/zgoda-notebookedit-replace-2.1.322.txt': 'block',
    'measured/zgoda-notebookedit-waski-2.1.311.txt': 'none',
    'measured/zgoda-read-dluga-sciezka-2.1.322.txt': 'block',
    'measured/zgoda-read-kolejka-2.1.322.txt': 'block',
    'measured/zgoda-read-offset-limit-2.1.322.txt': 'block',
    'measured/zgoda-read-poza-projektem-2.1.322.txt': 'block',
    'measured/zgoda-siec-2.1.293.txt': 'block',
    'measured/zgoda-siec-2.1.322.txt': 'block',
    'measured/zgoda-siec-2.1.328.txt': 'block',
    'measured/zgoda-siec.txt': 'block',
    'measured/zgoda-skill-2.1.311.txt': 'block',
    'measured/zgoda-skill-waski-2.1.311.txt': 'block',
    'measured/zgoda-webfetch-2.1.311.txt': 'block',
    // Jak wyżej: wąski panel, rodzaj `other`.
    'measured/zgoda-webfetch-2.1.322.txt': 'block',
    'measured/zgoda-webfetch-prompt-wieloliniowy-2.1.322.txt': 'block',
    'measured/zgoda-webfetch-waski-2.1.311.txt': 'none',
    'measured/zgoda-webfetch-waski-2.1.322.txt': 'block',
    'measured/zgoda-websearch-2.1.311.txt': 'block',
    'measured/zgoda-websearch-2.1.322.txt': 'block',
    'measured/zgoda-websearch-waski-2.1.311.txt': 'block',
    'measured/zgoda-write-2.1.258.txt': 'block',
    'measured/zgoda-write-2.1.278.txt': 'block',
    'measured/zgoda-write-2.1.285.txt': 'block',
    'measured/zgoda-write-2.1.293.txt': 'block',
    'measured/zgoda-write-2.1.322.txt': 'block',
    'measured/zgoda-write-2.1.328.txt': 'block',
    'measured/zgoda-write-dluga-linia-2.1.322.txt': 'block',
    'measured/zgoda-write-dluga-tresc-2.1.322.txt': 'block',
    'measured/zgoda-write-dluga-tresc-waski-2.1.322.txt': 'block',
    'measured/zgoda-write-falszywy-naglowek-2.1.322.txt': 'block',
    'measured/zgoda-write-nadpisanie-2.1.322.txt': 'block',
    'measured/zgoda-write-poza-projektem-2.1.322.txt': 'block',
    'measured/zgoda-write-waski-2.1.322.txt': 'block',
    'measured/zgoda-write.txt': 'block',
    // Kolejka wiadomości w polu tekstowym, nie dialog.
    'queue/measured/esc-nad-kolejka-po-esc-2.1.299.txt': 'none',
    'queue/measured/esc-nad-kolejka-po-esc-2.1.328.txt': 'none',
    'queue/measured/esc-nad-kolejka-przed-esc-2.1.299.txt': 'none',
    'queue/measured/esc-nad-kolejka-przed-esc-2.1.328.txt': 'none',
    'queue/measured/esc-w-tekscie-po-esc-2.1.299.txt': 'none',
    'queue/measured/esc-w-tekscie-po-esc-2.1.328.txt': 'none',
    'queue/measured/esc-w-tekscie-przed-esc-2.1.299.txt': 'none',
    'queue/measured/esc-w-tekscie-przed-esc-2.1.328.txt': 'none',
    // Take-back screens: field and history screens are no dialog. The 26-column pane wraps the dialog footer: the
    // standing `Write` dialog keeps its kind from the title, the frame and the file question, so it reads as a block
    // like any permission dialog, and the standing form reads as a block, not a form.
    'queue/measured/zabranie-dialog-po-up-2.1.328.txt': 'block',
    'queue/measured/zabranie-dialog-przed-2.1.328.txt': 'block',
    'queue/measured/zabranie-dlugie-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-formularz-po-down-2.1.328.txt': 'block',
    'queue/measured/zabranie-formularz-po-up-2.1.328.txt': 'block',
    'queue/measured/zabranie-formularz-przed-2.1.328.txt': 'block',
    'queue/measured/zabranie-historia-po-down-2.1.328.txt': 'none',
    'queue/measured/zabranie-historia-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-historia-szeroki-po-down-2.1.328.txt': 'none',
    'queue/measured/zabranie-historia-szeroki-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-meldunek-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-meldunek-przed-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-przed-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-szeroki-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-szeroki-przed-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-wklejka-po-ctrl-u-1-2.1.328.txt': 'none',
    'queue/measured/zabranie-wklejka-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-wklejka-przed-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-wklejka-szeroki-po-ctrl-u-1-2.1.328.txt': 'none',
    'queue/measured/zabranie-wklejka-szeroki-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-wklejka-szeroki-przed-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-wyscig-koniec-po-up-2.1.328.txt': 'none',
    'queue/measured/zabranie-wyscig-wynik-po-up-2.1.328.txt': 'none',
    // Zrzuty odmów: powłoka i widoki slash-komend to nie dialog; ucięty nagłówek zgody to dalej blok.
    'refusals/powloka-komunikat-przed-promptem.txt': 'none',
    'refusals/powloka-zawiniete-polecenie.txt': 'none',
    'refusals/widok-help-2.1.310.txt': 'none',
    'refusals/widok-skills-2.1.310.txt': 'none',
    'refusals/widok-status-2.1.310.txt': 'none',
    'refusals/widok-status-stechly-zrzut-2.1.310.txt': 'none',
    'refusals/zaufanie-bez-cyfr-2.1.311.txt': 'none',
    'refusals/zgoda-edit-uciety-naglowek-63x28.txt': 'block',
  };

  it('manifest i katalogi fixture’ów mają te same pliki', () => {
    const files = fixtureScreens().map(([name]) => name).sort();
    expect(Object.keys(MANIFEST).sort()).toEqual(files);
  });

  it.each(Object.entries(MANIFEST))('%s → %s', (name, expected) => {
    expect(routeScreenOf(screen(name))).toBe(expected);
  });

  it('brak odczytu ekranu → none', () => {
    expect(routeScreenOf(null)).toBe('none');
  });
});

describe('routeHookOf: zrzut hooka jako wejście rozdzielacza', () => {
  const dump = (fields: Partial<PendingHookTool>): PendingHookTool => ({
    toolName: 'Bash', toolInput: {}, at: 1, ...fields,
  });

  it('brak zrzutu → none', () => {
    expect(routeHookOf(null)).toBe('none');
  });

  it('zrzut PermissionRequest wątku głównego → main, subagenta (agent_id) → agent', () => {
    expect(routeHookOf(dump({ hookEventName: 'PermissionRequest' }))).toBe('main');
    expect(routeHookOf(dump({ hookEventName: 'PermissionRequest', agentId: 'a-1' }))).toBe('agent');
  });

  it('zrzut PreToolUse albo bez zdarzenia nie jest prośbą o zgodę', () => {
    expect(routeHookOf(dump({ hookEventName: 'PreToolUse' }))).toBe('none');
    expect(routeHookOf(dump({}))).toBe('none');
  });

  it('PermissionRequest formularza pytania to kanał odpowiedzi, nie zgody', () => {
    expect(routeHookOf(dump({ toolName: 'AskUserQuestion', hookEventName: 'PermissionRequest' }))).toBe('none');
  });
});
