/**
 * Allow-lista klawiszy: DOKŁADNIE `escape`, `ctrl+c` i cyfry `1`…`9`.
 *
 * Test istnieje po to, żeby rozszerzenie listy było świadomą decyzją z osobnym commitem,
 * a nie skutkiem ubocznym „szybkiej poprawki" w driverze. Cyfry weszły razem z parserem ekranu
 * (`screen.resolveOptions`), który nadaje im znaczenie; `up`, `down` i `enter` NIE weszły
 * i nie wejdą, bo wybierają po POZYCJI — a numeracja opcji bywa przetasowana.
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_KEYS, HerdrKeyNotAllowedError, assertAllowedKeys } from '../src/herdr/dialogs/send/keys.ts';

describe('ALLOWED_KEYS', () => {
  it('zawiera dokładnie `escape`, `ctrl+c` i cyfry 1–9', () => {
    expect([...ALLOWED_KEYS].sort()).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', 'ctrl+c', 'escape',
    ]);
  });

  it('przepuszcza każdy klawisz z listy pojedynczo i razem', () => {
    for (const key of ALLOWED_KEYS) {
      expect(() => assertAllowedKeys([key])).not.toThrow();
    }
    expect(() => assertAllowedKeys(['escape', 'escape'])).not.toThrow();
  });

  it('każda cyfra ścieżki decyzji przechodzi osobno', () => {
    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(() => assertAllowedKeys([digit])).not.toThrow();
    }
  });
});

describe('assertAllowedKeys — odrzucenia', () => {
  const REJECTED: readonly string[] = [
    // Cykluje tryby uprawnień CAŁEJ sesji użytkownika — na WSPÓLNEJ liście nigdy;
    // ma osobną, jednoelementową ścieżkę (`mode-cycle.ts`), jak `enter` dla formularzy.
    'shift+tab',
    // Globalny schowek macOS, wyścig przy dwóch wysyłkach naraz.
    'ctrl+v',
    // Wybór po POZYCJI — cyfra idzie wyłącznie po TEKŚCIE opcji. Cyfra wybiera i zatwierdza
    // w jednym kroku, więc żaden moduł tego planu tych trzech nie potrzebuje.
    'enter', 'up', 'down',
    // Clears a screen line of the prompt field: only the queue take-back sends it, on its own path.
    'ctrl+u',
    // CLI numeruje opcje od 1; `0` nie ma po co być na liście.
    '0',
    // Cyfra owszem, ale nie SEKWENCJA cyfr ani cyfra z ogonem.
    '10', '1 ', '1.',
    'q', '', 'Escape', 'ESCAPE', 'ctrl+C',
    // Próba przemycenia komendy w polu klawisza.
    'ctrl+c; rm -rf /',
  ];

  for (const key of REJECTED) {
    it(`odrzuca ${JSON.stringify(key)}`, () => {
      expect(() => assertAllowedKeys([key])).toThrow(HerdrKeyNotAllowedError);
    });
  }

  it('odrzuca CAŁĄ tablicę, gdy zły jest dopiero ostatni element', () => {
    // Wysłanie poprawnego prefiksu zostawiłoby cudzy panel w stanie w połowie sekwencji.
    expect(() => assertAllowedKeys(['escape', 'escape', 'enter'])).toThrow(HerdrKeyNotAllowedError);
  });

  it('odrzuca pustą tablicę', () => {
    expect(() => assertAllowedKeys([])).toThrow(HerdrKeyNotAllowedError);
  });

  it('błąd ma kod `bad-request` (router → 400, nie 500)', () => {
    try {
      assertAllowedKeys(['enter']);
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as HerdrKeyNotAllowedError).code).toBe('bad-request');
      expect((err as Error).message).toContain('enter');
    }
  });
});

describe('regresja — nawigacja po POZYCJI zostaje poza listą', () => {
  it('ALLOWED_KEYS NIE urosła o klawisze nawigacji', () => {
    // `up`/`down`/`enter` na kanale AGENTA znaczyłyby wybór opcji po POZYCJI w cudzym
    // dialogu zgody, wprost przeciw regule cyfry po tekście. Lista jest zamknięta i rośnie tylko decyzją.
    for (const key of ['up', 'down', 'enter', 'left', 'right', 'tab', 'backspace']) {
      expect(ALLOWED_KEYS.has(key), key).toBe(false);
      expect(() => assertAllowedKeys([key])).toThrow(HerdrKeyNotAllowedError);
    }
  });
});
