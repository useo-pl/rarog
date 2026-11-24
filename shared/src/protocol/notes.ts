/**
 * Protocol contract, project notes area: `/api/notes` and the `notes` SSE frame (`NotesEvent`).
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';
import { type SentenceRef, sentenceRefSchema } from '../sentences/index.ts';

// ---------------------------------------------------------------------------
// Notatki projektu — kontrakt `/api/notes`
// ---------------------------------------------------------------------------

/*
 * Notatki wiszą na PROJEKCIE (`cwd`), nie na sesji i nie na agencie: sesje przychodzą i giną,
 * a „pamiętaj, że deploy wymaga restartu herdr" dotyczy katalogu i przeżywa je wszystkie.
 * Rarog trzyma WYŁĄCZNIE TEKST — audio dyktowania nie dociera do serwera ani na dysk,
 * a notatek nie widzi żadna sesja Claude: to jest notes dla człowieka, nie kanał kontekstu.
 *
 * A project has ONE document, not a list of entries (a popup with one large text area). The store
 * (`server/src/notes/store.ts`) reads and joins files in the old list shape, so the network contract
 * knows only `{text, updatedAt}`.
 */

/**
 * Sufit dokumentu notatek w znakach.
 *
 * 48 kB to kilkanaście ekranów tekstu — więcej, niż ktokolwiek podyktuje i przeczyta w jednym
 * projekcie, a wciąż na tyle mało, że plik mieści się w pamięci i w jednym `writeFileSync`
 * (read-modify-write całości jest ceną KAŻDEGO zapisu). Sufit stoi z zapasem pod kopertę JSON,
 * żeby ciało żądania trzymało się limitu 64 kB, który router narzuca wszystkim POST-om i PUT-om.
 * Przekroczenie to 400 z bramki ciała, nigdy ciche przycięcie: dokument ucięty w połowie zdania
 * jest gorszy niż odmowa zapisania go w całości.
 */
export const NOTES_MAX_CHARS = 48 * 1024;

/**
 * Sufit CIAŁA `PUT /api/notes` w bajtach — jedyny endpoint z własnym limitem zamiast globalnych
 * 64 kB (`MAX_BODY_BYTES`).
 *
 * Powód jest arytmetyczny, nie ambicjonalny: {@link NOTES_MAX_CHARS} liczy ZNAKI, a ciało jedzie
 * w UTF-8. Polskie „ę" to dwa bajty, emoji cztery — dokument w granicach kontraktu potrafi więc
 * ważyć wielokrotność swojej długości i odbijałby się od globalnego limitu jako 413, czyli
 * odmową bez zdania o powodzie, zanim schemat zdążyłby powiedzieć „za długie". 256 kB mieści
 * najgorszy przypadek (48 k znaków × 4 bajty) z zapasem na kopertę JSON.
 */
export const NOTES_BODY_MAX_BYTES = 256 * 1024;

/**
 * Dokument notatek jednego projektu.
 *
 * `updatedAt` jest zarazem WERSJĄ: `PUT /api/notes` niesie wartość odczytaną przy wejściu
 * w popup, a serwer odmawia (409), gdy na dysku stoi już inna. Bez tego dwa urządzenia gubią
 * sobie zmiany po cichu — a notatki są jedyną treścią w Rarogu, której nikt nie odtworzy
 * z transkryptu. `updatedAt: 0` znaczy „na dysku nie ma jeszcze niczego".
 */
export interface NotesDoc {
  text: string;
  updatedAt: number;
}

export const notesDocSchema = z.object({
  text: z.string(),
  updatedAt: z.number(),
});

type _NotesDocSchemaMatchesType = z.infer<typeof notesDocSchema> extends NotesDoc ? true : never;
type _NotesDocTypeMatchesSchema = NotesDoc extends z.infer<typeof notesDocSchema> ? true : never;
const _notesDocSchemaMatchesType: _NotesDocSchemaMatchesType = true;
const _notesDocTypeMatchesSchema: _NotesDocTypeMatchesSchema = true;
void _notesDocSchemaMatchesType;
void _notesDocTypeMatchesSchema;

/** Odpowiedź `GET /api/notes?cwd=` — cały dokument; brak pliku to `{text: '', updatedAt: 0}`. */
export const notesGetResponseSchema = notesDocSchema;

/**
 * Czy dokument jest PUSTY w sensie, w jakim widzi to człowiek: sam biały znak (enter zostawiony
 * po skasowaniu treści, spacja po dyktowaniu) to wciąż brak notatki. JEDNA definicja dla
 * serwera (bit `empty` w evencie `notes`) i frontu (sonda pigułki ✎ po `GET`), bo obie strony
 * zapalają ten sam kolor — gdyby liczyły inaczej, pigułka gasłaby po evencie i zapalała się po
 * odczycie tego samego dokumentu.
 */
export function notesEmpty(text: string): boolean {
  return text.trim() === '';
}

/**
 * Ciało `PUT /api/notes` — zapis całego dokumentu.
 *
 * `text` wolno mieć PUSTY i to jest różnica względem listy notatek: wyczyszczenie pola jest
 * teraz jedyną drogą do skasowania treści (przycisku „Usuń" nie ma), więc pusty napis to
 * zamiar człowieka, a nie błąd klienta.
 *
 * `updatedAt` to WERSJA, którą klient miał na ekranie. Niezgodność ze stanem na dysku kończy
 * się 409 z AKTUALNYM dokumentem w odpowiedzi ({@link NotesConflictBody}) — żeby człowiek
 * zobaczył, co napisało drugie urządzenie, i mógł świadomie wybrać, a nie zgadywać, co zniknęło.
 */
export const notesPutBodySchema = z.object({
  cwd: z.string().min(1),
  text: z.string().max(NOTES_MAX_CHARS),
  updatedAt: z.number(),
});

/**
 * Odpowiedź `PUT /api/notes` — SAM nowy znacznik wersji.
 *
 * Tekstu w niej nie ma świadomie: klient właśnie go wysłał i ma go pod palcem, a odsyłanie
 * 48 kB z powrotem przy każdym autosave byłoby ruchem, którego nikt nie czyta.
 */
export const notesPutResponseSchema = z.object({ updatedAt: z.number() });

/**
 * Ciało 409 przy rozjeździe wersji. `current` to stan Z DYSKU — jedyna rzecz, którą klient może
 * postawić obok swojego tekstu, żeby wybór „nadpisz / wczytaj tamtą" był wyborem, a nie loterią.
 */
export interface NotesConflictBody {
  error: 'conflict';
  message: string;
  /** Kod zdania `message`. */
  messageRef?: SentenceRef;
  current: NotesDoc;
}

export const notesConflictBodySchema = z.object({
  error: z.literal('conflict'),
  message: z.string(),
  messageRef: sentenceRefSchema.optional(),
  current: notesDocSchema,
});

/**
 * Notatki PROJEKTU się zmieniły — ktoś dodał, poprawił albo skasował notatkę (`ServerEvent` member).
 *
 * Event ULOTNY i GLOBALNY, dokładnie jak `herdr-status`: `seq: null`, poza ring bufferem
 * którejkolwiek sesji. Notatka nie należy do żadnej sesji, więc nie ma tu czego replayować,
 * a stan startowy widok bierze z `GET /api/notes` przy wejściu.
 *
 * TREŚCI W RAMCE NIE MA i to jest decyzja, nie oszczędność: ramka jedzie do KAŻDEGO
 * otwartego klienta, także takiego, który stoi w zupełnie innym projekcie. Jedyne, co niesie,
 * to „w tym katalogu coś się zmieniło" — kto ma ten katalog na ekranie, dociąga dokument sam.
 *
 * `empty` mówi, czy PO zapisie dokument jest pusty (sam biały znak liczy
 * się jako pustka). To jeden bit, nie treść: pigułka ✎ w pasku projektu podświetla się, gdy
 * projekt MA notatkę, a bez tego bitu każdy klient musiałby po każdym autosave robić `GET`
 * całego dokumentu tylko po to, żeby zapalić albo zgasić kolor ikony.
 */
export interface NotesEvent {
  type: 'notes';
  cwd: string;
  empty: boolean;
}

/** Project notes changed: the directory and the "empty after the write" bit, no content ({@link NotesEvent}). */
export const notesEventSchema = z.object({
  type: z.literal('notes'),
  cwd: z.string().min(1),
  empty: z.boolean(),
});
