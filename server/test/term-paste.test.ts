/**
 * Wklejka jedną ramką — czyste składanie i czyszczenie po stronie serwera.
 *
 * Po drugiej stronie stoi pełna powłoka, więc test pilnuje przede wszystkim jednej granicy:
 * treść ze schowka NIE MA prawa zamknąć wklejki przed czasem. Znacznik końca `ESC[201~`
 * w treści owiniętej wklejki to dla zsh „koniec wklejki", a wszystko po nim — zwykłe klawisze:
 * `ESC[201~rm -rf ~\r` w schowku wykonałby komendę. Drugi warunek pochodzi z herdr 0.9.3
 * (`complete_text_bracketed_paste`): wejście jest wklejką tylko wtedy, gdy zaczyna się od
 * `ESC[200~`, a PIERWSZY znacznik końca kończy dane — inaczej herdr wpisuje bajty surowo.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PASTE_END, PASTE_START, PasteAssembler, cleanPasteText, wrapPaste,
} from '../src/term/paste.ts';

/** Lustro `complete_text_bracketed_paste` z herdr 0.9.3 (`src/raw_input.rs`) na bajtach. */
function herdrSeesOnePaste(input: string): boolean {
  const data = Buffer.from(input, 'utf8');
  const start = Buffer.from(PASTE_START, 'utf8');
  const end = Buffer.from(PASTE_END, 'utf8');
  if (!data.subarray(0, start.length).equals(start)) return false;
  const at = data.indexOf(end);
  if (at < 0 || at + end.length !== data.length) return false;
  const inner = data.subarray(start.length, at);
  return Buffer.from(inner.toString('utf8'), 'utf8').equals(inner);
}

describe('cleanPasteText — treść nie zamyka wklejki przed czasem', () => {
  it('usuwa znacznik końca z treści — `ESC[201~rm …` nie wykonuje komendy', () => {
    const evil = `${PASTE_END}rm -rf ~/x\r`;
    expect(cleanPasteText(evil)).toBe('rm -rf ~/x\r');
    expect(cleanPasteText(evil)).not.toContain(PASTE_END);
  });

  it('usuwa też znacznik początku (zagnieżdżona wklejka w schowku)', () => {
    expect(cleanPasteText(`a${PASTE_START}b${PASTE_END}c`)).toBe('abc');
  });

  /*
   * Jedno przejście `replace` nie wystarcza: wycięcie wewnętrznego znacznika skleja zewnętrzny.
   * `ESC[20` + `ESC[201~` + `1~` po jednym przejściu daje świeże `ESC[201~`.
   */
  it('czyści do skutku — znacznik sklejony z kawałków po wycięciu też znika', () => {
    const nested = `\u001b[20${PASTE_END}1~echo pwned\r`;
    expect(cleanPasteText(nested)).toBe('echo pwned\r');
    const deeper = `\u001b[20\u001b[20${PASTE_END}1~1~x`;
    expect(cleanPasteText(deeper)).toBe('x');
  });

  /*
   * Pętla `replace` do skutku usuwała JEDEN zagnieżdżony znacznik na
   * przebieg — wklejka w granicach sufitu (`ESC[20` × N + `ESC[201~` + `1~` × N, ~512 kB)
   * kosztowała N przebiegów po całym tekście, ~15 s zablokowanej pętli zdarzeń serwera.
   * Czyszczenie ma być liniowe; próg czasu jest o rząd wielkości ponad liniowym kosztem
   * i o rząd poniżej kwadratowego, żeby obciążona maszyna nie dawała fałszywych porażek.
   */
  it('głęboko zagnieżdżone znaczniki na suficie czyści liniowo, bez blokowania serwera', () => {
    const depth = 87_379;
    const nested = `${'\u001b[20'.repeat(depth)}${PASTE_END}${'1~'.repeat(depth)}ok`;
    expect(Buffer.byteLength(nested, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    const started = performance.now();
    expect(cleanPasteText(nested)).toBe('ok');
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('usuwa 8-bitowy CSI (U+009B) w tej samej roli', () => {
    expect(cleanPasteText('a\u009b201~b\u009b200~c')).toBe('abc');
  });

  /*
   * Końce linii jak xterm.js (`prepareTextForTerminal`) i terminale natywne: Enter to `\r`.
   * herdr 0.9.3 niczego tu nie zmienia (`prepare_paste_text_for_pty` poza Windows to tożsamość),
   * a program bez 2004 w trybie kanonicznym i tak dostaje `\n` z ICRNL tty.
   */
  it('końce linii zamienia na `\\r` (CRLF i LF), samotne `\\r` zostaje', () => {
    expect(cleanPasteText('raz\r\ndwa\ntrzy\rcztery')).toBe('raz\rdwa\rtrzy\rcztery');
  });

  /*
   * Samotny surogat przeżywa `JSON.stringify` jako `\udXXX`, a NDJSON kontrolera herdr
   * (serde) takiej ucieczki nie przyjmie — wklejka przepadłaby w całości. Zamiana na U+FFFD
   * jest tym, co i tak zrobiłby dekoder UTF-8.
   */
  it('samotne surogaty zamienia na U+FFFD, pary zostawia', () => {
    expect(cleanPasteText('a\ud800b')).toBe('a\ufffdb');
    expect(cleanPasteText('a\udc00b')).toBe('a\ufffdb');
    expect(cleanPasteText('😀')).toBe('😀');
  });

  it('dowolna treść po owinięciu to DOKŁADNIE jedna wklejka w oczach herdr', () => {
    const piece = fc.constantFrom(
      '\u001b', '[', '2', '0', '1', '~', '\u009b', '\r', '\n', 'a', 'ż', '😀', '\ud800', '\udc00',
      PASTE_START, PASTE_END,
    );
    fc.assert(fc.property(fc.array(piece, { maxLength: 40 }), (parts) => {
      const cleaned = cleanPasteText(parts.join(''));
      expect(cleaned).not.toContain(PASTE_START);
      expect(cleaned).not.toContain(PASTE_END);
      expect(cleaned).not.toMatch(/\u009b20[01]~/);
      expect(cleaned).not.toContain('\n');
      expect(herdrSeesOnePaste(wrapPaste(cleaned))).toBe(true);
    }), { numRuns: 2000 });
  });
});

describe('PasteAssembler — składanie kawałków jednego gniazda', () => {
  it('kawałki sklejają się w JEDNO owinięte wejście dopiero przy znaczniku końca', () => {
    const paste = new PasteAssembler(1024);
    expect(paste.push('raz\n', false)).toEqual({ kind: 'pending' });
    expect(paste.push('dwa\n', false)).toEqual({ kind: 'pending' });
    expect(paste.push('trzy', true)).toEqual({ kind: 'ready', input: `${PASTE_START}raz\rdwa\rtrzy${PASTE_END}` });
  });

  it('znacznik rozcięty między ramkami też jest czyszczony (czyszczenie na całości)', () => {
    const paste = new PasteAssembler(1024);
    paste.push('ok\u001b[20', false);
    const step = paste.push('1~rm -rf ~/x\r', true);
    expect(step).toEqual({ kind: 'ready', input: `${PASTE_START}okrm -rf ~/x\r${PASTE_END}` });
    if (step.kind === 'ready') expect(herdrSeesOnePaste(step.input)).toBe(true);
  });

  it('pusta wklejka (także pusta po czyszczeniu) nie daje wejścia', () => {
    const paste = new PasteAssembler(1024);
    expect(paste.push('', true)).toEqual({ kind: 'empty' });
    expect(paste.push(PASTE_END, true)).toEqual({ kind: 'empty' });
  });

  it('sufit jest włącznie: dokładnie `max` bajtów przechodzi', () => {
    const paste = new PasteAssembler(8);
    expect(paste.push('ąąąą', true)).toEqual({ kind: 'ready', input: `${PASTE_START}ąąąą${PASTE_END}` });
  });

  /*
   * Nadmiar idzie do kosza W CAŁOŚCI, razem z resztą tej wklejki: ogon zaczęty od nowa byłby
   * drugą, częściową wklejką — a wklejka ma dojść cała albo wcale.
   */
  it('ponad sufit: jeden `overflow`, reszta tej wklejki do kosza, następna działa', () => {
    const paste = new PasteAssembler(8);
    expect(paste.push('12345', false)).toEqual({ kind: 'pending' });
    expect(paste.push('6789', false)).toEqual({ kind: 'overflow', bytes: 9 });
    expect(paste.push('ogon', false)).toEqual({ kind: 'dropped' });
    expect(paste.push('koniec', true)).toEqual({ kind: 'dropped' });
    expect(paste.push('nowa', true)).toEqual({ kind: 'ready', input: `${PASTE_START}nowa${PASTE_END}` });
  });

  it('nadmiar w ostatnim kawałku kończy wklejkę od razu', () => {
    const paste = new PasteAssembler(4);
    expect(paste.push('12345', true)).toEqual({ kind: 'overflow', bytes: 5 });
    expect(paste.push('ok', true)).toEqual({ kind: 'ready', input: `${PASTE_START}ok${PASTE_END}` });
  });

  it('`in` w środku wklejki: bufor do kosza, reszta tej wklejki też, nigdy połowa', () => {
    const paste = new PasteAssembler(1024);
    paste.push('echo raz\n', false);
    expect(paste.interrupt()).toBe(true);
    expect(paste.push('echo dwa\n', false)).toEqual({ kind: 'dropped' });
    expect(paste.interrupt()).toBe(false);
    expect(paste.push('echo trzy', true)).toEqual({ kind: 'dropped' });
    expect(paste.push('cała', true)).toEqual({ kind: 'ready', input: `${PASTE_START}cała${PASTE_END}` });
  });

  /*
   * Pusty kawałek nie podnosił licznika bajtów, ale dopisywał element
   * do bufora — seria `{d:'', e:false}` rosła bez sufitu. Test zagląda do pola prywatnego, bo
   * pamięci nie da się zmierzyć zachowaniem; liczy się to, że bufor rośnie wyłącznie z bajtami.
   */
  it('puste kawałki nie rosną w buforze, a wklejka z nich dalej daje się przerwać', () => {
    const paste = new PasteAssembler(1024);
    for (let i = 0; i < 10_000; i += 1) expect(paste.push('', false)).toEqual({ kind: 'pending' });
    expect((paste as unknown as { parts: unknown[] }).parts.length).toBe(0);
    expect(paste.interrupt()).toBe(true);
    expect(paste.push('ogon', true)).toEqual({ kind: 'dropped' });
    expect(paste.push('', false)).toEqual({ kind: 'pending' });
    expect(paste.push('x', true)).toEqual({ kind: 'ready', input: `${PASTE_START}x${PASTE_END}` });
  });

  it('`in` poza wklejką niczego nie przerywa', () => {
    const paste = new PasteAssembler(1024);
    expect(paste.interrupt()).toBe(false);
    expect(paste.push('x', true)).toEqual({ kind: 'ready', input: `${PASTE_START}x${PASTE_END}` });
  });
});
