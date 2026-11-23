/**
 * Okno kontekstu z jsonl (`herdr/jsonl-usage.ts`).
 *
 * Testy jadą na fixture `transcript-usage.jsonl`, którego liczby są PRAWDZIWE (zrzut z sesji
 * tego repozytorium): 8 rosnących sum, granica kompakcji i jeden wpis po kompakcji. Dzięki temu
 * najważniejsza asercja pliku — „suma z naszego wzoru == `preTokens` granicy" — jest dowodem
 * na realnych danych, a nie na liczbach dobranych pod test.
 *
 * `compactMetadata.trigger` jest w fixture REKONSTRUKCJĄ (`auto` zamiast `manual`, patrz README
 * fixture'ów). Żadna granica kompakcji nie potwierdza limitu okna (nagłówek `jsonl-usage.ts`),
 * więc wynik tego pliku od triggera nie zależy. Wariant `manual` budujemy tu przez podmianę tego
 * jednego pola w linii z pliku, a nie przez wymyślony wpis.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compactPostTokensFrom, compactPreTokensFrom, createUsageTracker, usageFrom,
} from '../src/herdr/jsonl-usage.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'herdr', 'transcript-usage.jsonl');

const lines = (): string[] => readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l !== '');
const entries = (): unknown[] => lines().map((line) => JSON.parse(line) as unknown);

/** Ostatni wpis asystenta PRZED granicą kompakcji i sama granica. */
function aroundBoundary(): { lastAssistant: unknown; boundary: unknown } {
  const all = entries();
  const index = all.findIndex((entry) => compactPreTokensFrom(entry) !== null);
  return { lastAssistant: all[index - 1], boundary: all[index] };
}

// ---------------------------------------------------------------------------
// usageFrom
// ---------------------------------------------------------------------------

describe('usageFrom', () => {
  /**
   * NAJWAŻNIEJSZY TEST W MODULE.
   *
   * Wzór (`input + cache_read + cache_creation + output`) jest kontraktem z silnikiem, a nie
   * naszym wyborem. Gdyby brakowało w nim składnika, widget kontekstu pokazywałby zaniżone
   * zużycie i nigdy nie ostrzegłby przed kompakcją — a to jest jedyne ostrzeżenie, jakie
   * użytkownik telefonu dostaje przed utratą kontekstu.
   */
  it('suma zgadza się CO DO TOKENA z `preTokens` sąsiedniej granicy kompakcji', () => {
    const { lastAssistant, boundary } = aroundBoundary();
    expect(usageFrom(lastAssistant)).toBe(462_682);
    expect(compactPreTokensFrom(boundary)).toBe(462_682);
  });

  it('sumy rosną wzdłuż pliku, a po kompakcji spadają', () => {
    const sums = entries().map(usageFrom).filter((sum): sum is number => sum !== null);
    expect(sums.slice(0, 8)).toEqual([
      46_107, 158_824, 232_162, 313_571, 390_481, 397_225, 419_265, 462_682,
    ]);
    expect(sums.at(-1)).toBe(14_002);
  });

  it('wpis bez `usage` daje `null`, a nie 0', () => {
    expect(usageFrom({ type: 'user', message: { role: 'user', content: 'cześć' } })).toBeNull();
    expect(usageFrom({ type: 'assistant', message: { role: 'assistant' } })).toBeNull();
    expect(usageFrom(null)).toBeNull();
    expect(usageFrom('{}')).toBeNull();
  });

  it('brakujące składniki liczą się jako 0, ale obecny `usage` daje liczbę', () => {
    const entry = { type: 'assistant', message: { usage: { input_tokens: 7 } } };
    expect(usageFrom(entry)).toBe(7);
    expect(usageFrom({ type: 'assistant', message: { usage: {} } })).toBe(0);
  });

  it('śmieci w polach `usage` nie zatruwają sumy', () => {
    const entry = {
      type: 'assistant',
      message: { usage: { input_tokens: 'dużo', output_tokens: -5, cache_read_input_tokens: 3 } },
    };
    expect(usageFrom(entry)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// compactPostTokensFrom
// ---------------------------------------------------------------------------

describe('compactPostTokensFrom', () => {
  /**
   * NAJWAŻNIEJSZY TEST TEJ FUNKCJI — dowód, że `postTokens` wolno wstawić WPROST jako liczbę
   * tokenów okna. Gdyby to była inna jednostka (np. bez cache'u), widget po kompakcji
   * pokazywałby liczbę, której nikt nigdy nie potwierdzi.
   */
  it('`postTokens` granicy == suma PIERWSZEGO wpisu asystenta po niej', () => {
    const all = entries();
    const at = all.findIndex((entry) => compactPostTokensFrom(entry) !== null);
    expect(compactPostTokensFrom(all[at])).toBe(14_002);
    const after = all.slice(at + 1).map(usageFrom).find((sum) => sum !== null);
    expect(after).toBe(14_002);
  });

  /**
   * TEST OBOWIĄZKOWY (licznik po `/compact` nie może stać na wartości sprzed cięcia).
   *
   * Kompakcja nie potwierdza LIMITU — ale mówi, ile zostało w oknie, a to jedyne, co po
   * `/compact` zbija licznik przed następną odpowiedzią silnika.
   */
  it('`trigger: "manual"` daje liczbę tokenów po cięciu', () => {
    const boundary = aroundBoundary().boundary as { compactMetadata: { trigger: string } };
    const manual = {
      ...boundary,
      compactMetadata: { ...boundary.compactMetadata, trigger: 'manual' },
    };
    expect(compactPostTokensFrom(manual)).toBe(14_002);
  });

  /**
   * `preTokens` to nie „tyle mieści okno", tylko „tyle się w nim zmieściło" — przy KAŻDYM
   * triggerze. Przy `auto` to próg kompakcji, który jest ustawieniem, a nie rozmiarem okna.
   */
  it('`compactPreTokensFrom` bierze `preTokens` przy KAŻDYM triggerze', () => {
    const boundary = aroundBoundary().boundary as { compactMetadata: { trigger: string } };
    const manual = {
      ...boundary,
      compactMetadata: { ...boundary.compactMetadata, trigger: 'manual' },
    };
    expect(compactPreTokensFrom(manual)).toBe(462_682);
    expect(compactPreTokensFrom(boundary)).toBe(462_682);
    const bare = { type: 'system', subtype: 'compact_boundary' };
    expect(compactPreTokensFrom({ ...bare, compactMetadata: { preTokens: 0 } })).toBeNull();
    expect(compactPreTokensFrom({ ...bare, compactMetadata: { trigger: 'auto' } })).toBeNull();
    expect(compactPreTokensFrom({ type: 'system', subtype: 'turn_duration' })).toBeNull();
    expect(compactPreTokensFrom({ type: 'assistant', compactMetadata: { preTokens: 5 } }))
      .toBeNull();
  });

  it('zero jest liczbą, a brak pola i śmieci to `null`', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary' };
    expect(compactPostTokensFrom({ ...boundary, compactMetadata: { postTokens: 0 } })).toBe(0);
    expect(compactPostTokensFrom({ ...boundary, compactMetadata: {} })).toBeNull();
    expect(compactPostTokensFrom({ ...boundary, compactMetadata: { postTokens: '14k' } }))
      .toBeNull();
    expect(compactPostTokensFrom({ type: 'assistant', compactMetadata: { postTokens: 5 } }))
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createUsageTracker
// ---------------------------------------------------------------------------

describe('createUsageTracker', () => {
  /**
   * TEST OBOWIĄZKOWY — to jest cała poprawka wobec v1 planu.
   *
   * Sesja może mieć 400k tokenów i nadal nie wiadomo, czy to 92 % okna 200k (niemożliwe),
   * czy 40 % okna 1M. Dopóki nikt tego nie potwierdził, pokazujemy liczbę, nie procent.
   */
  it('bez potwierdzenia stan zostaje `unknown` nawet przy 400k tokenów', () => {
    const tracker = createUsageTracker();
    for (const entry of entries()) {
      const sum = usageFrom(entry);
      if (sum !== null) expect(tracker.note(sum).kind).toBe('unknown');
    }
    // `atLeast` to NIE limit: `kind` zostaje `unknown`, a liczba mówi tylko „tyle uniosła".
    expect(tracker.state()).toEqual({ kind: 'unknown', tokens: 14_002, atLeast: 462_682 });
  });

  /**
   * TEST OBOWIĄZKOWY (panel Opusa po `/compact` z nieznanym limitem okna).
   *
   * Sesja, która UNIOSŁA 744k tokenów, nie ma okna 200k — i to jest jedyna rzecz, jaką plik
   * mówi o rozmiarze okna, gdy modelu nie ma w tabeli, a wszystkie kompakcje były ręczne.
   * Dolna granica NIE MALEJE przy cięciu: po nim tokenów jest kilkanaście tysięcy, ale wiedza
   * o pojemności zostaje — inaczej UI wracałoby do najmniejszego progu drabinki.
   */
  it('dolna granica okna rośnie i przeżywa kompakcję', () => {
    const tracker = createUsageTracker();
    tracker.note(418_008);
    expect(tracker.state()).toEqual({ kind: 'unknown', tokens: 418_008, atLeast: 418_008 });
    tracker.noteFloor(744_448);
    tracker.note(10_117);
    expect(tracker.state()).toEqual({ kind: 'unknown', tokens: 10_117, atLeast: 744_448 });
    // Mniejsza granica niczego nie cofa, a śmieci nie ruszają stanu.
    tracker.noteFloor(1_000);
    tracker.noteFloor(Number.NaN);
    expect(tracker.state()).toEqual({ kind: 'unknown', tokens: 10_117, atLeast: 744_448 });
  });

  /**
   * TEST OBOWIĄZKOWY. `statusline` to liczba, którą silnik podaje O SOBIE — nie
   * pomiar i nie założenie, tylko odpowiedź. Dlatego bije tabelę modelu, także W DÓŁ: sesja
   * przełączona `/model` na wariant 200k naprawdę ma mniejsze okno niż minutę temu.
   */
  it('odpowiedź silnika bije tabelę modelu, w obie strony', () => {
    const tracker = createUsageTracker(200_000);
    tracker.confirmLimit(1_000_000, 'model');
    expect(tracker.state()).toMatchObject({ limit: 1_000_000, source: 'model' });

    // W dół: to jedyne źródło, któremu na to pozwalamy.
    tracker.confirmLimit(200_000, 'statusline');
    expect(tracker.state()).toMatchObject({ limit: 200_000, source: 'statusline' });

    // …i nic go już nie rusza poza nowszym odczytem stamtąd.
    tracker.confirmLimit(1_000_000, 'model');
    expect(tracker.state()).toMatchObject({ limit: 200_000, source: 'statusline' });
    tracker.confirmLimit(1_000_000, 'statusline');
    expect(tracker.state()).toMatchObject({ limit: 1_000_000, source: 'statusline' });
  });

  it('po POTWIERDZENIU limitu dolna granica znika ze stanu — nie ma już czego zgadywać', () => {
    const tracker = createUsageTracker();
    tracker.note(418_008);
    tracker.confirmLimit(1_000_000, 'statusline');
    expect(tracker.state()).toEqual({
      kind: 'known', tokens: 418_008, limit: 1_000_000, source: 'statusline',
    });
  });

  /**
   * TEST OBOWIĄZKOWY (apka nie może pokazać 94 %, gdy CLI pokazuje 34 %). Auto-granica przy 462 682
   * to próg kompakcji, nie okno: limit z tabeli modelu (`claude-fable-5` = 1M) zostaje.
   */
  it('cały plik po kolei: granica nie rusza limitu z modelu, a kompakcja zbija tokeny', () => {
    const tracker = createUsageTracker(1_000_000);
    for (const entry of entries()) {
      const sum = usageFrom(entry);
      if (sum !== null) tracker.note(sum);
      const pre = compactPreTokensFrom(entry);
      if (pre !== null) tracker.noteFloor(pre);
    }
    expect(tracker.state()).toEqual({
      kind: 'known', tokens: 14_002, limit: 1_000_000, source: 'model',
    });
  });

  it('limit z modelu podanego przez Raroga jest znany od pierwszej sumy', () => {
    const tracker = createUsageTracker(200_000);
    expect(tracker.note(1_000)).toEqual({
      kind: 'known', tokens: 1_000, limit: 200_000, source: 'model',
    });
  });

  it('limit z tabeli modelu nie maleje, tokeny mogą', () => {
    const tracker = createUsageTracker(1_000_000);
    tracker.confirmLimit(200_000, 'model');
    tracker.note(9_000);
    expect(tracker.state()).toEqual({
      kind: 'known', tokens: 9_000, limit: 1_000_000, source: 'model',
    });
  });

  it('dolna granica z kompakcji nie obniża limitu z tabeli modelu', () => {
    const tracker = createUsageTracker(1_000_000);
    tracker.noteFloor(400_000);
    tracker.note(12_000);
    expect(tracker.state()).toEqual({
      kind: 'known', tokens: 12_000, limit: 1_000_000, source: 'model',
    });
  });

  it('dolna granica nie czyni limitu znanym, model z tabeli tak', () => {
    const tracker = createUsageTracker();
    tracker.noteFloor(400_000);
    tracker.note(12_000);
    expect(tracker.state()).toEqual({ kind: 'unknown', tokens: 12_000, atLeast: 400_000 });
    tracker.confirmLimit(1_000_000, 'model');
    expect(tracker.state()).toEqual({
      kind: 'known', tokens: 12_000, limit: 1_000_000, source: 'model',
    });
  });

  it('potwierdzenie śmieciem nie zmienia stanu', () => {
    const tracker = createUsageTracker();
    tracker.confirmLimit(Number.NaN, 'statusline');
    tracker.confirmLimit(0, 'model');
    expect(tracker.note(5).kind).toBe('unknown');
  });
});
