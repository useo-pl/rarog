/**
 * Tożsamość dialogu i jej porównanie: to, co driver sprawdza na świeżym ekranie tuż przed cyfrą.
 */
import type { ScreenDialogKind } from './kinds.ts';
import type { KnownDialogId } from './known.ts';

/**
 * TOŻSAMOŚĆ dialogu z bloku rysowanego przez CLI.
 *
 * - `title` — nazwa narzędzia z tytułu bloku (mapa {@link TOOL_DIALOG_HEADERS}) albo nadana przez Raroga
 *   dialogowi planu i sieci sandboksa;
 * - `ask-rule` — nazwa z linii `Ask rule Nazwa(…)` pod ramką operacji, gdy tytułu nie widać;
 * - `file-question` — `Write` i nazwa pliku z pytania pod ramką treści („Do you want to create <nazwa>?”), gdy
 *   nagłówek dialogu jest nad krawędzią ekranu (`screen/write-zone.ts`); nazwa tylko do wyświetlenia: ekran bez góry
 *   ramki i licznika kolejki nie odróżnia dwóch `Write`, więc karta bez przycisków na każdej ścieżce i odmowa cyfry
 *   tuż przed klawiszem, jak przy `ambiguous`;
 * - `mcp` — serwer i ludzki tytuł narzędzia MCP z nagłówka pod „Tool use”;
 * - `known` — dialog z zamkniętej listy {@link KNOWN_DIALOGS} rozpoznany po tytule bloku;
 * - `form` — dialog bez nazwy z bloku: formularz pytania, potwierdzenie, zgoda z uciętym tytułem;
 * - `ambiguous` — nad opcjami stoi więcej niż jedna para „kreska + tytuł” ({@link dialogBlock}): karta
 *   bez przycisków na każdej ścieżce i odmowa cyfry tuż przed klawiszem.
 *
 * Karta niesie ją w `ActiveReq.dialogIdentity` (z rodzajem dialogu), a driver porównuje ze świeżym
 * odczytem tuż przed cyfrą ({@link sameDialogIdentity}).
 */
export type DialogIdentity =
  | { readonly kind: 'title' | 'ask-rule'; readonly tool: string }
  | { readonly kind: 'file-question'; readonly tool: string; readonly file: string }
  | { readonly kind: 'mcp'; readonly server: string; readonly title: string }
  | { readonly kind: 'known'; readonly id: KnownDialogId }
  | { readonly kind: 'form' }
  | { readonly kind: 'ambiguous' };

/** Rodzaj dialogu i jego tożsamość w chwili budowy karty — to porównuje driver przed cyfrą. */
export interface DialogIdentityStamp {
  readonly kind: ScreenDialogKind;
  readonly identity: DialogIdentity;
}

/** Ten sam rodzaj i ta sama tożsamość; `ambiguous` i `file-question` nie są równe niczemu, także sobie. */
export function sameDialogIdentity(a: DialogIdentityStamp, b: DialogIdentityStamp): boolean {
  if (a.kind !== b.kind) return false;
  const x = a.identity;
  const y = b.identity;
  switch (x.kind) {
    case 'title':
    case 'ask-rule':
      return y.kind === x.kind && y.tool === x.tool;
    case 'mcp':
      return y.kind === 'mcp' && y.server === x.server && y.title === x.title;
    case 'known':
      return y.kind === 'known' && y.id === x.id;
    case 'form':
      return y.kind === 'form';
    case 'file-question':
    case 'ambiguous':
      return false;
  }
}

/** Tożsamość dialogu bez nazwy z bloku (formularz, potwierdzenie, zgoda z uciętym tytułem). */
export const FORM_IDENTITY: DialogIdentity = { kind: 'form' };
