/**
 * Protocol contract, attachments area: images and files in messages, their limits and transcript cards.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Obrazki w wiadomościach
// ---------------------------------------------------------------------------

/** Ile obrazków wolno dołączyć do jednej wiadomości. */
export const MAX_IMAGES_PER_MESSAGE = 5;

/**
 * Limit pojedynczego data URL — 1,5 MB PO downscale po stronie klienta
 * (dłuższy bok ≤ 2048 px, jpeg q0.85). Mierzymy długość stringa: base64 jest ASCII,
 * więc znaki i bajty UTF-8 to tu ta sama liczba.
 */
export const MAX_IMAGE_DATA_URL_BYTES = Math.round(1.5 * 1024 * 1024);

/**
 * Limit ciała `POST /api/sessions/:id/messages`.
 *
 * Mieści NAJGORSZY dopuszczalny przypadek: 5 obrazków × 1,5 MB + 4 pliki × 27 MB = 115,5 MB,
 * plus narzut JSON-a (cudzysłowy, nazwy plików, tekst). Sufit jest tu po to, żeby `readJsonBody`
 * odciął żądanie, którego i tak nie przepuści walidacja — a nie po to, żeby dublować limity
 * pojedynczych załączników.
 */
export const MAX_MESSAGE_BODY_BYTES = 120 * 1024 * 1024;

/**
 * Dozwolony kształt data URL obrazka: WYŁĄCZNIE base64 png/jpeg.
 *
 * Wąska lista jest celowa — `dataUrl` ląduje w `img[src]` w kliencie, a `data:text/html`
 * czy `data:image/svg+xml` potrafią wykonać skrypt. To jest granica bezpieczeństwa, nie kosmetyka.
 */
export const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

export const imageDataUrlSchema = z.string()
  .regex(IMAGE_DATA_URL_PATTERN, 'Obrazek musi być data URL image/png albo image/jpeg (base64).')
  .max(MAX_IMAGE_DATA_URL_BYTES, 'Obrazek przekracza limit rozmiaru.');

// ---------------------------------------------------------------------------
// Pliki w wiadomościach
// ---------------------------------------------------------------------------

/**
 * Ile PLIKÓW (poza obrazkami) wolno dołączyć do jednej wiadomości.
 *
 * Mniej niż obrazków, bo pliki są cięższe i idą inną drogą: obrazek TUI wciąga jako załącznik,
 * a plik agent musi otworzyć narzędziem `Read` — cztery `Read`-y to już cała tura.
 */
export const MAX_FILES_PER_MESSAGE = 4;

/**
 * Limit data URL pojedynczego pliku — 27 MB stringa, czyli 20 MB pliku po base64 (zeskanowane
 * PDF-y wysyłane z iPada przekraczają 5 MB).
 *
 * Mierzymy DŁUGOŚĆ STRINGA (base64 jest ASCII), tak samo jak przy obrazkach, żeby jedna
 * i ta sama liczba dała się sprawdzić na surowym ciele przed parsowaniem schematem.
 */
export const MAX_FILE_DATA_URL_BYTES = 27 * 1024 * 1024;

/** Górna granica nazwy pliku PO sanityzacji po stronie klienta. */
export const MAX_FILE_NAME_CHARS = 120;

/**
 * Dozwolony kształt data URL pliku: DOWOLNY typ MIME, ale wyłącznie base64.
 *
 * Szerzej niż `IMAGE_DATA_URL_PATTERN` i jest to świadome: plik nie trafia do `img[src]`
 * ani do żadnego innego kontekstu wykonywalnego w kliencie — ląduje na dysku w
 * `<cwd>/.rarog-uploads/` i agent czyta go `Read`-em. Wąska zostaje SKŁADNIA (`;base64,`
 * i alfabet base64), bo to ona chroni parser serwera przed śmieciem.
 */
export const FILE_DATA_URL_PATTERN =
  /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Nazwa pliku PO sanityzacji: bez separatorów ścieżki i bez znaków sterujących.
 *
 * To NIE jest cała obrona przed „../../.ssh/id_rsa" — tę robi serwer (`herdr/uploads.ts`
 * bierze `basename` i przepisuje nazwę na własny alfabet). Kontrakt odrzuca takie nazwy
 * wcześniej z innego powodu: nazwa jedzie do dziennika i do promptu, a znak sterujący
 * w nazwie to sekwencja ANSI w cudzym terminalu.
 */
export function isSafeFileName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_FILE_NAME_CHARS) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Załącznik plikowy: nazwa widoczna dla człowieka i agenta + treść jako data URL. */
export interface FileAttachment {
  /** Nazwa oryginalna po sanityzacji klienta — zostaje w nazwie pliku na dysku. */
  name: string;
  dataUrl: string;
}

export const fileDataUrlSchema = z.string()
  .regex(FILE_DATA_URL_PATTERN, 'Plik musi być data URL z zawartością base64.')
  .max(MAX_FILE_DATA_URL_BYTES, 'Plik przekracza limit rozmiaru.');

export const fileNameSchema = z.string().refine(
  isSafeFileName,
  'Nazwa pliku jest pusta, za długa albo ma separator ścieżki lub znak sterujący.',
);

export const fileAttachmentSchema = z.object({
  name: fileNameSchema,
  dataUrl: fileDataUrlSchema,
});

type _FileAttachmentSchemaMatchesType =
  z.infer<typeof fileAttachmentSchema> extends FileAttachment ? true : never;
type _FileAttachmentTypeMatchesSchema =
  FileAttachment extends z.infer<typeof fileAttachmentSchema> ? true : never;
const _fileAttachmentSchemaMatchesType: _FileAttachmentSchemaMatchesType = true;
const _fileAttachmentTypeMatchesSchema: _FileAttachmentTypeMatchesSchema = true;
void _fileAttachmentSchemaMatchesType;
void _fileAttachmentTypeMatchesSchema;

/**
 * WIZYTÓWKA załącznika w transkrypcie — nazwa, waga i typ, nigdy bajty.
 *
 * Echo użytkownika nie niesie `dataUrl` obrazka (do 5 × 1,5 MB na wiadomość), bo plik leży już
 * w `<cwd>/.rarog-uploads/`, a ring i `#messages` liczą SZTUKI: z bajtami `transcript-snapshot`
 * — ramka lecąca przy KAŻDYM wejściu w transkrypt i przy każdym rekonekcie z telefonu — ważyłby
 * megabajty (zmierzone: 4,4 MB przy 3 zdjęciach).
 *
 * ŚCIEŻKI pliku na Macu tu nie ma i nie będzie (`docs/security-model.md`, „herdr sessions”, reguła 12):
 * transkrypt jedzie na telefon i do cache'u klienta, a lokalna ścieżka nie jest treścią rozmowy.
 *
 * Wizytówka ZDJĘCIA niesie za to `file` — samą NAZWĘ pliku
 * w `<cwd>/.rarog-uploads/` (`<ms>-<16 hex>.png|jpg`, bez katalogu), po której klient prosi
 * o miniaturę `GET /api/sessions/:id/uploads/:file`. Nazwa nie mówi nic o dysku poza tym, że
 * Rarog sam ją nadał; katalog dokłada serwer z `cwd` SESJI, a nie z żądania.
 */
export interface MessageAttachment {
  /** `image` — TUI wciąga go jako obraz; `file` — agent otwiera go `Read`-em. */
  kind: 'image' | 'file';
  /** Nazwa od użytkownika. PUSTA dla obrazka: aparat ani schowek nazwy nie dają. */
  name: string;
  /** Rozmiar TREŚCI po odkodowaniu base64 — etykieta „1,2 MB" na chipie; `0` = nieznany (import z jsonl). */
  bytes: number;
  /** Typ MIME z data URL-a (`image/jpeg`, `application/pdf`…); `''` = nie dało się odczytać. */
  mime: string;
  /**
   * Nazwa pliku ZDJĘCIA w `.rarog-uploads/` — klucz miniatury z serwera. Nieobecna dla
   * plików, dla zdjęć wklejonych w terminalu (nie przez Raroga) i w echu starszego serwera.
   */
  file?: string;
}

/** Kształt `MessageAttachment.file`: nazwa nadana przez `herdr/uploads.ts`, nigdy ścieżka. */
export const UPLOAD_IMAGE_FILE_PATTERN = /^\d+-[0-9a-f]{16}\.(?:png|jpg)$/;

export const messageAttachmentSchema = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string(),
  bytes: z.number(),
  mime: z.string(),
  file: z.string().regex(UPLOAD_IMAGE_FILE_PATTERN).optional(),
});

type _MessageAttachmentSchemaMatchesType =
  z.infer<typeof messageAttachmentSchema> extends MessageAttachment ? true : never;
type _MessageAttachmentTypeMatchesSchema =
  MessageAttachment extends z.infer<typeof messageAttachmentSchema> ? true : never;
const _messageAttachmentSchemaMatchesType: _MessageAttachmentSchemaMatchesType = true;
const _messageAttachmentTypeMatchesSchema: _MessageAttachmentTypeMatchesSchema = true;
void _messageAttachmentSchemaMatchesType;
void _messageAttachmentTypeMatchesSchema;

/**
 * Waga treści data URL-a w bajtach — z DŁUGOŚCI base64, bez dekodowania.
 *
 * Liczymy arytmetyką, a nie `Buffer`/`atob`, bo tę samą liczbę musi dostać serwer (echo)
 * i przeglądarka (podpis wysyłki `sendSignature`) — a przeglądarka nie ma prawa dekodować
 * 1,5 MB tylko po to, żeby porównać dwie wiadomości. `0` = to nie jest data URL.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  const body = dataUrl.slice(comma + 1);
  const padding = body.endsWith('==') ? 2 : (body.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/** Typ MIME z data URL-a (`data:<mime>;base64,…`); `''`, gdy kształt jest inny. */
export function dataUrlMime(dataUrl: string): string {
  if (!dataUrl.startsWith('data:')) return '';
  const semi = dataUrl.indexOf(';');
  return semi === -1 ? '' : dataUrl.slice('data:'.length, semi);
}

/**
 * Wizytówki załączników wiadomości — JEDNA implementacja dla serwera i klienta.
 *
 * Kolejność (najpierw zdjęcia, potem pliki) jest ta sama co w bloku ścieżek doklejanym do
 * promptu i co na pasku nad polem wysyłki: człowiek ma zobaczyć w transkrypcie dokładnie to,
 * co widział, naciskając „Wyślij". Wspólna funkcja jest tu warunkiem dedupu wysyłki —
 * podpis echa w kliencie (apka: `EchoMatching`) i echo managera
 * muszą policzyć TĘ SAMĄ listę, co do bajta.
 */
export function messageAttachments(
  images: readonly string[] = [],
  files: readonly FileAttachment[] = [],
): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  for (const dataUrl of images) {
    out.push({ kind: 'image', name: '', bytes: dataUrlBytes(dataUrl), mime: dataUrlMime(dataUrl) });
  }
  for (const file of files) {
    out.push({
      kind: 'file', name: file.name,
      bytes: dataUrlBytes(file.dataUrl), mime: dataUrlMime(file.dataUrl),
    });
  }
  return out;
}

/**
 * Powód odrzucenia paczki załączników — router mapuje go na 413.
 *
 * Obrazki i pliki mają OSOBNE powody, bo mają osobne limity i osobny komunikat: „zmniejsz
 * zdjęcie" i „ten plik jest za duży" to dwie różne instrukcje dla człowieka z telefonem.
 */
export type AttachmentLimitViolation =
  | 'too-many' | 'too-large'
  | 'files-too-many' | 'file-too-large';

/**
 * Sprawdza limity załączników (liczba i rozmiar) w surowym, jeszcze niezwalidowanym ciele.
 *
 * Osobno od `messageBodySchema`, bo przekroczony limit to 413, a niezgodny kształt 400 —
 * router musi je rozróżnić, zanim schemat zwinie oba przypadki do jednego błędu.
 *
 * Obrazki idą PIERWSZE: gdy telefon przekroczy oba limity naraz, komunikat ma dotyczyć tego,
 * co użytkownik dokłada najczęściej.
 *
 * @returns powód przekroczenia albo `null`, gdy limity są zachowane (albo załączników nie ma).
 */
export function checkMessageImageLimits(body: unknown): AttachmentLimitViolation | null {
  if (typeof body !== 'object' || body === null) return null;
  const images = (body as { images?: unknown }).images;
  if (Array.isArray(images)) {
    if (images.length > MAX_IMAGES_PER_MESSAGE) return 'too-many';
    for (const image of images) {
      if (typeof image === 'string' && image.length > MAX_IMAGE_DATA_URL_BYTES) return 'too-large';
    }
  }
  const files = (body as { files?: unknown }).files;
  if (Array.isArray(files)) {
    if (files.length > MAX_FILES_PER_MESSAGE) return 'files-too-many';
    for (const file of files) {
      if (typeof file !== 'object' || file === null) continue;
      const dataUrl = (file as { dataUrl?: unknown }).dataUrl;
      if (typeof dataUrl === 'string' && dataUrl.length > MAX_FILE_DATA_URL_BYTES) {
        return 'file-too-large';
      }
    }
  }
  return null;
}
