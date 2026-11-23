/**
 * Obecność (`notify/presence.ts`) — bramka, przez którą przechodzą albo nie przechodzą pushe.
 *
 * Zegar jest wstrzykiwany, bo cały moduł jest o CZASIE: „obecny" znaczy „potwierdził niedawno",
 * a nie „kiedyś się zgłosił". Testy postarzają wpisy o sekundy zamiast czekać.
 */
import { describe, expect, it } from 'vitest';
import { PRESENCE_GRACE_MS, PRESENCE_TTL_MS, Presence } from '../src/notify/presence.ts';
import { HEARTBEAT_MS } from '../src/sse.ts';

const setup = (): { presence: Presence; tick: (ms: number) => void } => {
  let now = 1_000_000;
  const presence = new Presence({ now: () => now });
  return { presence, tick: (ms: number): void => { now += ms; } };
};

describe('obecność — czy ktoś patrzy w Raroga', () => {
  it('brak zgłoszeń = NIEOBECNY (po restarcie serwera, przy starym kliencie)', () => {
    const { presence } = setup();
    // Asymetria świadoma: zgubione powiadomienie kosztuje realny czas, nadmiarowe — spojrzenie.
    expect(presence.active()).toBe(false);
  });

  it('widoczna apka = obecny', () => {
    const { presence } = setup();
    presence.note('a', { visible: true });
    expect(presence.active()).toBe(true);
  });

  it('zejście w tło gasi obecność NATYCHMIAST, bez czekania na TTL', () => {
    const { presence } = setup();
    presence.note('a', { visible: true });
    // `visibilitychange → hidden` to fakt, który znamy na pewno — nie ma po co go przeterminowywać.
    presence.note('a', { visible: false });
    expect(presence.active()).toBe(false);
  });

  /*
   * Sedno TTL: iOS usypia PWA w tle, a gniazdo SSE potrafi jeszcze chwilę wisieć. Klient, który
   * zamilkł, NIE jest dowodem na to, że ktoś patrzy — obecność trzeba potwierdzać.
   */
  it('klient, który zamilkł, przestaje się liczyć po TTL', () => {
    const { presence, tick } = setup();
    presence.note('a', { visible: true });
    tick(PRESENCE_TTL_MS - 1);
    expect(presence.active()).toBe(true);
    tick(2);
    expect(presence.active()).toBe(false);
  });

  /*
   * Klient odpowiada na heartbeat SSE, więc próg MUSI być od niego większy — inaczej obecność
   * migałaby między dwoma pingami na wolnym łączu i push wychodziłby do kogoś, kto patrzy.
   */
  it('TTL jest dłuższy niż odstęp heartbeatu, i to z zapasem', () => {
    expect(PRESENCE_TTL_MS).toBeGreaterThan(HEARTBEAT_MS);
  });

  it('jeden obecny klient wystarczy, choćby reszta była w tle', () => {
    const { presence } = setup();
    presence.note('telefon', { visible: false });
    presence.note('ipad', { visible: true });
    expect(presence.active()).toBe(true);
  });

  it('zamknięty strumień zabiera obecność razem z klientem', () => {
    const { presence } = setup();
    presence.note('a', { visible: true });
    presence.forget('a');
    expect(presence.active()).toBe(false);
  });
});

describe('obecność — na którą sesję patrzysz', () => {
  it('otwarty transkrypt tej sesji', () => {
    const { presence } = setup();
    presence.note('a', { visible: true, sessionId: 's1' });
    expect(presence.watching('s1')).toBe(true);
    expect(presence.watching('s2')).toBe(false);
  });

  it('apka w tle nie patrzy na nic, choćby trasa została na sesji', () => {
    const { presence } = setup();
    presence.note('a', { visible: false, sessionId: 's1' });
    expect(presence.watching('s1')).toBe(false);
  });

  it('lista sesji to nie jest patrzenie na żadną z nich', () => {
    const { presence } = setup();
    presence.note('a', { visible: true });
    expect(presence.active()).toBe(true);
    expect(presence.watching('s1')).toBe(false);
  });

  it('przeterminowany klient nie patrzy już na nic', () => {
    const { presence, tick } = setup();
    presence.note('a', { visible: true, sessionId: 's1' });
    tick(PRESENCE_TTL_MS + 1);
    expect(presence.watching('s1')).toBe(false);
  });
});

describe('rejestr nie przecieka', () => {
  /*
   * Identyfikator klienta nadaje strumień SSE, a iOS zrywa go przy KAŻDYM uśpieniu ekranu —
   * telefon otwiera go kilkadziesiąt razy dziennie. Bez sprzątania mapa rosłaby przez cały
   * czas życia procesu.
   */
  it('przeterminowane wpisy znikają przy kolejnym zgłoszeniu', () => {
    const { presence, tick } = setup();
    for (let i = 0; i < 5; i += 1) presence.note(`stary-${String(i)}`, { visible: true });
    tick(PRESENCE_TTL_MS + 1);
    presence.note('nowy', { visible: true });
    expect(presence.size).toBe(1);
  });

  it('sufit klientów obowiązuje także wtedy, gdy żaden nie zdążył się przeterminować', () => {
    let now = 1_000_000;
    const presence = new Presence({ now: () => now, maxClients: 3 });
    for (let i = 0; i < 10; i += 1) {
      now += 1;
      presence.note(`k-${String(i)}`, { visible: true });
    }
    expect(presence.size).toBe(3);
    // Zostaje NAJŚWIEŻSZY — czyli ten, który naprawdę patrzy.
    expect(presence.active()).toBe(true);
  });
});

describe('powrót obecności', () => {
  /*
   * Sygnał, na którym stoi reguła „powrót do Raroga kasuje wszystkie czekające wysyłki".
   * Musi być JEDNORAZOWY na przejście — odświeżenia
   * lecą co 20 s z każdego urządzenia i kasowałyby wszystko bez przerwy.
   */
  it('odpala się przy przejściu z ciszy w obecność', () => {
    let backs = 0;
    let now = 1_000_000;
    const presence = new Presence({ now: () => now, onActive: () => { backs += 1; } });

    presence.note('telefon', { visible: true });
    expect(backs).toBe(1);
  });

  it('odświeżenie obecności NIE jest powrotem', () => {
    let backs = 0;
    let now = 1_000_000;
    const presence = new Presence({ now: () => now, onActive: () => { backs += 1; } });

    presence.note('telefon', { visible: true });
    now += 5_000;
    presence.note('telefon', { visible: true });
    now += 5_000;
    presence.note('telefon', { visible: true, sessionId: 's1' });
    expect(backs).toBe(1);
  });

  it('zejście w tło i powrót to DRUGI powrót', () => {
    let backs = 0;
    let now = 1_000_000;
    const presence = new Presence({ now: () => now, onActive: () => { backs += 1; } });

    presence.note('telefon', { visible: true });
    presence.note('telefon', { visible: false });
    presence.note('telefon', { visible: true });
    expect(backs).toBe(2);
  });

  it('drugie urządzenie przy już otwartym Rarogu nie jest powrotem', () => {
    let backs = 0;
    let now = 1_000_000;
    const presence = new Presence({ now: () => now, onActive: () => { backs += 1; } });

    presence.note('ipad', { visible: true });
    presence.note('telefon', { visible: true });
    expect(backs).toBe(1);
  });

  it('powrót po wygaśnięciu TTL liczy się jako powrót', () => {
    let backs = 0;
    let now = 1_000_000;
    const presence = new Presence({ now: () => now, onActive: () => { backs += 1; } });

    presence.note('telefon', { visible: true });
    now += PRESENCE_TTL_MS + 1;
    presence.note('telefon', { visible: true });
    expect(backs).toBe(2);
  });
});

describe('karencja po wyjściu z Raroga', () => {
  it('bez zgłoszeń karencji nie ma', () => {
    const { presence } = setup();
    expect(presence.graceLeftMs()).toBe(0);
  });

  it('liczy się od chwili zejścia w tło, nie od ostatniego odświeżenia', () => {
    const { presence, tick } = setup();
    presence.note('ipad', { visible: true });
    tick(15_000);
    presence.note('ipad', { visible: false });
    expect(presence.graceLeftMs()).toBe(PRESENCE_GRACE_MS);
    tick(PRESENCE_GRACE_MS - 1);
    expect(presence.graceLeftMs()).toBe(1);
    tick(1);
    expect(presence.graceLeftMs()).toBe(0);
  });

  it('klient, który zamilkł, daje karencję od ostatniego potwierdzenia', () => {
    const { presence, tick } = setup();
    presence.note('ipad', { visible: true });
    tick(PRESENCE_TTL_MS + 1);
    expect(presence.active()).toBe(false);
    expect(presence.graceLeftMs()).toBe(PRESENCE_GRACE_MS - PRESENCE_TTL_MS - 1);
  });

  it('zamknięty strumień widocznego klienta liczy się jak zejście z ekranu', () => {
    const { presence, tick } = setup();
    presence.note('ipad', { visible: true });
    tick(10_000);
    presence.forget('ipad');
    expect(presence.graceLeftMs()).toBe(PRESENCE_GRACE_MS);
  });

  it('dwa urządzenia: karencja liczy się od tego, które zeszło z ekranu później', () => {
    const { presence, tick } = setup();
    presence.note('ipad', { visible: true });
    presence.note('telefon', { visible: true });
    presence.note('ipad', { visible: false });
    tick(30_000);
    presence.note('telefon', { visible: false });
    tick(10_000);
    expect(presence.graceLeftMs()).toBe(PRESENCE_GRACE_MS - 10_000);
  });

  it('zgłoszenie „w tle” bez widoczności przed nim karencji nie daje', () => {
    const { presence } = setup();
    presence.note('ipad', { visible: false });
    expect(presence.graceLeftMs()).toBe(0);
  });
});
