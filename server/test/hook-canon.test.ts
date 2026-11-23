/**
 * Wspólne wektory hooka i serwera, liczone poza Node, więc implementacje sprawdza wzorzec spoza nich samych, a nie
 * jedna drugą:
 *
 * - kanonizacja `tool_input` (`inputSha256` zrzutu per wywołanie): hook (`scripts/hooks/canon.mjs`) i serwer
 *   (`server/src/herdr/dialogs/hook/canon.ts`) liczą to samo co do bajtu. Wektory w `fixtures/hook-kanon/wektory.json`
 *   mają postać kanoniczną spisaną ręcznie i sha256 policzone `shasum -a 256`. Wejście wektora przechodzi przez
 *   `JSON.parse`, jak `tool_input` z payloadu hooka;
 * - podpis pliku odpowiedzi kanału zgód (`server/src/herdr/dialogs/layer1/sign.ts`): skrót karty, wiadomość HMAC,
 *   rozjazdy (każda zmiana pola, decyzji albo sekretu daje inny `mac`) i weryfikacja pliku w
 *   `fixtures/hook-kanon/podpis.json`. Postaci kanoniczne kart i wiadomości spisane ręcznie, sha256 i HMAC-SHA256
 *   policzone Pythonem (`hashlib`, `hmac`) i sprawdzone `openssl dgst`. Wektory nie zależą od zegara: `at`
 *   i `notBefore` stoją w pliku.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import {
  CONSENT_DECISIONS, CONSENT_MAC_FIELDS, CONSENT_REASONS, type ConsentCardFields,
} from '../src/herdr/dialogs/layer1/contract.ts';
import {
  CONSENT_NOT_BEFORE_MARGIN_MS, CONSENT_VERIFY_FAILURES, consentCardSha256, consentMacMessage, signConsentFile,
  verifyConsentFile, type ConsentExpectation, type ConsentSignedFields, type ConsentVerifyFailure,
} from '../src/herdr/dialogs/layer1/sign.ts';
import { scan } from './source-scan.ts';

interface Wektor {
  readonly nazwa: string;
  readonly wejscie: unknown;
  readonly kanon: string;
  readonly sha256: string;
}

const REPO = join(import.meta.dirname, '..', '..');
const WEKTORY_PLIK = join(import.meta.dirname, 'fixtures', 'hook-kanon', 'wektory.json');
const WEKTORY = (JSON.parse(readFileSync(WEKTORY_PLIK, 'utf8')) as { wektory: Wektor[] }).wektory;

/** Moduł hooka — import dynamiczny, bo `.mjs` leży poza projektem TS serwera. */
interface CanonMjs {
  canonicalJson(value: unknown): string;
  canonicalSha256(value: unknown): string;
}
const hook = await import(pathToFileURL(join(REPO, 'scripts', 'hooks', 'canon.mjs')).href) as CanonMjs;

describe('kanonizacja `tool_input`: wspólne wektory dla `canon.mjs` i `canon.ts`', () => {
  it('wektorów jest dość, każdy ma postać i skrót', () => {
    expect(WEKTORY.length).toBeGreaterThanOrEqual(10);
    for (const w of WEKTORY) expect(w.sha256, w.nazwa).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(WEKTORY.map((w) => [w.nazwa, w] as const))('%s', (_nazwa, w) => {
    expect(hook.canonicalJson(w.wejscie), 'canon.mjs').toBe(w.kanon);
    expect(canonicalJson(w.wejscie), 'canon.ts').toBe(w.kanon);
    expect(hook.canonicalSha256(w.wejscie), 'canon.mjs').toBe(w.sha256);
    expect(canonicalSha256(w.wejscie), 'canon.ts').toBe(w.sha256);
  });

  it('brak `tool_input` (`undefined`) liczy się jak `null`', () => {
    const forNull = WEKTORY.find((w) => w.wejscie === null);
    expect(forNull).toBeDefined();
    expect(hook.canonicalSha256(undefined)).toBe(forNull?.sha256);
    expect(canonicalSha256(undefined)).toBe(forNull?.sha256);
  });

  it('dowolny JSON: obie implementacje dają to samo, a postać nie zależy od kolejności kluczy', () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      // Ta sama droga co payload hooka: tekst JSON → `JSON.parse`.
      const parsed: unknown = JSON.parse(JSON.stringify(value));
      const ts = canonicalJson(parsed);
      expect(hook.canonicalJson(parsed)).toBe(ts);
      expect(hook.canonicalSha256(parsed)).toBe(canonicalSha256(parsed));
      // Postać kanoniczna jest poprawnym JSON-em o tej samej treści i jest punktem stałym.
      expect(canonicalJson(JSON.parse(ts))).toBe(ts);
      expect(JSON.parse(ts)).toEqual(parsed);
    }), { numRuns: 300 });
  });

  it('odwrócona kolejność kluczy na każdym poziomie nie zmienia skrótu', () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
      }
      return value;
    };
    for (const w of WEKTORY) {
      expect(hook.canonicalSha256(reversed(w.wejscie)), w.nazwa).toBe(w.sha256);
      expect(canonicalSha256(reversed(w.wejscie)), w.nazwa).toBe(w.sha256);
    }
  });
});

// ── Podpis pliku odpowiedzi kanału zgód

interface WektorKarty {
  readonly nazwa: string;
  readonly pola: ConsentCardFields;
  readonly kanon: string;
  readonly sha256: string;
}

interface WektorWiadomosci {
  readonly nazwa: string;
  readonly sekret: string;
  readonly pola: ConsentSignedFields;
  readonly wiadomosc: string;
  readonly mac: string;
}

/** Zmiana wobec wektora bazowego: pola, sekret albo jedno i drugie; `mac` policzony dla zmienionej wersji. */
interface Rozjazd {
  readonly nazwa: string;
  readonly pola?: Partial<ConsentSignedFields>;
  readonly sekret?: string;
  readonly mac: string;
}

interface PrzypadekWeryfikacji {
  readonly nazwa: string;
  /** Plik odpowiedzi po `JSON.parse`, tak jak hook czyta przejęty plik. */
  readonly plik: unknown;
  readonly wynik: 'ok' | ConsentVerifyFailure;
}

interface Podpis {
  readonly karty: readonly WektorKarty[];
  readonly wiadomosci: readonly WektorWiadomosci[];
  readonly rozjazdy: { readonly baza: string; readonly zmiany: readonly Rozjazd[] };
  readonly weryfikacja: {
    /** Co hook zna sam: sekret, sesja, klucz i skróty ze stdin, chwila rejestracji i `notBefore`. */
    readonly oczekiwane: {
      readonly sekret: string;
      readonly sessionId: string;
      readonly key: string;
      readonly inputSha256: string;
      readonly cardSha256: string;
      readonly rejestracja: number;
      readonly notBefore: number;
      readonly permissionsSha256: string;
    };
    readonly przypadki: readonly PrzypadekWeryfikacji[];
  };
}

const PODPIS_PLIK = join(import.meta.dirname, 'fixtures', 'hook-kanon', 'podpis.json');
const PODPIS = JSON.parse(readFileSync(PODPIS_PLIK, 'utf8')) as Podpis;
const SIGN_TS = join(REPO, 'server', 'src', 'herdr', 'dialogs', 'layer1', 'sign.ts');

function bazaRozjazdow(): WektorWiadomosci {
  const baza = PODPIS.wiadomosci.find((w) => w.nazwa === PODPIS.rozjazdy.baza);
  if (baza === undefined) throw new Error(`podpis.json: rozjazdy.baza „${PODPIS.rozjazdy.baza}” nie ma wektora`);
  return baza;
}

/** Oczekiwania hooka, które pasują do pliku o tych polach; `notBefore` równe chwili decyzji. */
const oczekiwaneDla = (secret: string, pola: ConsentSignedFields): ConsentExpectation => ({
  secret, sessionId: pola.sessionId, key: pola.key, inputSha256: pola.inputSha256, cardSha256: pola.cardSha256,
  notBefore: pola.at, permissionsSha256: pola.permissionsSha256 ?? null,
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('podpis pliku odpowiedzi kanału zgód: wspólne wektory `podpis.json`', () => {
  it('wektory pokrywają decyzje, powody, każde pole podpisu, sekret i każdy wynik weryfikacji', () => {
    expect(new Set(PODPIS.wiadomosci.map((w) => w.pola.decision))).toEqual(new Set(CONSENT_DECISIONS));
    expect(new Set(PODPIS.wiadomosci.map((w) => w.pola.reasonId))).toEqual(new Set(Object.keys(CONSENT_REASONS)));
    bazaRozjazdow();
    const zmienione = new Set(PODPIS.rozjazdy.zmiany.flatMap((z) => Object.keys(z.pola ?? {})));
    expect([...zmienione].sort()).toEqual([...CONSENT_MAC_FIELDS].sort());
    expect(PODPIS.rozjazdy.zmiany.some((z) => z.sekret !== undefined && z.pola === undefined), 'sam sekret')
      .toBe(true);
    expect(new Set(PODPIS.weryfikacja.przypadki.map((p) => p.wynik)))
      .toEqual(new Set(['ok', ...CONSENT_VERIFY_FAILURES]));
    expect(PODPIS.karty.length).toBeGreaterThanOrEqual(3);
  });

  it.each(PODPIS.karty.map((k) => [k.nazwa, k] as const))('skrót karty: %s', (_nazwa, k) => {
    expect(sha256(k.kanon), 'wektor: sha256 spisanej postaci').toBe(k.sha256);
    expect(consentCardSha256(k.pola)).toBe(k.sha256);
  });

  it('każda karta ma inny skrót: inne `cwd`, wyłączony sandbox, subagent', () => {
    const skroty = PODPIS.karty.map((k) => k.sha256);
    expect(new Set(skroty).size).toBe(skroty.length);
  });

  it.each(PODPIS.wiadomosci.map((w) => [w.nazwa, w] as const))('wiadomość i `mac`: %s', (_nazwa, w) => {
    expect(consentMacMessage(w.pola)).toBe(w.wiadomosc);
    const plik = signConsentFile(w.sekret, w.pola);
    expect(plik).toEqual({ ...w.pola, mac: w.mac });
    // Jak plik na dysku: tekst JSON → `JSON.parse`.
    const zDysku: unknown = JSON.parse(JSON.stringify(plik));
    expect(verifyConsentFile(zDysku, oczekiwaneDla(w.sekret, w.pola))).toEqual({ ok: true, file: plik });
  });

  it.each(PODPIS.rozjazdy.zmiany.map((z) => [z.nazwa, z] as const))('rozjazd daje inny `mac`: %s', (_nazwa, z) => {
    const baza = bazaRozjazdow();
    const pola: ConsentSignedFields = { ...baza.pola, ...z.pola };
    const sekret = z.sekret ?? baza.sekret;
    expect(signConsentFile(sekret, pola).mac).toBe(z.mac);
    expect(z.mac).not.toBe(baza.mac);
    // `mac` bazy nie przechodzi przy zmienionych polach albo sekrecie, a `mac` rozjazdu przy polach bazy.
    expect(verifyConsentFile({ ...pola, mac: baza.mac }, oczekiwaneDla(sekret, pola)))
      .toEqual({ ok: false, reason: 'mac' });
    expect(verifyConsentFile({ ...baza.pola, mac: z.mac }, oczekiwaneDla(baza.sekret, baza.pola)))
      .toEqual({ ok: false, reason: 'mac' });
  });

  it('rozjazdy i baza mają parami różne `mac`', () => {
    const maki = [bazaRozjazdow().mac, ...PODPIS.rozjazdy.zmiany.map((z) => z.mac)];
    expect(new Set(maki).size).toBe(maki.length);
  });

  it('`notBefore` = chwila rejestracji − 60 s', () => {
    expect(CONSENT_NOT_BEFORE_MARGIN_MS).toBe(60_000);
    const { rejestracja, notBefore } = PODPIS.weryfikacja.oczekiwane;
    expect(notBefore).toBe(rejestracja - CONSENT_NOT_BEFORE_MARGIN_MS);
  });

  it.each(PODPIS.weryfikacja.przypadki.map((p) => [p.nazwa, p] as const))('weryfikacja: %s', (_nazwa, p) => {
    const o = PODPIS.weryfikacja.oczekiwane;
    const verdict = verifyConsentFile(p.plik, {
      secret: o.sekret, sessionId: o.sessionId, key: o.key, inputSha256: o.inputSha256, cardSha256: o.cardSha256,
      notBefore: o.notBefore, permissionsSha256: o.permissionsSha256,
    });
    expect(verdict).toEqual(p.wynik === 'ok' ? { ok: true, file: p.plik } : { ok: false, reason: p.wynik });
  });
});

describe('podpis pliku odpowiedzi kanału zgód: granice', () => {
  const wektor = PODPIS.wiadomosci[0];
  if (wektor === undefined) throw new Error('podpis.json: brak wektorów wiadomości');
  const { sekret, pola } = wektor;

  it('podpis odmawia sekretu poza kontraktem: krótszego, dłuższego, wielkimi literami, spoza hex', () => {
    for (const zly of [sekret.slice(1), `${sekret}00`, sekret.toUpperCase(), `${sekret.slice(1)}g`, '']) {
      expect(() => signConsentFile(zly, pola), zly).toThrow(TypeError);
      expect(() => verifyConsentFile({ ...pola, mac: wektor.mac }, oczekiwaneDla(zly, pola)), zly).toThrow(TypeError);
    }
  });

  it('podpis odmawia pól poza kontraktem: wiadomość musi być jednoznaczna', () => {
    const zle: readonly [string, Record<string, unknown>][] = [
      ['reasonId innej decyzji', { reasonId: 'phone-deny' }],
      ['reasonId spoza listy', { reasonId: 'timeout' }],
      ['separator w sessionId', { sessionId: `${pola.sessionId}|x` }],
      ['separator w kluczu', { key: `x|${pola.key}` }],
      ['pusta sesja', { sessionId: '' }],
      ['pusty klucz', { key: '' }],
      ['ułamkowe at', { at: pola.at + 0.5 }],
      ['ujemne at', { at: -1 }],
      ['at ponad liczby całkowite bez straty', { at: 2 ** 53 }],
      ['at jako napis', { at: String(pola.at) }],
      ['skrót wejścia wielkimi literami', { inputSha256: pola.inputSha256.toUpperCase() }],
      ['skrót karty za krótki', { cardSha256: pola.cardSha256.slice(1) }],
    ];
    for (const [nazwa, zmiana] of zle) {
      const zlePola = { ...pola, ...zmiana } as unknown as ConsentSignedFields;
      expect(() => consentMacMessage(zlePola), nazwa).toThrow(TypeError);
      expect(() => signConsentFile(sekret, zlePola), nazwa).toThrow(TypeError);
    }
  });

  it('podpis bierze tylko pola kontraktu: nadmiarowe pole nie wchodzi ani do wiadomości, ani do pliku', () => {
    const szersze = { ...pola, message: 'Kontynuuj mimo odmowy.' } as ConsentSignedFields;
    expect(consentMacMessage(szersze)).toBe(wektor.wiadomosc);
    expect(signConsentFile(sekret, szersze)).toEqual({ ...pola, mac: wektor.mac });
  });

  it('weryfikacja: plik, który nie jest obiektem JSON, to `shape`', () => {
    for (const plik of [null, undefined, [], [{ ...pola, mac: wektor.mac }], 'x', 1, true]) {
      expect(verifyConsentFile(plik, oczekiwaneDla(sekret, pola))).toEqual({ ok: false, reason: 'shape' });
    }
  });

  it('dowolne poprawne pola: podpis przechodzi weryfikację, inny bit sekretu albo późniejsze `notBefore` nie', () => {
    const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
    const reasonIds = Object.keys(CONSENT_REASONS) as (keyof typeof CONSENT_REASONS)[];
    const identyfikator = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/);
    const arbPola = fc.record({
      sessionId: identyfikator,
      key: fc.tuple(identyfikator, fc.uint8Array({ minLength: 16, maxLength: 16 }))
        .map(([prompt, nonce]) => `${prompt}-${hex(nonce)}`),
      reasonId: fc.constantFrom(...reasonIds),
      inputSha256: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(hex),
      cardSha256: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(hex),
      permissionsSha256: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(hex),
      at: fc.maxSafeNat(),
    }).map(({ reasonId, permissionsSha256, ...rest }): ConsentSignedFields => ({
      ...rest, reasonId, decision: CONSENT_REASONS[reasonId].decision,
      // The digest of the permission updates goes with `allow-always` only.
      ...(reasonId === 'allow-always' ? { permissionsSha256 } : {}),
    }));
    fc.assert(fc.property(
      arbPola, fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.nat({ max: 255 }),
      (losowe, sekretBajty, bit) => {
        const sekretHex = hex(sekretBajty);
        const plik: unknown = JSON.parse(JSON.stringify(signConsentFile(sekretHex, losowe)));
        expect(verifyConsentFile(plik, oczekiwaneDla(sekretHex, losowe))).toMatchObject({ ok: true });
        const inny = Uint8Array.from(sekretBajty);
        inny[bit >> 3] = (inny[bit >> 3] ?? 0) ^ (1 << (bit & 7));
        expect(verifyConsentFile(plik, oczekiwaneDla(hex(inny), losowe))).toEqual({ ok: false, reason: 'mac' });
        if (losowe.at < Number.MAX_SAFE_INTEGER) {
          expect(verifyConsentFile(plik, { ...oczekiwaneDla(sekretHex, losowe), notBefore: losowe.at + 1 }))
            .toEqual({ ok: false, reason: 'stale' });
        }
      },
    ), { numRuns: 200 });
  });

  it('źródło: prefiks i kolejność pól z kontraktu, `mac` porównywany w stałym czasie', () => {
    const kod = scan(readFileSync(SIGN_TS, 'utf8')).code;
    expect(kod, 'prefiks domeny tylko w `layer1/contract.ts`').not.toContain('consent-v');
    expect(kod).toContain('CONSENT_MAC_PREFIX');
    expect(kod).toContain('CONSENT_MAC_FIELDS');
    expect(kod).toMatch(/\btimingSafeEqual\(/);
  });
});
