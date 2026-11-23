/**
 * Wymiana STAŁEGO klucza Soniox na klucz TYMCZASOWY.
 *
 * Cała treść tego modułu sprowadza się do jednego zdania: **klucz stały nie opuszcza
 * Maca**. Audio leci z telefonu prosto do UE (Rarog nie ma serwera WebSocket i nie będzie go
 * miał), więc jedyne, co przechodzi przez backend, to krótki bilet wstępu:
 * 60 s na OTWARCIE strumienia, `single_use`, sesja ≤ 15 min, losowy `client_reference_id`.
 *
 * Czego ten moduł świadomie NIE robi:
 * - nie retryuje (użytkownik tapnie mikrofon ponownie — retry w pętli to najprostsza droga
 *   do wyczerpania limitu konta, a nie do udanego dyktowania),
 * - nie loguje ANI JEDNEGO bajtu odpowiedzi Soniox: pole `api_key` w tej odpowiedzi NIE jest
 *   łapane przez `SENSITIVE_KEY_PARTS` po nazwie snake_case, więc jedyną bezpieczną regułą
 *   jest „ciało upstreamu nie istnieje dla logu",
 * - nie przepuszcza treści błędu Soniox do klienta (komunikaty są nasze, po polsku).
 *
 * The same minter makes a second kind of key ({@link SonioxKeyKind}): the voice agent's speech key behind
 * `POST /api/companion/speech-token`, a plain (not `single_use`) `tts_rt` key that opens new speech streams
 * for 600 s, each stream at most 180 s. Each kind has its own throttle instance; the pinned EU host, the region
 * check, the log rules and the mapping of Soniox statuses are shared.
 */
import { randomBytes } from 'node:crypto';
import type { VoiceToken } from '@rarog/shared';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import {
  COMPANION_SPEECH_THROTTLED_ERROR, COMPANION_SPEECH_UNCONFIGURED_ERROR, COMPANION_SPEECH_UPSTREAM_ERROR,
} from '@rarog/shared/rest';
import type { CompanionSpeechToken, ServerSystem } from '@rarog/shared/rest';
import { serverSystem } from '../version.ts';

/**
 * Host REST **pinowany w kodzie**, nie brany z env.
 *
 * Klucz z projektu UE działa WYŁĄCZNIE na endpointach UE (US → 401). `SONIOX_API_HOST`
 * ze środowiska serwera jest więc tylko SPRAWDZANY — gdyby kiedyś
 * wskazywał inny region, znaczy to, że w env siedzi klucz spoza UE i mint musi odmówić,
 * a nie po cichu wysłać go do innej jurysdykcji.
 */
export const SONIOX_API_ORIGIN = 'https://api.eu.soniox.com';

/** Hostname wyprowadzony z {@link SONIOX_API_ORIGIN} — do porównania z `SONIOX_API_HOST`. */
export const SONIOX_API_HOSTNAME = 'api.eu.soniox.com';

/** Endpoint kluczy tymczasowych (według docs Soniox). */
export const SONIOX_TEMP_KEY_PATH = '/v1/auth/temporary-api-key';

/** Strumień RT w regionie UE — adres jedzie do klienta razem z kluczem, nie jest zgadywany. */
export const SONIOX_WEBSOCKET_URI = 'wss://stt-rt.eu.soniox.com/transcribe-websocket';

/**
 * Model RT. Jedzie do apki w `VoiceToken`, więc zmiana modelu obejmuje też starsze buildy apki.
 * v6 jest zgodny z API v5 (docs Soniox, „Models”); `stt-rt-v5` Soniox usuwa 15.12.2026.
 */
export const SONIOX_RT_MODEL = 'stt-rt-v6';

/** `usage_type` of the dictation key: speech-to-text streams only. */
export const SONIOX_USAGE_TYPE = 'transcribe_websocket';

/** Ile klucz żyje. Dotyczy OTWARCIA strumienia, nie czasu trwania sesji. */
export const VOICE_TOKEN_EXPIRES_IN_SECONDS = 60;

/** Sufit długości jednej sesji dyktowania (15 min) — pilnowany też po stronie Soniox. */
export const VOICE_MAX_SESSION_SECONDS = 900;

/** Timeout jednego mintu. Zero retry: dłuższe czekanie to zawieszony przycisk mikrofonu. */
export const VOICE_MINT_TIMEOUT_MS = 5_000;

/**
 * Format audio strumienia RT: surowy PCM 16-bit little endian.
 *
 * Docs Soniox (tabela formatów surowych) podają nazwę formatu
 * w konfiguracji strumienia: `pcm_s16le`, nie `s16le`.
 * Surowy PCM omija całą klasę problemów z `MediaRecorder` na iOS (mp4/m4a nie ma na liście
 * formatów auto-detekcji).
 */
export const VOICE_AUDIO_FORMAT = 'pcm_s16le';

/** 16 kHz mono — tyle, ile daje AudioWorklet po resamplingu, i tyle, ile model potrzebuje. */
export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_NUM_CHANNELS = 1;

/**
 * Podpowiedzi językowe: polski z wtrąceniami angielskimi.
 *
 * `language_hints_strict` zostaje wyłączone po stronie klienta — twarde ograniczenie do dwóch
 * języków psułoby nazwy własne, a to jest dyktowanie promptów do agenta kodującego.
 */
export const VOICE_LANGUAGE_HINTS: readonly string[] = ['pl', 'en'];

/** Kody błędów endpointu — te same stringi widzi klient. */
export const VOICE_UNCONFIGURED = 'voice_unconfigured';
export const VOICE_UPSTREAM = 'voice_upstream';
export const VOICE_THROTTLED = 'voice_throttled';

/**
 * Zdania odmowy mintu. Trzy z nich mówią, na której maszynie poprawić klucz: słowo maszyny jak w apce
 * (`ServerMachine`), macOS to Mac, każdy inny system to VPS.
 */
const machineMessages = (system: ServerSystem): {
  readonly disabled: ServerSentence; readonly foreignRegion: ServerSentence; readonly keyRejected: ServerSentence;
} => (system === 'macos'
  ? {
    disabled: say('rest.voice-disabled.mac'),
    foreignRegion: say('rest.voice-foreign-region.mac'),
    keyRejected: say('rest.voice-key-rejected.mac'),
  }
  : {
    disabled: say('rest.voice-disabled.vps'),
    foreignRegion: say('rest.voice-foreign-region.vps'),
    keyRejected: say('rest.voice-key-rejected.vps'),
  });
const MESSAGE_UPSTREAM = say('rest.voice-upstream');
const MESSAGE_THROTTLED = say('rest.voice-throttled');

/** Refusal sentences of one kind of key. `keyMissing` and `disabled` may be the same sentence. */
export interface SonioxRefusalSentences {
  readonly disabled: ServerSentence;
  readonly keyMissing: ServerSentence;
  readonly foreignRegion: ServerSentence;
  readonly keyRejected: ServerSentence;
  readonly upstream: ServerSentence;
  readonly throttled: ServerSentence;
}

/**
 * One kind of temporary key: what the minter asks Soniox for, the error codes and sentences of its refusals and the
 * token the client gets. The stream parameters in the token are pinned in the kind, never taken from Soniox.
 */
export interface SonioxKeyKind<T> {
  readonly usageType: 'transcribe_websocket' | 'tts_rt';
  /** How long the key opens NEW streams (`expires_in_seconds`). */
  readonly expiresInSeconds: number;
  readonly singleUse: boolean;
  /** Ceiling of one stream (`max_session_duration_seconds`). */
  readonly maxSessionSeconds: number;
  /** Prefix of the log lines. */
  readonly logPrefix: string;
  readonly errors: { readonly unconfigured: string; readonly upstream: string; readonly throttled: string };
  /** Sentences for the server machine's system (the machine word, where a sentence has one). */
  readonly sentences: (system: ServerSystem) => SonioxRefusalSentences;
  readonly token: (key: { readonly apiKey: string; readonly expiresAt: string }) => T;
}

/**
 * Wynik mintu w kształcie gotowym dla routera.
 *
 * Świadomie dyskryminowana unia, a nie wyjątki: każda gałąź niesie WŁASNY status HTTP
 * i WŁASNE zdanie, więc router nie mapuje niczego po nazwie klasy błędu i nie ma
 * gdzie zgubić „503 zamiast 500" (brak klucza nigdy nie jest błędem serwera).
 */
export type SonioxMintResult<T> =
  | { readonly ok: true; readonly token: T }
  | {
    readonly ok: false;
    readonly status: 429 | 502 | 503;
    readonly error: string;
    readonly sentence: ServerSentence;
  };

/** Result of a dictation mint (`POST /api/voice/token`). */
export type MintResult = SonioxMintResult<VoiceToken>;

/** Minimalny podzbiór `fetch`, którego ten moduł używa — tyle wstrzykują testy. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface VoiceMinterOptions {
  /** Stały klucz z env. Brak (albo pusty) = funkcja wyłączona, nie błąd. */
  readonly apiKey?: string | undefined;
  /** `SONIOX_API_HOST` z env — tylko do sprawdzenia regionu; host i tak jest pinowany. */
  readonly apiHost?: string | undefined;
  /**
   * The feature switch: `RAROG_VOICE` for dictation; for the speech key the rest of the voice agent's gate
   * (`RAROG_COMPANION`, the module and the OpenAI key). `false` refuses without looking at the key.
   */
  readonly enabled?: boolean;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  /** Losowy `client_reference_id`; wstrzykiwalny, żeby test widział, że jest inny za każdym razem. */
  readonly randomId?: () => string;
  readonly minIntervalMs: number;
  readonly hourlyCap: number;
  readonly timeoutMs?: number;
  /** System maszyny serwera (`serverSystem`): słowo maszyny w zdaniach o kluczu. Brak = system procesu. */
  readonly system?: ServerSystem;
  /**
   * Log diagnostyczny. Dostaje WYŁĄCZNIE status odpowiedzi i `expiresAt` — nigdy klucza,
   * nigdy ciała odpowiedzi, nigdy `client_reference_id` (ten jest losowy, ale i tak jedzie
   * do strony trzeciej i nie ma powodu, żeby leżał w dwóch miejscach).
   */
  readonly log?: (message: string) => void;
}

export interface SonioxKeyMinter<T> {
  /** Jedna operacja modułu: wymień klucz stały na tymczasowy. */
  mint(): Promise<SonioxMintResult<T>>;
  /** The kind is configured: the switch ({@link VoiceMinterOptions.enabled}), a key and the EU region. */
  readonly available: boolean;
}

/** Dictation minter (`POST /api/voice/token`); `available` = key + `RAROG_VOICE` + region. */
export type VoiceMinter = SonioxKeyMinter<VoiceToken>;

/**
 * Speech key minter of the voice agent (`POST /api/companion/speech-token`); its `available` completes the voice
 * agent's gate (`companionEnabled`, `companionSpeech`).
 */
export type SpeechKeyMinter = SonioxKeyMinter<CompanionSpeechToken>;

/** Dictation: one `single_use` speech-to-text key per connection attempt. */
export const DICTATION_KEY: SonioxKeyKind<VoiceToken> = {
  usageType: SONIOX_USAGE_TYPE,
  expiresInSeconds: VOICE_TOKEN_EXPIRES_IN_SECONDS,
  singleUse: true,
  maxSessionSeconds: VOICE_MAX_SESSION_SECONDS,
  logPrefix: 'voice',
  errors: { unconfigured: VOICE_UNCONFIGURED, upstream: VOICE_UPSTREAM, throttled: VOICE_THROTTLED },
  sentences: (system) => {
    const machine = machineMessages(system);
    return { ...machine, keyMissing: machine.disabled, upstream: MESSAGE_UPSTREAM, throttled: MESSAGE_THROTTLED };
  },
  token: ({ apiKey, expiresAt }) => ({
    apiKey,
    expiresAt,
    webSocketUri: SONIOX_WEBSOCKET_URI,
    model: SONIOX_RT_MODEL,
    maxSessionSeconds: VOICE_MAX_SESSION_SECONDS,
    config: {
      languageHints: [...VOICE_LANGUAGE_HINTS],
      audioFormat: VOICE_AUDIO_FORMAT,
      sampleRate: VOICE_SAMPLE_RATE,
      numChannels: VOICE_NUM_CHANNELS,
    },
  }),
};

// ---------------------------------------------------------------------------
// Voice agent speech: the agent's replies read by Soniox text-to-speech
// ---------------------------------------------------------------------------

/** `usage_type` of the speech key: text-to-speech streams only. */
export const SONIOX_TTS_USAGE_TYPE = 'tts_rt';

/** Text-to-speech WebSocket in the EU region; it goes to the client with the key. */
export const SONIOX_TTS_WEBSOCKET_URI = 'wss://tts-rt.eu.soniox.com/tts-websocket';

/** Text-to-speech model of the voice agent. */
export const SONIOX_TTS_MODEL = 'tts-rt-v2';

/** The one voice of the voice agent; the OpenAI voice choice stays for the OpenAI voice. */
export const COMPANION_SPEECH_VOICE = 'Maya';

/** Sample rate of the speech audio: the rate the app's player takes (24 kHz s16le). */
export const COMPANION_SPEECH_SAMPLE_RATE = 24_000;

/**
 * How long one speech key opens new streams: one key per conversation, so 10 min; the app takes a new one when the
 * expiry is near. An open stream is not cut when the key expires.
 */
export const COMPANION_SPEECH_EXPIRES_IN_SECONDS = 600;

/** Ceiling of one speech stream (one reply), and of what a stolen key gets out of one stream. */
export const COMPANION_SPEECH_MAX_STREAM_SECONDS = 180;

/** The voice agent's speech: one plain `tts_rt` key per conversation, many streams while it is valid. */
export const COMPANION_SPEECH_KEY: SonioxKeyKind<CompanionSpeechToken> = {
  usageType: SONIOX_TTS_USAGE_TYPE,
  expiresInSeconds: COMPANION_SPEECH_EXPIRES_IN_SECONDS,
  singleUse: false,
  maxSessionSeconds: COMPANION_SPEECH_MAX_STREAM_SECONDS,
  logPrefix: 'companion speech',
  errors: {
    unconfigured: COMPANION_SPEECH_UNCONFIGURED_ERROR,
    upstream: COMPANION_SPEECH_UPSTREAM_ERROR,
    throttled: COMPANION_SPEECH_THROTTLED_ERROR,
  },
  sentences: () => ({
    disabled: say('rest.companion-speech-disabled'),
    keyMissing: say('rest.companion-speech-key-missing'),
    foreignRegion: say('rest.companion-speech-foreign-region'),
    keyRejected: say('rest.companion-speech-key-rejected'),
    upstream: say('rest.companion-speech-upstream'),
    // The same meaning as the throttle of the OpenAI key: the conversation starts too soon.
    throttled: say('rest.companion-throttled'),
  }),
  token: ({ apiKey, expiresAt }) => ({
    apiKey,
    expiresAt,
    webSocketUri: SONIOX_TTS_WEBSOCKET_URI,
    model: SONIOX_TTS_MODEL,
    voice: COMPANION_SPEECH_VOICE,
    sampleRate: COMPANION_SPEECH_SAMPLE_RATE,
  }),
};

const HOUR_MS = 3_600_000;

/**
 * Normalizuje `SONIOX_API_HOST` do samego hostname'u.
 *
 * Wartość w środowisku serwera bywa zapisana i jako `https://api.eu.soniox.com`, i jako goły host —
 * obie postaci znaczą to samo i obie muszą przejść. Cokolwiek innego traktujemy jak rozjazd
 * regionu, bo zgadywanie tu kosztuje 401 przy pierwszym dyktowaniu.
 */
export function sonioxHostname(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Czy podany `SONIOX_API_HOST` wskazuje na region UE (pusty = brak deklaracji = OK). */
export function isEuHost(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return sonioxHostname(raw) === SONIOX_API_HOSTNAME;
}

/** Kształt odpowiedzi endpointu (201): tylko te dwa pola nas obchodzą. */
function readTempKey(payload: unknown): { apiKey: string; expiresAt: string } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const apiKey = record['api_key'];
  const expiresAt = record['expires_at'];
  if (typeof apiKey !== 'string' || apiKey === '') return null;
  if (typeof expiresAt !== 'string' || expiresAt === '') return null;
  return { apiKey, expiresAt };
}

/**
 * Tworzy minter kluczy tymczasowych.
 *
 * Throttle siedzi TUTAJ, a nie w routerze, z tego samego powodu, dla którego throttle
 * zakładania paneli siedzi w managerze: chroni zasób (limit konta Soniox: 100 req/min,
 * 10 równoległych sesji), a nie endpoint. Jeden zapętlony reconnect na telefonie potrafi
 * bez niego wyczerpać limit całego konta w kilkadziesiąt sekund.
 *
 * Without `kind` the minter makes dictation keys ({@link DICTATION_KEY}); {@link COMPANION_SPEECH_KEY} makes the
 * voice agent's speech keys. Every call is a new minter with its own throttle.
 */
export function createVoiceMinter(opts: VoiceMinterOptions): VoiceMinter;
export function createVoiceMinter<T>(opts: VoiceMinterOptions, kind: SonioxKeyKind<T>): SonioxKeyMinter<T>;
export function createVoiceMinter(
  opts: VoiceMinterOptions, kind: SonioxKeyKind<unknown> = DICTATION_KEY,
): SonioxKeyMinter<unknown> {
  const apiKey = opts.apiKey?.trim() ?? '';
  const enabled = opts.enabled ?? true;
  const euRegion = isEuHost(opts.apiHost);
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? (() => Date.now());
  const randomId = opts.randomId ?? (() => randomBytes(8).toString('hex'));
  const timeoutMs = opts.timeoutMs ?? VOICE_MINT_TIMEOUT_MS;
  const log = opts.log;
  const refusals = kind.sentences(opts.system ?? serverSystem());
  const { errors, logPrefix } = kind;

  /** Znaczniki udanych PRÓB mintu (nie sukcesów) — okno godzinne, filtrowane leniwie. */
  let mints: number[] = [];

  function takeSlot(): boolean {
    const at = now();
    const last = mints[mints.length - 1];
    if (last !== undefined && at - last < opts.minIntervalMs) return false;
    mints = mints.filter((ts) => at - ts < HOUR_MS);
    if (mints.length >= opts.hourlyCap) return false;
    mints.push(at);
    return true;
  }

  function fail(
    status: 429 | 502 | 503, error: string, sentence: ServerSentence,
  ): { ok: false; status: 429 | 502 | 503; error: string; sentence: ServerSentence } {
    return { ok: false, status, error, sentence };
  }

  async function mint(): Promise<SonioxMintResult<unknown>> {
    if (!enabled) return fail(503, errors.unconfigured, refusals.disabled);
    if (apiKey === '') return fail(503, errors.unconfigured, refusals.keyMissing);
    if (!euRegion) return fail(503, errors.unconfigured, refusals.foreignRegion);
    // Slot bierzemy PRZED wyjściem na sieć: throttle ma chronić limit konta także wtedy,
    // gdy każda próba kończy się błędem (a właśnie wtedy klient próbuje najczęściej).
    if (!takeSlot()) return fail(429, errors.throttled, refusals.throttled);

    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await doFetch(`${SONIOX_API_ORIGIN}${SONIOX_TEMP_KEY_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          usage_type: kind.usageType,
          expires_in_seconds: kind.expiresInSeconds,
          single_use: kind.singleUse,
          max_session_duration_seconds: kind.maxSessionSeconds,
          // LOSOWY na każdy mint. `sessionIdFor` jest stabilny między restartami, więc
          // wysyłanie go stronie trzeciej dałoby jej trwały identyfikator konkretnej sesji
          // użytkownika — bez najmniejszego pożytku dla nas.
          client_reference_id: randomId(),
        }),
        signal: controller.signal,
      });

      // 401/403 to NIE jest awaria Soniox, tylko zła konfiguracja na Macu — 503 z komunikatem,
      // który mówi, co poprawić, zamiast 502 „spróbuj za chwilę" w nieskończoność.
      if (response.status === 401 || response.status === 403) {
        log?.(`${logPrefix}: Soniox refused the key (${String(response.status)})`);
        return fail(503, errors.unconfigured, refusals.keyRejected);
      }
      if (response.status < 200 || response.status >= 300) {
        log?.(`${logPrefix}: Soniox request failed (${String(response.status)})`);
        return fail(502, errors.upstream, refusals.upstream);
      }

      const parsed = readTempKey(await response.json());
      if (parsed === null) {
        // Świadomie bez treści odpowiedzi w logu — to jest dokładnie to ciało, w którym
        // siedzi `api_key`.
        log?.(`${logPrefix}: Soniox response without a temporary key`);
        return fail(502, errors.upstream, refusals.upstream);
      }

      log?.(`${logPrefix}: temporary key valid until ${parsed.expiresAt}`);
      return { ok: true, token: kind.token(parsed) };
    } catch {
      // Timeout albo brak sieci. Treść wyjątku nie idzie do logu: niósłby URL z nagłówkami
      // w niektórych implementacjach fetch, a wartości diagnostycznej ma tu zero.
      log?.(`${logPrefix}: Soniox unreachable (timeout or no network)`);
      return fail(502, errors.upstream, refusals.upstream);
    } finally {
      clearTimeout(timer);
    }
  }

  return { mint, available: enabled && apiKey !== '' && euRegion };
}
