/**
 * Rytm automatów dialogowych fasady drivera: czekanie na kanał hooka, ponowne oceny po własnej cyfrze,
 * osłony po decyzji, rezerwa formularza i rezerwa z rejestru CLI.
 *
 * Same liczby z uzasadnieniem pomiaru — zegar i stan trzyma fasada `drivers/herdr-driver.ts`.
 */

/** Ile Rarog czeka na zużycie pliku odpowiedzi przez hook, zanim wróci na tor cyfry. */
export const HOOK_ANSWER_WAIT_MS = 3000;

/** Odstęp sprawdzania, czy hook zużył plik — ten sam rytm, w którym hook go czyta. */
export const HOOK_ANSWER_POLL_MS = 250;

/**
 * Odstępy ponownej oceny po WŁASNEJ cyfrze w dialog z ekranu (zmierzone).
 *
 * Formularz `AskUserQuestion` z kilkoma pytaniami po odpowiedzi przełącza zakładkę W MIEJSCU:
 * klatki ekranu co 400 ms pokazały czystą podmianę treści, a `agent_status` herdr został
 * `blocked` bez ani jednego mignięcia — więc `#onStatus` nie strzela i karta drugiego pytania
 * nigdy nie powstawała (telefon spadał do „odpowiedz w terminalu"). Po własnej cyfrze Rarog
 * ponawia ocenę SAM: dwie próby, bo pierwsza może trafić w środek przemalowania TUI.
 */
export const SCREEN_ANSWER_REARM_DELAYS_MS: readonly number[] = [600, 1600];

/**
 * Jak długo osłona po odpowiedzi plikiem ma prawo gasić karty.
 *
 * Osłona (`answeredHookCall`) zakrywa okno między `allow` z hooka a przyjściem `tool_result`
 * do jsonl — czyli chwilę, w której `pending` dalej opisuje formularz JUŻ odpowiedziany.
 * Gdyby kończyła ją wyłącznie nowa blokada, DRUGIE wywołanie o identycznej treści w tej samej
 * turze nie dostałoby karty już nigdy (telefon milczy, a w dzienniku nie ma nawet odmowy).
 * Granicą jest przede wszystkim GENERACJA zrzutu hooka (nowy
 * `answerKey` = nowe wywołanie), a ten limit to siatka pod nią: zrzut potrafi nie powstać
 * (killswitch, błąd zapisu) i wtedy osłona musi wygasnąć sama.
 *
 * Wartość: `tool_result` dochodzi do jsonl w ułamku sekundy, follower dokłada debounce
 * (800 ms), a ponowna ocena po odpowiedzi ma dwa obroty (600/1600 ms) — 8 s to kilkukrotny
 * zapas. Dłużej osłona chowałaby raczej nowy dialog, niż chroniła stary.
 */
export const ANSWERED_HOOK_SHIELD_MS = 8000;

/**
 * Termin osłony po WŁASNEJ decyzji cyfrą albo `escape` — ten sam rachunek co
 * {@link ANSWERED_HOOK_SHIELD_MS}: osłona ma przykryć okno do `working` z herdr albo nowego wpisu jsonl,
 * a nie chować następny dialog. Zgubiona cyfra (dialog dalej stoi) wraca na telefon najpóźniej po tym
 * czasie i obrocie zegara oceny.
 */
export const DECIDED_SHIELD_MS = 8000;

/**
 * Pauza między cyfrą a odczytem weryfikującym w formularzu z preview.
 *
 * Cyfra w tym wariancie tylko przesuwa podświetlenie, a TUI przemalowuje je z opóźnieniem —
 * odczyt „od razu" potrafi zobaczyć stan sprzed cyfry i uczciwie odmówić `enter`, choć wybór
 * zdążyłby się udać. Pauza jest jedna (bez ponawiania): `enter` idzie najwyżej raz, więc
 * i dowód zbieramy raz.
 */
export const FORM_SUBMIT_CONFIRM_DELAY_MS = 500;

/**
 * Ponowienia próby WEJŚCIA w rezerwę formularza, liczone od oceny, która ją zaczęła.
 *
 * Wpis `tool_use` i zrzut hooka potrafią wyprzedzić render formularza, a herdr zgłasza `done`
 * dopiero, gdy ekran przestanie się ruszać — pierwszy odczyt bywa więc za wczesny. Dwa
 * ponowienia wystarczają na render; więcej byłoby już pętlą nad osieroconym `tool_use`.
 */
export const FORM_FALLBACK_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/**
 * Ile KOLEJNYCH odczytów „formularza nie ma" gasi rezerwę.
 *
 * Jeden nie wystarcza: resize panelu albo odczyt trafiony w przemalowanie parsuje się
 * jak ekran bez dialogu, a rezerwa zgaszona fałszywie nie wraca — formularz dalej stoi, więc
 * nie przyjdzie ani zmiana statusu, ani zmiana wpisu w jsonl, które mogłyby ją wskrzesić.
 */
export const FORM_FALLBACK_MISSES = 2;

/**
 * Ile prób WEJŚCIA w rezerwę z rejestru CLI dostaje jeden epizod `waiting`.
 *
 * Próba to jeden świeży odczyt ekranu, a szturchnięcia przychodzą z szybkiego tiku managera
 * (co 1,5 s): cztery próby to ~6 s na dorysowanie dialogu. Więcej byłoby pętlą odczytów nad
 * rejestrem, który stoi na `waiting` z innego powodu niż dialog na ekranie. Nowy epizod —
 * nowe wejście w `waiting` albo zmiana klasy — dostaje nowy budżet.
 */
export const CLI_WAITING_PROBES = 4;

/**
 * Ile KOLEJNYCH odczytów z polem promptu na ekranie zdejmuje rezerwę z rejestru.
 * Ta sama reguła co {@link FORM_FALLBACK_MISSES} (jeden odczyt to nie dowód).
 */
export const CLI_HOLD_MISSES = 2;

/**
 * Sufit kroku trybu cienia przed klawiszem zgody albo odmowy (`RAROG_CONSENT_CHANNEL=shadow`). Krok czyta zrzuty
 * sesji i pyta `ps` o życie hooków (zwykle kilkanaście ms); po tym czasie driver przestaje czekać, kanał już
 * pliku nie pisze, a klawisz idzie jak przy `off`. Sufit `ps` w kanale jest krótszy (200 ms).
 */
export const SHADOW_DEADLINE_MS = 250;
