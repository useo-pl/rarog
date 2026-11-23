/**
 * Szyfrowanie treści banera APNs end-to-end — klucz, szyfr, koperta i dopełnienie. CZYSTE, zero sieci
 * i zero logów: moduł widzi klucz pochodny i tekst jawny, więc nie ma czym ich zdradzić.
 *
 * Parametry są ZAMROŻONE (zmiana = nowy format bloku); ich drugą stroną jest `RarogContract`
 * (`Push/PushCrypto.swift`, `Push/PushEnvelope.swift`), a zgodność obu stron pilnują wektory
 * `shared/fixtures/push-crypto/vectors.v3.json` (producent: `server/test/notify-push-crypto.test.ts`). Format jest
 * jeden, 3; no code produces format 2 (its envelope is a rejection case in the vector producer):
 *
 * - klucz = HKDF-SHA256: IKM = 32 SUROWE bajty `pushKey` z parowania (base64url → bajty, nie bajty napisu), sól
 *   PUSTA podana jawnie, info {@link PUSH_KEY_INFO_V3}, wyjście 32 B;
 * - szyfr ChaCha20-Poly1305 (tag 16 B), nonce 12 B losowy per wiadomość, AAD = UTF-8 {@link PUSH_AAD_PREFIX_V3}
 *   + `kid` — wiąże szyfrogram z kluczem i formatem, którym apka ma go otworzyć;
 * - koperta = pola `{kid, n, c}` bloku banera (wersję i klucz bloku dokłada `apns-payload.ts`): `n` = base64url
 *   nonce (16 znaków), `c` = base64url (szyfrogram‖tag), oba bez dopełnienia `=`;
 * - tekst jawny (JSON składa `apns-payload.ts`) dopełniony SPACJAMI do wielokrotności
 *   {@link PUSH_PLAINTEXT_BUCKET_BYTES} z sufitem {@link PUSH_PLAINTEXT_MAX_BYTES}: przekaźnik i Apple widzą
 *   kubełek długości, nie długość pytania. `JSON.parse` i `JSONDecoder` spacje za JSON-em tolerują.
 *
 * Stałe protokołu z nazwą produktu stoją WYŁĄCZNIE tutaj — literał w `apns-payload.ts` przewróciłby negatywną część
 * strażnika tożsamości (`product-identity-guard.test.ts`, teksty pushy).
 *
 * Nonce: produkcja bierze `randomBytes(12)`; wstrzyknięcie stałego nonce jest WYŁĄCZNIE parametrem fabryki
 * ({@link createPushSealer}) — złote ramki i wektory potrzebują powtarzalnych bajtów, kod produkcyjny nigdy.
 */
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** `info` HKDF klucza banera formatu 3. */
export const PUSH_KEY_INFO_V3 = 'rarog-push-banner-v1';

/** Przedrostek AAD formatu 3; całość = przedrostek + `kid` (UTF-8). */
export const PUSH_AAD_PREFIX_V3 = 'rarog-push/3|';

/** Długość klucza push z parowania i klucza pochodnego (bajty). */
export const PUSH_KEY_BYTES = 32;

/** Długość nonce ChaCha20-Poly1305 (bajty). */
export const PUSH_NONCE_BYTES = 12;

/** Długość tagu Poly1305 (bajty). */
export const PUSH_TAG_BYTES = 16;

/** Kubełek długości tekstu jawnego: dopełnienie do wielokrotności tej liczby bajtów. */
export const PUSH_PLAINTEXT_BUCKET_BYTES = 256;

/**
 * Sufit tekstu jawnego (bajty UTF-8): do niego `apns-payload.ts` przycina JSON po skalarach, a dopełnienie go nie
 * przekracza. Szyfrogram ≤ 2064 B = 2752 znaki base64url, z `aps` cały ładunek ≈ 3 KB — limit 4096 B APNs mieści
 * się z konstrukcji (i tak sprawdzany PO szyfrowaniu).
 */
export const PUSH_PLAINTEXT_MAX_BYTES = 2048;

/** `kid` klucza push: 8 znaków hex `sha256(surowe bajty pushKey)` (`pushKeyId` w `auth/devices-store.ts`). */
const KID_RE = /^[0-9a-f]{8}$/;

/** Klucz push urządzenia z `devices.json`: jawny tekst base64url i jego `kid`. */
export interface DevicePushKey {
  readonly pushKey: string;
  readonly kid: string;
}

/** Koperta banera (blok bez `v`) — jedyne, co z treści widać poza urządzeniem. */
export interface PushEnvelope {
  readonly kid: string;
  /** base64url nonce (12 B → 16 znaków). */
  readonly n: string;
  /** base64url (szyfrogram‖tag), bez dopełnienia. */
  readonly c: string;
}

/**
 * Klucz banera z `pushKey` (HKDF-SHA256, sól pusta, info {@link PUSH_KEY_INFO_V3}). `pushKey` innej długości niż 32 B
 * po zdekodowaniu to błąd (rekord `devices.json` z taką wartością nie przechodzi odczytu, więc tu go nie ma).
 */
export function deriveBannerKey(pushKey: string): Buffer {
  const ikm = Buffer.from(pushKey, 'base64url');
  if (ikm.length !== PUSH_KEY_BYTES || ikm.toString('base64url') !== pushKey) {
    throw new Error('push-crypto: klucz push nie jest 32 bajtami base64url');
  }
  const info = Buffer.from(PUSH_KEY_INFO_V3, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, PUSH_KEY_BYTES));
}

/** AAD koperty: UTF-8 `rarog-push/3|<kid>`. */
export function pushAad(kid: string): Buffer {
  return Buffer.from(`${PUSH_AAD_PREFIX_V3}${kid}`, 'utf8');
}

/**
 * Tekst jawny → bajty z dopełnieniem spacjami do wielokrotności {@link PUSH_PLAINTEXT_BUCKET_BYTES}, najwyżej do
 * {@link PUSH_PLAINTEXT_MAX_BYTES}. Tekst dłuższy niż sufit (patologiczny `sessionId`, którego przycięcie tytułu
 * i treści nie zmieściło) zostaje bez dopełnienia — o wysyłce rozstrzyga limit całego ładunku po szyfrowaniu.
 */
export function padPlaintext(json: string): Buffer {
  const raw = Buffer.from(json, 'utf8');
  if (raw.length >= PUSH_PLAINTEXT_MAX_BYTES) return raw;
  const bucket = Math.max(1, Math.ceil(raw.length / PUSH_PLAINTEXT_BUCKET_BYTES)) * PUSH_PLAINTEXT_BUCKET_BYTES;
  const target = Math.min(bucket, PUSH_PLAINTEXT_MAX_BYTES);
  return Buffer.concat([raw, Buffer.alloc(target - raw.length, 0x20)]);
}

/** Szyfrowanie koperty kluczem jednego urządzenia. */
export interface PushSealer {
  /** JSON tekstu jawnego (już przycięty) → koperta `{kid, n, c}`. Rzuca przy złym kluczu albo `kid`. */
  seal(key: DevicePushKey, plaintextJson: string): PushEnvelope;
}

export interface PushSealerOptions {
  /**
   * Źródło nonce — WYŁĄCZNIE testy (złote ramki, wektory). Brak = `randomBytes(12)` per wiadomość: przy ~115
   * banerach na dobę kolizja 96-bitowego nonce jest pomijalna.
   */
  readonly nonce?: () => Buffer;
}

/** Fabryka szyfrowania kopert; produkcja woła ją bez opcji. */
export function createPushSealer(options: PushSealerOptions = {}): PushSealer {
  const nextNonce = options.nonce ?? ((): Buffer => randomBytes(PUSH_NONCE_BYTES));
  return {
    seal(key, plaintextJson): PushEnvelope {
      if (!KID_RE.test(key.kid)) throw new Error('push-crypto: kid spoza 8 znaków hex');
      const nonce = nextNonce();
      if (nonce.length !== PUSH_NONCE_BYTES) throw new Error('push-crypto: nonce nie ma 12 bajtów');
      const plaintext = padPlaintext(plaintextJson);
      const cipher = createCipheriv('chacha20-poly1305', deriveBannerKey(key.pushKey), nonce, {
        authTagLength: PUSH_TAG_BYTES,
      });
      cipher.setAAD(pushAad(key.kid), { plaintextLength: plaintext.length });
      const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return { kid: key.kid, n: nonce.toString('base64url'), c: sealed.toString('base64url') };
    },
  };
}
