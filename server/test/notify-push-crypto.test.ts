/**
 * Szyfrowanie treści banera (`notify/push-crypto.ts`) — producent wektorów formatu 3
 * `shared/fixtures/push-crypto/vectors.v3.json` i ich strażnicy. Format 2 is a rejection case that no code produces:
 * this file seals the vector inputs with the format 2 constants (`FORMAT2_PROTOCOL`) and checks that such envelopes
 * do not open with the format 3 constants.
 *
 * - Sekcja `rfc` pliku jest wpisana RĘCZNIE z RFC 5869 A.1 i RFC 8439 §2.8.2 (sprawdzian spoza modelu); tu liczy ją
 *   `node:crypto`, a w Swift — CryptoKit (`PushCryptoTests`). Tryb zapisu (`RAROG_FIXTURES_WRITE=1`) jej nie rusza.
 * - Wektory protokołu: produkcyjny `createPushSealer` ze stałym nonce (jedyny dozwolony wtrysk), klucze testowe;
 *   tekst jawny z polskimi znakami, emoji 4-bajtowym, sekwencją ZWJ, nieznanym `kind`, długości `c` z resztą 2 i 3
 *   mod 4 i sufitem 2 KB; the vector `limit-zdania-z-kodem` carries a sentence code next to the title and body
 *   (`titleRef`, `bodyRef`).
 *   Odmowy: zmieniony bit tagu, szyfrogramu i nonce, AAD z innym `kid`, koperta formatu 2 (the same text sealed
 *   with the format 2 constants), inny klucz, `c` krótsze niż tag, `n` 11 i 13 B, znaki spoza alfabetu i `=`,
 *   zły `kid`.
 * - Nonce: dwa szyfrowania tej samej treści dają różne `n` i `c` (strażnik 13f).
 * - Szpieg loggera (strażnik 13g) od `Notifier.note` do wysyłki: ani klucza push i pochodnego, ani tekstu
 *   jawnego, ani etykiety sesji (tu etykieta = cała treść banera, bo pytanie przyszło bez szczegółu).
 *
 * Domyślnie test PORÓWNUJE wektory z plikiem.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pushKeyId } from '../src/auth/devices-store.ts';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import { apnsAlertRequestE2e } from '../src/notify/apns-payload.ts';
import { buildContent } from '../src/notify/content.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import { createApnsSink } from '../src/notify/apns-sink.ts';
import { createFanoutSink } from '../src/notify/fanout.ts';
import { Notifier } from '../src/notify/index.ts';
import { Presence } from '../src/notify/presence.ts';
import {
  PUSH_AAD_PREFIX_V3, PUSH_KEY_INFO_V3, PUSH_PLAINTEXT_BUCKET_BYTES, PUSH_PLAINTEXT_MAX_BYTES, createPushSealer,
  deriveBannerKey, padPlaintext, pushAad,
} from '../src/notify/push-crypto.ts';
import type { DevicePushKey, PushEnvelope } from '../src/notify/push-crypto.ts';
import { say } from '@rarog/shared/sentences';
import type { SentenceRef } from '@rarog/shared/sentences';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures/push-crypto');
/** Wektory formatu 3 — jedynego, który serwer produkuje. */
const FILE_V3 = path.join(FIXTURES, 'vectors.v3.json');
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';

/** Stałe formatu 3 po stronie lustra odbiorcy (tekstem, jak w pliku wektorów). */
const PROTOCOL = { info: PUSH_KEY_INFO_V3, aadPrefix: PUSH_AAD_PREFIX_V3 } as const;

interface RfcSection {
  readonly hkdf: { ikm: string; salt: string; info: string; length: number; prk: string; okm: string };
  readonly aead: { key: string; nonce: string; aad: string; plaintext: string; ciphertext: string; tag: string };
}

interface Expectation {
  readonly kind: string | null;
  readonly title?: string;
  readonly titleRef?: SentenceRef;
  readonly body?: string;
  readonly bodyRef?: SentenceRef;
  readonly sessionId?: string;
  readonly termId?: string;
  readonly exp: number;
}

interface Vector {
  readonly name: string;
  readonly pushKey: string;
  readonly kid: string;
  /** Klucz po HKDF, hex. */
  readonly bannerKey: string;
  readonly n: string;
  /** AAD jako tekst UTF-8. */
  readonly aad: string;
  /** Tekst jawny BEZ dopełnienia (JSON). */
  readonly plaintext: string;
  /** Długość tekstu jawnego po dopełnieniu spacjami (bajty). */
  readonly paddedBytes: number;
  readonly c: string;
  /** `c.length % 4` — wektory pokrywają resztę 2 i 3 (base64url bez `=`). */
  readonly cLengthMod4: number;
  /** Co apka ma zdekodować z tekstu jawnego (`kind: null` = rodzaj nieznany, cel przeżywa). */
  readonly expect: Expectation;
}

interface Refusal {
  readonly name: string;
  readonly pushKey: string;
  readonly envelope: { readonly v: number; readonly kid: string; readonly n: string; readonly c: string };
  /** `envelope` = odbiorca odrzuca kopertę przed szyfrem; `aead` = koperta poprawna, otwarcie się nie udaje. */
  readonly reason: 'envelope' | 'aead';
}

interface VectorsFile {
  readonly _comment: readonly string[];
  readonly rfc: RfcSection;
  readonly protocol: Record<string, unknown>;
  readonly vectors: readonly Vector[];
  readonly refusals: readonly Refusal[];
}

const stored = JSON.parse(readFileSync(FILE_V3, 'utf8')) as VectorsFile;
const hex = (value: string): Buffer => Buffer.from(value, 'hex');

/**
 * Klucze TESTOWE o powtórzonym wzorze: 32×0x05 (ten sam co w `shared/fixtures/rest/pair.json`) i 32×0x0a. Wzór
 * widać też w base64url (`BQUF…`, `CgoK…`), więc skaner sekretów nie bierze ich za prawdziwe klucze.
 */
const KEY_A: DevicePushKey = { pushKey: Buffer.alloc(32, 5).toString('base64url'), kid: 'f849d673' };
const KEY_B_RAW = Buffer.alloc(32, 0x0a);
const KEY_B: DevicePushKey = { pushKey: KEY_B_RAW.toString('base64url'), kid: pushKeyId(KEY_B_RAW.toString('base64url')) };

/** Stały nonce per wektor — wyłącznie parametrem fabryki. */
const sealWith = (nonce: Buffer, key: DevicePushKey, plaintext: string): PushEnvelope =>
  createPushSealer({ nonce: () => nonce }).seal(key, plaintext);

/**
 * Lustro odbiorcy na `node:crypto` (bez kodu produkcyjnego): otwarcie koperty kluczem push stałymi `protocol`
 * (format 3 by default; rejection cases pass the format 2 constants).
 */
function open(
  pushKey: string, envelope: { kid: string; n: string; c: string },
  protocol: { readonly info: string; readonly aadPrefix: string } = PROTOCOL,
): Buffer {
  const aad = `${protocol.aadPrefix}${envelope.kid}`;
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(pushKey, 'base64url'), Buffer.alloc(0), Buffer.from(protocol.info), 32));
  const sealed = Buffer.from(envelope.c, 'base64url');
  if (sealed.length < 16) throw new Error('krótsze niż tag');
  const body = sealed.subarray(0, sealed.length - 16);
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(envelope.n, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: body.length });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Constants of format 2, which no code produces any more: the app and the mirror must reject its envelopes. */
const FORMAT2_PROTOCOL = {
  info: 'pilot-push-banner-v1', // stara-nazwa
  aadPrefix: 'pilot-push/2|', // stara-nazwa
} as const;

/** Banner key after HKDF with the constants of `protocol`. */
const bannerKeyWith = (pushKey: string, protocol: { readonly info: string }): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(pushKey, 'base64url'), Buffer.alloc(0), Buffer.from(protocol.info), 32));

/**
 * Format 2 envelope of the same inputs as the vector: the same padding, nonce and push key, the format 2 constants.
 * No format 2 code exists, so `node:crypto` seals it here.
 */
function sealFormat2(v: { readonly pushKey: string; readonly kid: string; readonly n: string; readonly plaintext: string }): string {
  const cipher = createCipheriv('chacha20-poly1305', bannerKeyWith(v.pushKey, FORMAT2_PROTOCOL), Buffer.from(v.n, 'base64url'),
    { authTagLength: 16 });
  const plain = padPlaintext(v.plaintext);
  cipher.setAAD(Buffer.from(`${FORMAT2_PROTOCOL.aadPrefix}${v.kid}`, 'utf8'), { plaintextLength: plain.length });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}

/** Reguły koperty po stronie odbiorcy — lustro `PushEnvelope.swift`. */
const envelopeValid = (e: { kid: string; n: string; c: string }): boolean =>
  /^[0-9a-f]{8}$/.test(e.kid) && /^[A-Za-z0-9_-]{16}$/.test(e.n) && /^[A-Za-z0-9_-]{22,}$/.test(e.c);

const EXP = 1_791_367_800;
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';

/**
 * `limit-zdania-z-kodem` is the only producer of `titleRef`/`bodyRef` among the vectors: the vector itself carries the
 * sentence code, not push content from `say()`. Its title and body are registry sentences, one without arguments and
 * one with an `instant` argument.
 */
const LIMIT_TITLE = say('push.placeholder.title');
const LIMIT_BODY = say('state.limit-reached', { reset: '2026-11-12T10:00:00.000Z' });

/**
 * Tekst jawny banera błędu sesji z kodu serwera: `buildContent` z dopiskiem stanu `state.driver-error`
 * i `apnsAlertRequestE2e` (szyfrowanie atrapą, która oddaje tekst jawny). Rozszerzenie powiadomień apki tłumaczy go
 * w `PushServiceTests` — to jest pełna droga treści od serwera do polskiego banera.
 */
const sessionErrorPlain = ((): Record<string, unknown> => {
  let plaintext = '';
  const content = buildContent({
    cls: 'failure', kind: 'error', project: 'willow', sessionId: SESSION, detail: say('state.driver-error'),
  });
  apnsAlertRequestE2e(content, {
    topic: 'ai.rarog.app', nowMs: (EXP - content.ttl) * 1000, key: KEY_A,
    sealer: { seal: (key, text) => { plaintext = text; return { kid: key.kid, n: '', c: '' }; } },
  });
  return JSON.parse(plaintext) as Record<string, unknown>;
})();

/** Wejścia wektorów protokołu: klucz, nonce i tekst jawny (JSON bez dopełnienia). */
const INPUTS: readonly { name: string; key: DevicePushKey; nonce: Buffer; plain: Record<string, unknown>; expect: Expectation }[] = (() => {
  const zgoda = {
    kind: 'permission', title: '⏳ Czeka na zgodę · zażółć-gęślą-jaźń', body: 'Edit — zapis „notatek”', sessionId: SESSION,
    exp: EXP,
  };
  const pytanie = {
    kind: 'question', title: '❓ Pyta · 👩‍💻 projekt 🚀',
    body: `Czy wdrożyć? 👨‍👩‍👧‍👦 ${'Łódź 🦄 '.repeat(40)}`.trim(), sessionId: SESSION, termId: '0123456789abcdef', exp: EXP,
  };
  const nieznany = { kind: 'nowy-rodzaj', title: 'Nowy rodzaj', body: 'Serwer nowszy niż apka', sessionId: SESSION, exp: EXP };
  const sufit = {
    kind: 'error', title: `❌ Błąd · ${'ę'.repeat(300)}`, body: 'ż'.repeat(620), sessionId: SESSION, exp: EXP,
  };
  const skonczyl = { kind: 'done', sessionId: SESSION, termId: '0123456789abcdef', exp: EXP };
  const probny = { kind: 'test', title: '🔔 Powiadomienia działają', body: 'Tap otwiera Raroga.', exp: EXP };
  const zKodem = {
    kind: 'limit', title: LIMIT_TITLE.text, titleRef: LIMIT_TITLE.ref, body: LIMIT_BODY.text, bodyRef: LIMIT_BODY.ref,
    sessionId: SESSION, exp: EXP,
  };
  const nonce = (byte: number): Buffer => Buffer.alloc(12, byte);
  return [
    { name: 'zgoda-polskie-znaki', key: KEY_A, nonce: nonce(1), plain: zgoda, expect: zgoda },
    { name: 'pytanie-emoji-zwj-reszta-2', key: KEY_A, nonce: nonce(2), plain: pytanie, expect: pytanie },
    { name: 'nieznany-rodzaj', key: KEY_A, nonce: nonce(3), plain: nieznany, expect: { ...nieznany, kind: null } },
    { name: 'sufit-2-kb', key: KEY_B, nonce: nonce(4), plain: sufit, expect: sufit },
    { name: 'skonczyl-bez-tytulu', key: KEY_B, nonce: nonce(5), plain: skonczyl, expect: skonczyl },
    { name: 'probny-bez-sesji', key: KEY_A, nonce: hex('000102030405060708090a0b'), plain: probny, expect: probny },
    { name: 'limit-zdania-z-kodem', key: KEY_A, nonce: nonce(6), plain: zKodem, expect: zKodem },
    { name: 'blad-sesji-z-buildcontent', key: KEY_A, nonce: nonce(7), plain: sessionErrorPlain, expect: sessionErrorPlain as unknown as Expectation },
  ];
})();

function produceVectors(): Vector[] {
  return INPUTS.map(({ name, key, nonce, plain, expect: want }) => {
    const plaintext = JSON.stringify(plain);
    const envelope = sealWith(nonce, key, plaintext);
    return {
      name, pushKey: key.pushKey, kid: key.kid, bannerKey: deriveBannerKey(key.pushKey).toString('hex'),
      n: envelope.n, aad: `${PROTOCOL.aadPrefix}${key.kid}`, plaintext, paddedBytes: padPlaintext(plaintext).length,
      c: envelope.c, cLengthMod4: envelope.c.length % 4, expect: want,
    };
  });
}

/** Bit odwrócony w bajcie `index` (ujemny = od końca) łańcucha base64url. */
function flip(b64: string, index: number): string {
  const bytes = Buffer.from(b64, 'base64url');
  const at = index < 0 ? bytes.length + index : index;
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return bytes.toString('base64url');
}

function produceRefusals(vectors: readonly Vector[]): Refusal[] {
  const base = vectors[0];
  if (base === undefined) throw new Error('brak wektora bazowego');
  const env = { v: 3, kid: base.kid, n: base.n, c: base.c };
  const refuse = (name: string, envelope: Refusal['envelope'], reason: Refusal['reason'], pushKey = base.pushKey): Refusal =>
    ({ name, pushKey, envelope, reason });
  return [
    refuse('zmieniony-bit-tagu', { ...env, c: flip(env.c, -1) }, 'aead'),
    refuse('zmieniony-bit-szyfrogramu', { ...env, c: flip(env.c, 0) }, 'aead'),
    refuse('zmieniony-bit-nonce', { ...env, n: flip(env.n, 5) }, 'aead'),
    refuse('aad-inny-kid', { ...env, kid: 'f849d674' }, 'aead'),
    // Ta sama treść jako koperta formatu 2 — wygląda poprawnie, klucz i AAD formatu 3 jej nie otworzą.
    refuse('koperta-formatu-2', { ...env, c: sealFormat2(base) }, 'aead'),
    refuse('inny-klucz', env, 'aead', KEY_B.pushKey),
    refuse('c-krotsze-niz-tag', { ...env, c: env.c.slice(0, 21) }, 'envelope'),
    refuse('n-11-bajtow', { ...env, n: Buffer.alloc(11, 1).toString('base64url') }, 'envelope'),
    refuse('n-13-bajtow', { ...env, n: Buffer.alloc(13, 1).toString('base64url') }, 'envelope'),
    refuse('c-znak-spoza-alfabetu', { ...env, c: `${env.c.slice(0, 10)}+${env.c.slice(11)}` }, 'envelope'),
    refuse('c-z-dopelnieniem', { ...env, c: `${env.c}=` }, 'envelope'),
    refuse('n-z-dopelnieniem', { ...env, n: `${env.n.slice(0, 15)}=` }, 'envelope'),
    refuse('kid-wielkie-litery', { ...env, kid: base.kid.toUpperCase() }, 'envelope'),
    refuse('kid-7-znakow', { ...env, kid: base.kid.slice(0, 7) }, 'envelope'),
  ];
}

const producedVectors = produceVectors();
const produced = {
  protocol: {
    info: PROTOCOL.info, aadPrefix: PROTOCOL.aadPrefix, salt: '', bucketBytes: PUSH_PLAINTEXT_BUCKET_BYTES,
    maxPlaintextBytes: PUSH_PLAINTEXT_MAX_BYTES, nonceBytes: 12, tagBytes: 16,
  },
  vectors: producedVectors,
  refusals: produceRefusals(producedVectors),
};

if (WRITE) {
  // The `rfc` section and the comment stay from the file: typed by hand, not produced by code.
  writeFileSync(FILE_V3, `${JSON.stringify({ _comment: stored._comment, rfc: stored.rfc, ...produced }, null, 2)}\n`);
}

describe('wektory RFC (wpisane ręcznie) — `node:crypto`', () => {
  it('RFC 5869 A.1: HKDF-SHA256 (PRK i OKM)', () => {
    const { hkdf } = stored.rfc;
    expect(createHmac('sha256', hex(hkdf.salt)).update(hex(hkdf.ikm)).digest('hex')).toBe(hkdf.prk);
    expect(Buffer.from(hkdfSync('sha256', hex(hkdf.ikm), hex(hkdf.salt), hex(hkdf.info), hkdf.length)).toString('hex'))
      .toBe(hkdf.okm);
  });

  it('RFC 8439 §2.8.2: ChaCha20-Poly1305 (szyfrogram i tag)', () => {
    const { aead } = stored.rfc;
    const plain = Buffer.from(aead.plaintext, 'utf8');
    const cipher = createCipheriv('chacha20-poly1305', hex(aead.key), hex(aead.nonce), { authTagLength: 16 });
    cipher.setAAD(hex(aead.aad), { plaintextLength: plain.length });
    expect(Buffer.concat([cipher.update(plain), cipher.final()]).toString('hex')).toBe(aead.ciphertext);
    expect(cipher.getAuthTag().toString('hex')).toBe(aead.tag);
  });

  it('sól pusta = 32 bajty zera (HMAC dopełnia klucz)', () => {
    const ikm = Buffer.from(KEY_A.pushKey, 'base64url');
    const info = Buffer.from(PROTOCOL.info);
    const empty = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
    expect(Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(32), info, 32))).toEqual(empty);
    expect(deriveBannerKey(KEY_A.pushKey)).toEqual(empty);
  });
});

describe('wektory protokołu formatu 3 = to, co dziś produkuje kod (odśwież: RAROG_FIXTURES_WRITE=1)', () => {
  const made = produced;
  it('protocol, vectors and refusals equal the file', () => {
    expect(stored.protocol).toEqual(made.protocol);
    expect(stored.vectors).toEqual(made.vectors);
    expect(stored.refusals).toEqual(made.refusals);
  });

  it('pokrycie: reszta 2 i 3 mod 4 długości `c`, sufit 2 KB, nieznany rodzaj, ZWJ i emoji 4-bajtowe, oba klucze', () => {
    const mods = new Set(made.vectors.map((v) => v.cLengthMod4));
    expect(mods.has(2) && mods.has(3)).toBe(true);
    expect(made.vectors.some((v) => v.paddedBytes === PUSH_PLAINTEXT_MAX_BYTES)).toBe(true);
    expect(made.vectors.some((v) => v.expect.kind === null)).toBe(true);
    expect(made.vectors.some((v) => v.plaintext.includes('‍') && /\p{Extended_Pictographic}/u.test(v.plaintext)))
      .toBe(true);
    expect(new Set(made.vectors.map((v) => v.kid))).toEqual(new Set([KEY_A.kid, KEY_B.kid]));
    expect(KEY_A.kid).toBe(pushKeyId(KEY_A.pushKey));
  });

  it.each(made.vectors.map((v) => [v.name, v] as const))('%s: lustro otwiera, dopełnienie spacjami do kubełka', (_name, v) => {
    const plain = open(v.pushKey, v);
    expect(plain.length).toBe(v.paddedBytes);
    expect(plain.length % PUSH_PLAINTEXT_BUCKET_BYTES).toBe(0);
    expect(plain.toString('utf8').trimEnd()).toBe(v.plaintext);
    expect(JSON.parse(plain.toString('utf8'))).toEqual(JSON.parse(v.plaintext));
    expect(v.n).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(v.aad).toBe(pushAad(v.kid).toString('utf8'));
    // Stałe formatu 2 tej koperty nie otwierają: formaty różnią się kluczem i AAD.
    expect(() => open(v.pushKey, v, FORMAT2_PROTOCOL)).toThrow();
  });

  it.each(made.refusals.map((r) => [r.name, r] as const))('odmowa %s', (_name, r) => {
    if (r.reason === 'envelope') {
      expect(envelopeValid(r.envelope)).toBe(false);
      return;
    }
    expect(envelopeValid(r.envelope)).toBe(true);
    expect(() => open(r.pushKey, r.envelope)).toThrow();
  });
});

describe('format 2: a rejection case no code produces', () => {
  it('format 3 constants differ from format 2; the same inputs give a different `c` at the same `n`', () => {
    expect(PROTOCOL).toEqual({ info: 'rarog-push-banner-v1', aadPrefix: 'rarog-push/3|' });
    expect(FORMAT2_PROTOCOL.info).not.toBe(PROTOCOL.info);
    expect(FORMAT2_PROTOCOL.aadPrefix).not.toBe(PROTOCOL.aadPrefix);
    for (const v of produced.vectors) expect(sealFormat2(v), v.name).not.toBe(v.c);
  });

  it('wektor tylko formatu 3 z kodem zdania: `titleRef` i `bodyRef` z `say()` obok tytułu i treści', () => {
    const v = produced.vectors.find((vector) => vector.name === 'limit-zdania-z-kodem');
    expect(v).toBeDefined();
    const plain = JSON.parse(v?.plaintext ?? '{}') as Record<string, unknown>;
    expect(plain).toMatchObject({
      kind: 'limit', title: LIMIT_TITLE.text, titleRef: LIMIT_TITLE.ref, body: LIMIT_BODY.text, bodyRef: LIMIT_BODY.ref,
    });
    expect(v?.expect).toEqual(plain);
  });

  it('wektor błędu sesji z `buildContent`: tytuł i treść z kodem, `bodyRef` = `ref` dopisku stanu', () => {
    const v = produced.vectors.find((vector) => vector.name === 'blad-sesji-z-buildcontent');
    expect(JSON.parse(v?.plaintext ?? '{}')).toEqual({
      kind: 'error', title: '❌ Error · willow', titleRef: { code: 'push.title.error', args: ['willow'] },
      body: 'the engine finished with an error', bodyRef: { code: 'state.driver-error' }, sessionId: SESSION, exp: EXP,
    });
  });

  const vectorCases = produced.vectors.map((v) => [v.name, v] as const);
  it.each(vectorCases)('%s: the format 2 envelope opens only with the format 2 constants', (_name, v) => {
    const legacy = { kid: v.kid, n: v.n, c: sealFormat2(v) };
    expect(open(v.pushKey, legacy, FORMAT2_PROTOCOL).toString('utf8').trimEnd()).toBe(v.plaintext);
    expect(() => open(v.pushKey, legacy)).toThrow();
    expect(bannerKeyWith(v.pushKey, FORMAT2_PROTOCOL).toString('hex')).not.toBe(v.bannerKey);
  });
});

describe('`createPushSealer` i dopełnienie', () => {
  it('strażnik 13f: dwa szyfrowania tej samej treści → różne `n` i `c` (losowy nonce w produkcji)', () => {
    const sealer = createPushSealer();
    const a = sealer.seal(KEY_A, '{"kind":"test","exp":1}');
    const b = sealer.seal(KEY_A, '{"kind":"test","exp":1}');
    expect(a.n).not.toBe(b.n);
    expect(a.c).not.toBe(b.c);
    expect(open(KEY_A.pushKey, a).toString('utf8').trimEnd()).toBe('{"kind":"test","exp":1}');
  });

  it('dopełnienie: wielokrotność 256 B, sufit 2048 B; dłuższy tekst bez dopełnienia', () => {
    expect(padPlaintext('{}').length).toBe(256);
    expect(padPlaintext('x'.repeat(256)).length).toBe(256);
    expect(padPlaintext('x'.repeat(257)).length).toBe(512);
    expect(padPlaintext('x'.repeat(2000)).length).toBe(2048);
    expect(padPlaintext('x'.repeat(2048)).length).toBe(2048);
    expect(padPlaintext('x'.repeat(2100)).length).toBe(2100);
    expect(padPlaintext('ż').subarray(2).toString('utf8')).toBe(' '.repeat(254));
  });

  it('zły nonce, `kid` albo klucz: wyjątek, nigdy koperta', () => {
    expect(() => sealWith(Buffer.alloc(11), KEY_A, '{}')).toThrow(/nonce/);
    expect(() => sealWith(Buffer.alloc(12), { ...KEY_A, kid: 'F849D673' }, '{}')).toThrow(/kid/);
    expect(() => sealWith(Buffer.alloc(12), { ...KEY_A, pushKey: 'AAAA' }, '{}')).toThrow(/klucz/);
    expect(() => deriveBannerKey(`${KEY_A.pushKey}=`)).toThrow();
  });
});

describe('strażnik 13g: szpieg loggera od `Notifier.note` do wysyłki', () => {
  it('ani klucza push i pochodnego, ani tekstu jawnego, ani etykiety sesji — w żadnej linii', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rarog-push-crypto-'));
    try {
      const logs: string[] = [];
      const log = (line: string): void => { logs.push(line); };
      const devices = createApnsDeviceStore({ dataDir: dir, logger: log });
      const deviceId = 'd'.repeat(32);
      devices.upsert({
        token: 'ab'.repeat(32), environment: 'development', label: 'iPhone·Tajny', alerts: true, topic: 'ai.rarog.app',
        deviceId, pushFormats: [3],
      });
      const sent: ApnsRequest[] = [];
      const sink = createFanoutSink({
        apns: createApnsSink({
          devices, log, e2e: true, activeDevices: () => new Map([[deviceId, KEY_A]]),
          sender: { send: (_e, _t, request) => { sent.push(request); return Promise.resolve({ kind: 'ok' }); } },
        }),
      });
      const timers: (() => void)[] = [];
      const notifier = new Notifier({
        presence: new Presence({ log }), sink, log, badge: () => 1,
        look: () => ({ state: 'waiting-question', seen: false, backgroundTasks: 0, waitingOnOwnCommand: false }),
        setTimeout: (cb) => { timers.push(cb); return timers.length; },
        clearTimeout: () => {},
      });
      // Pytanie bez szczegółu: etykieta sesji jest CAŁĄ treścią banera (`content.ts`, `bodyFor`).
      const label = 'etykieta-z-tajnym-planem';
      notifier.note({
        sessionId: SESSION, event: { type: 'question-requested' }, backgroundTasks: 0, project: 'projekt', label,
      });
      expect(timers).toHaveLength(1);
      timers[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent).toHaveLength(1);
      // Deklaracja z 3 dostaje format 3: blok `rarog`.
      const envelope = (JSON.parse(sent[0]?.body ?? '{}') as { rarog: PushEnvelope }).rarog;
      const plaintext = open(KEY_A.pushKey, envelope).toString('utf8').trimEnd();
      expect(JSON.parse(plaintext)).toMatchObject({ kind: 'question', body: label });
      const derived = deriveBannerKey(KEY_A.pushKey);
      const text = logs.join('\n');
      expect(logs.some((line) => line.startsWith('push: APNs question — v3: 1'))).toBe(true);
      for (const secret of [
        label, plaintext, KEY_A.pushKey, derived.toString('hex'), derived.toString('base64url'), derived.toString('base64'),
        'iPhone·Tajny', 'ab'.repeat(32), envelope.c.slice(0, 32),
      ]) {
        expect(text, secret).not.toContain(secret);
      }
      await devices.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
