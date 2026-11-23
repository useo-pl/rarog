/**
 * Dictation: the limits on temporary Soniox keys and the dictation killswitch.
 */

/*
 * Stałe kanału DYKTOWANIA. Chronią limit KONTA Soniox (100 req/min, 10 równoległych
 * sesji), a nie endpoint Raroga — dlatego są tutaj, obok bezpieczników herdr, a nie w env.
 */

/** Jeden klucz tymczasowy na 3 s: zapętlony reconnect na telefonie nie wyczerpie limitu konta. */
export const VOICE_TOKEN_MIN_INTERVAL_MS = 3_000;

/** Sufit mintów w oknie godzinnym. 60 to ~godzina dyktowania z rekonektami, nie pętla w kodzie. */
export const VOICE_TOKEN_HOURLY_CAP = 60;

/**
 * Killswitch dyktowania. Domyślnie `true` — tu asymetria wobec `parseHerdrLaunch` jest równie
 * celowa: mikrofon nie uruchamia procesów i nie pisze do cudzych paneli, a przy braku klucza
 * i tak jest wyłączony przez `voiceEnabled`.
 */
export function parseVoiceEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}
