/**
 * Kontrakt ramek terminala PTY — jedyne źródło prawdy dla serwera i klienta.
 *
 * Testujemy tu granice, a nie „czy zod działa": ramka spoza kontraktu ma być ODRZUCONA,
 * bo po drugiej stronie stoi pełna powłoka użytkownika.
 */
import { describe, expect, it } from 'vitest';
import {
  isPopupRole, TERM_ID_LENGTH, TERM_ID_RE, TERM_MAX_INPUT_BYTES, TERM_MAX_PASTE_BYTES,
  TERM_PROC_MAX_LENGTH, TERM_ROLES,
  TERM_SLOTS_MAX, termClientFrameSchema, termListResponseSchema, termOpenBodySchema,
  termOpenResponseSchema, termServerFrameSchema,
} from '../src/protocol.ts';

describe('identyfikator terminala', () => {
  it('wzorzec przyjmuje wyłącznie 16 znaków hex', () => {
    expect(TERM_ID_LENGTH).toBe(16);
    expect(TERM_ID_RE.test('0123456789abcdef')).toBe(true);
    expect(TERM_ID_RE.test('0123456789ABCDEF')).toBe(false);
    expect(TERM_ID_RE.test('0123456789abcde')).toBe(false);
    // Id wchodzi do nazwy sesji tmux podawanej jako argument `execFile`.
    expect(TERM_ID_RE.test('../../etc/passw')).toBe(false);
  });

  /*
   * `slot` w ODPOWIEDZI jest wymagany, bo przy `slot: 'next'` klient go nie zna — numer wybiera
   * serwer. Id zostaje w tym samym kształcie (16 hex) dla wszystkich slotów: wchodzi do trasy
   * `#/terminal/<id>` i do tokenu panelu herdr, więc sufiks `#N` należy do WEJŚCIA hasha,
   * nigdy do jego wyniku.
   */
  it('odpowiedź POST /api/term niesie id, numer slotu i rolę', () => {
    const id = '0123456789abcdef';
    expect(termOpenResponseSchema.safeParse({ id, slot: 1, role: 'shell' }).success).toBe(true);
    expect(termOpenResponseSchema.safeParse({ id, slot: 1 }).success).toBe(false);
    expect(termOpenResponseSchema.safeParse({ id: 'krótkie', slot: 1, role: 'shell' }).success)
      .toBe(false);
    expect(
      termOpenResponseSchema.safeParse({ id, slot: TERM_SLOTS_MAX + 1, role: 'shell' }).success,
    ).toBe(false);
  });
});

describe('ciało POST /api/term', () => {
  it('wymaga niepustego cwd', () => {
    expect(termOpenBodySchema.safeParse({ cwd: '/Users/x/Projects/p' }).success).toBe(true);
    expect(termOpenBodySchema.safeParse({ cwd: '' }).success).toBe(false);
    expect(termOpenBodySchema.safeParse({}).success).toBe(false);
  });

  /*
   * ZGODNOŚĆ WSTECZ jest tu kontraktem, a nie uprzejmością: bundle sprzed deployu wysyła samo
   * `{cwd}` i musi trafić w slot 1, czyli w terminal, który projekt miał dotąd.
   */
  it('`slot` jest OPCJONALNY — gołe `{cwd}` przechodzi', () => {
    const parsed = termOpenBodySchema.safeParse({ cwd: '/Users/x/Projects/p' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.slot).toBeUndefined();
  });

  it('przyjmuje numer z zakresu 1…TERM_SLOTS_MAX oraz literał `next`', () => {
    const cwd = '/Users/x/Projects/p';
    expect(termOpenBodySchema.safeParse({ cwd, slot: 1 }).success).toBe(true);
    expect(termOpenBodySchema.safeParse({ cwd, slot: TERM_SLOTS_MAX }).success).toBe(true);
    expect(termOpenBodySchema.safeParse({ cwd, slot: 'next' }).success).toBe(true);
  });

  it('odrzuca numer spoza zakresu, ułamek i inne słowo', () => {
    const cwd = '/Users/x/Projects/p';
    expect(termOpenBodySchema.safeParse({ cwd, slot: 0 }).success).toBe(false);
    expect(termOpenBodySchema.safeParse({ cwd, slot: TERM_SLOTS_MAX + 1 }).success).toBe(false);
    expect(termOpenBodySchema.safeParse({ cwd, slot: 1.5 }).success).toBe(false);
    expect(termOpenBodySchema.safeParse({ cwd, slot: 'ostatni' }).success).toBe(false);
  });
});

describe('odpowiedź GET /api/term', () => {
  const entry = {
    id: '0123456789abcdef', cwd: '/Users/x/Projects/p', live: true, role: 'shell',
  };

  it('wymaga `slot`, `proc` i `role` przy każdym wpisie', () => {
    expect(termListResponseSchema.safeParse({
      terminals: [{ ...entry, slot: 2, proc: 'nvim' }],
    }).success).toBe(true);
    expect(termListResponseSchema.safeParse({ terminals: [entry] }).success).toBe(false);
    const { role: _bezRoli, ...bezRoli } = entry;
    expect(termListResponseSchema.safeParse({
      terminals: [{ ...bezRoli, slot: 2, proc: 'nvim' }],
    }).success).toBe(false);
  });

  /*
   * Pusty `proc` jest LEGALNY i znaczy „backend jeszcze nie wie" — pierwsza lista po starcie
   * serwera wygląda właśnie tak, a klient rysuje wtedy samą pigułkę `>_`.
   */
  it('pusty `proc` przechodzi, a zbyt długi nie', () => {
    expect(termListResponseSchema.safeParse({
      terminals: [{ ...entry, slot: 1, proc: '' }],
    }).success).toBe(true);
    expect(termListResponseSchema.safeParse({
      terminals: [{ ...entry, slot: 1, proc: 'x'.repeat(TERM_PROC_MAX_LENGTH + 1) }],
    }).success).toBe(false);
  });
});

describe('ramki klient → serwer', () => {
  it('przyjmuje wejście i zmianę rozmiaru', () => {
    expect(termClientFrameSchema.safeParse({ t: 'in', d: 'ls\r' }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'rs', c: 120, r: 40 }).success).toBe(true);
  });

  it('odrzuca nieznany typ i braki pól', () => {
    expect(termClientFrameSchema.safeParse({ t: 'kill' }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'in' }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'rs', c: 120 }).success).toBe(false);
  });

  it('rozmiar musi być dodatnią liczbą całkowitą w rozsądnym zakresie', () => {
    expect(termClientFrameSchema.safeParse({ t: 'rs', c: 0, r: 40 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'rs', c: 80.5, r: 40 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'rs', c: 100_000, r: 40 }).success).toBe(false);
  });

  /*
   * `sc` (przewinięcie) istnieje dla backendu herdr, w którym historia powłoki żyje w panelu.
   * Limit jest W ZODZIE, jak przy `rs`: ramka spoza zakresu ma się NIE sparsować, żeby `ws.ts`
   * zamknął gniazdo istniejącą ścieżką (1002), zamiast przepuszczać liczbę do przycięcia.
   */
  it('przewinięcie `sc` przyjmuje liczbę całkowitą wierszy ze znakiem, w limicie ±200', () => {
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: -3 }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 200 }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 0 }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 201 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: -201 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 1.5 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'sc' }).success).toBe(false);
  });

  /*
   * Komórka pod palcem: herdr kieruje kółko do panelu aplikacji pod `c`/`r`
   * (lazygit: diff vs lista). Opcjonalna — ramka bez adresu przewija zwykłą powłokę — ale gdy
   * jest, obowiązują limity siatki jak przy `rs` (1..1000, całkowite).
   */
  it('przewinięcie `sc` przyjmuje opcjonalną komórkę pod palcem w limitach siatki', () => {
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 3, c: 75, r: 10 }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 3, c: 1, r: 1000 }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 3, c: 0, r: 10 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 3, c: 75, r: 1001 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'sc', d: 3, c: 7.5, r: 10 }).success).toBe(false);
  });

  /*
   * `pa` — kawałek WKLEJKI. Klient oznacza wklejkę jako wklejkę, a serwer
   * skleja kawałki i oddaje herdr JEDNO `terminal.input` z treścią `ESC[200~…ESC[201~` — herdr
   * dopasowuje ją do trybu programu w panelu. `e` jest WYMAGANE i jawne w każdej ramce: koniec
   * wklejki nie może wynikać z braku pola, bo ramka bez znacznika to dla serwera „czekaj na
   * resztę", a nie „wklej".
   */
  it('wklejka `pa` niesie kawałek tekstu i jawny znacznik końca `e`', () => {
    expect(termClientFrameSchema.safeParse({ t: 'pa', d: 'raz\ndwa\n', e: false }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'pa', d: 'trzy', e: true }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'pa', d: '', e: true }).success).toBe(true);
    expect(termClientFrameSchema.safeParse({ t: 'pa', d: 'x' }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'pa', e: true }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'pa', d: 'x', e: 1 }).success).toBe(false);
    expect(termClientFrameSchema.safeParse({ t: 'pa', d: 7, e: true }).success).toBe(false);
  });

  /*
   * Sufit CAŁEJ wklejki: herdr 0.9.3 gubi PO CICHU wejście ponad 1 MiB (`MAX_INPUT_PAYLOAD`),
   * więc Rarog trzyma się połowy — z zapasem na owinięcie i na kopertę NDJSON kontrolera.
   */
  it('sufit wklejki to 512 kB treści, a każda ramka `pa` mieści się w limicie wejścia', () => {
    expect(TERM_MAX_PASTE_BYTES).toBe(512 * 1024);
    expect(TERM_MAX_PASTE_BYTES * 2).toBeLessThanOrEqual(1024 * 1024);
    expect(TERM_MAX_INPUT_BYTES).toBe(8 * 1024);
  });
});

describe('ramki serwer → klient (tekstowe)', () => {
  it('to `hello`, `exit` i `err`; bajty PTY jadą ramką binarną', () => {
    expect(termServerFrameSchema.safeParse({ t: 'exit' }).success).toBe(true);
    expect(termServerFrameSchema.safeParse({ t: 'err', msg: 'nie wstaje' }).success).toBe(true);
    expect(termServerFrameSchema.safeParse({ t: 'err' }).success).toBe(false);
    expect(termServerFrameSchema.safeParse({ t: 'out', d: 'x' }).success).toBe(false);
  });

  /*
   * `hello` niesie wartość STAŁĄ: backend jest jeden (panel herdr), więc schemat ma
   * literał, a nie unię — opisuje to, co naprawdę leci drutem. Ramka zostaje w kontrakcie dla
   * starszego klienta, dla którego BRAK `hello` znaczy „tmux".
   */
  it('`hello` niesie DOKŁADNIE `herdr` — backend jest jeden', () => {
    expect(termServerFrameSchema.safeParse({ t: 'hello', backend: 'herdr' }).success).toBe(true);
    expect(termServerFrameSchema.safeParse({ t: 'hello', backend: 'tmux' }).success).toBe(false);
    expect(termServerFrameSchema.safeParse({ t: 'hello' }).success).toBe(false);
  });
});

/*
 * ROLA terminala. Panele popupowe (`lazygit`, `popup`) są OSOBNYMI bytami obok
 * tabów projektu: nie mają slotu (`0` w odpowiedzi i na liście), a rola musi jechać
 * w kontrakcie, bo to ona rozstrzyga tożsamość panelu po stronie serwera (`termIdFor` z rolą)
 * i etykietę taba w herdr.
 */
describe('role panelu: shell, lazygit i popup', () => {
  const cwd = '/Users/x/Projects/p';

  it('są dokładnie trzy role, a brak roli w ciele znaczy `shell`', () => {
    expect([...TERM_ROLES]).toEqual(['shell', 'lazygit', 'popup']);
    const parsed = termOpenBodySchema.safeParse({ cwd });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.role).toBeUndefined();
    expect(termOpenBodySchema.safeParse({ cwd, role: 'htop' }).success).toBe(false);
  });

  /*
   * „Poza slotami" to JEDNO pytanie, od którego zależy pięć decyzji serwera (materiał id,
   * `slot: 0`, zakaz slotu w ciele, odnajdywanie wpisu, kasowanie zamiast `failed`). Gdyby
   * każda z nich pytała osobno o `role === 'lazygit'`, dodanie roli `popup` wymagałoby
   * znalezienia wszystkich pięciu.
   */
  it('`isPopupRole` obejmuje obie role popupowe i tylko je', () => {
    expect(isPopupRole('lazygit')).toBe(true);
    expect(isPopupRole('popup')).toBe(true);
    expect(isPopupRole('shell')).toBe(false);
  });

  /*
   * `slot` przy roli popupowej jest ZABRONIONY, a nie ignorowany: cicho pominięty numer kazałby
   * klientowi wierzyć, że dostał tab, o który prosił.
   */
  it.each(['lazygit', 'popup'])('przy `role: %s` slot jest zabroniony', (role) => {
    expect(termOpenBodySchema.safeParse({ cwd, role }).success).toBe(true);
    expect(termOpenBodySchema.safeParse({ cwd, role, slot: 1 }).success).toBe(false);
    expect(termOpenBodySchema.safeParse({ cwd, role, slot: 'next' }).success).toBe(false);
  });

  it('przy `shell` slot jest normalny', () => {
    expect(termOpenBodySchema.safeParse({ cwd, role: 'shell', slot: TERM_SLOTS_MAX }).success)
      .toBe(true);
  });

  it.each(['lazygit', 'popup'])(
    '`slot: 0` jest LEGALNY i należy do roli %s — w odpowiedzi i na liście',
    (role) => {
      const id = '0123456789abcdef';
      expect(termOpenResponseSchema.safeParse({ id, slot: 0, role }).success).toBe(true);
      expect(termListResponseSchema.safeParse({
        terminals: [{ id, cwd, live: true, slot: 0, proc: 'zsh', role }],
      }).success).toBe(true);
    },
  );
});
