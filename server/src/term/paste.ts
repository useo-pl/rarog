/**
 * Wklejka jedną ramką — składanie kawałków `pa` jednego gniazda w JEDNO wejście herdr.
 *
 * Powód istnienia: herdr 0.9.3 nie przepuszcza w ramkach kontrolera trybu `?2004h`, więc klient
 * (SwiftTerm w apce, dawniej xterm.js w PWA) nigdy nie wie, że program w panelu prosi o bracketed paste,
 * i wielowierszowa wklejka szła surowo — każda linia jako Enter. herdr umie za to sam dopasować
 * wklejkę do trybu programu: `terminal.input`, którego treść to DOKŁADNIE jedna wklejka
 * `ESC[200~…ESC[201~`, dekoduje i koduje od nowa (`apply_terminal_attach_input` →
 * `complete_text_bracketed_paste` → `paste_payload`): z 2004 owija, bez 2004 oddaje sam tekst.
 * Warunki herdr: start na początku danych, PIERWSZY znacznik końca kończy dane, treść UTF-8.
 * Ta sama wklejka w dwóch ramkach, znacznik końca w treści albo bajt po nim — surowo.
 *
 * Stąd trzy obowiązki tego modułu i żaden więcej:
 * - sklejenie kawałków w całość i oddanie jej RAZ (dwie ramki = surowa wklejka);
 * - wyczyszczenie treści ze znaczników PRZED owinięciem — `ESC[201~rm -rf ~\r` w schowku to dla
 *   zsh „koniec wklejki", a reszta jedzie jak klawisze i wykonuje się;
 * - wklejka w całości albo wcale: nadmiar ponad sufit, `in` w środku albo zerwane gniazdo (stan
 *   żyje w domknięciu gniazda, `ws.ts`) wyrzucają bufor razem z resztą tej wklejki.
 *
 * Treść wklejki nie trafia do żadnego logu — moduł nie loguje wcale, a wołający dostaje wyłącznie
 * rodzaj kroku i liczbę bajtów.
 */

/** Początek bracketed paste (DECSET 2004). */
export const PASTE_START = '\u001b[200~';
/** Koniec bracketed paste — jedyny bajt-ciąg, który zamyka wklejkę w programie. */
export const PASTE_END = '\u001b[201~';

/**
 * Oba znaczniki w obu postaciach CSI: 7-bitowej (`ESC [`) i 8-bitowej (U+009B). Tę drugą zsh
 * ani herdr nie czytają (szukają `ESC[201~` w bajtach), ale program czytający wejście jako
 * znaki mógłby — wycięcie kosztuje dwa wzorce więcej. Każdy kończy się `~` i zaczyna znakiem,
 * którego nie ma w jego środku, więc wystąpienia nie zachodzą na siebie.
 */
const MARKERS = [PASTE_START, PASTE_END, '\u009b200~', '\u009b201~'] as const;

/**
 * Wycina znaczniki DO SKUTKU w jednym przejściu: znak po znaku na stos, a po każdym `~`
 * sprawdzenie, czy wierzch stosu nie jest znacznikiem — wycięcie odsłania to, co pod nim,
 * więc znacznik sklejony z kawałków (`ESC[20` + `ESC[201~` + `1~`) też znika.
 *
 * Liniowo, nie pętlą `replace`: ta usuwała JEDEN zagnieżdżony znacznik na przebieg, a wklejka
 * w granicach sufitu z 87 tys. zagnieżdżeń blokowała pętlę zdarzeń serwera na ~15 s.
 */
function stripMarkers(text: string): string {
  const out: string[] = [];
  for (const unit of text.split('')) {
    out.push(unit);
    if (unit !== '~') continue;
    for (const marker of MARKERS) {
      if (out.length < marker.length) continue;
      let match = true;
      for (let i = 0; i < marker.length && match; i += 1) {
        match = out[out.length - marker.length + i] === marker[i];
      }
      if (match) {
        out.length -= marker.length;
        break;
      }
    }
  }
  return out.join('');
}

/** Samotny surogat: wysoki bez niskiego za nim albo niski bez wysokiego przed nim. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Treść wklejki gotowa do owinięcia.
 *
 * - Znaczniki wycinane DO SKUTKU (`stripMarkers`): wycięcie wewnętrznego znacznika potrafi
 *   skleić zewnętrzny (`ESC[20` + `ESC[201~` + `1~` → `ESC[201~`).
 * - Samotne surogaty → U+FFFD: `JSON.stringify` zostawia je jako `\udXXX`, a NDJSON kontrolera
 *   (serde) takiej ucieczki nie przyjmie — przepadłaby cała wklejka.
 * - Końce linii → `\r`, jak xterm.js (`prepareTextForTerminal`) i terminale natywne: Enter to CR.
 *   herdr niczego tu nie zmienia (`prepare_paste_text_for_pty` poza Windows to tożsamość).
 */
export function cleanPasteText(text: string): string {
  return stripMarkers(text).replace(LONE_SURROGATE, '\ufffd').replace(/\r?\n/g, '\r');
}

/** Owinięcie CZYSTEJ treści — jedna wklejka w oczach herdr. */
export function wrapPaste(cleaned: string): string {
  return `${PASTE_START}${cleaned}${PASTE_END}`;
}

/**
 * Krok składania:
 * - `pending` — kawałek przyjęty, wklejka trwa;
 * - `ready` — koniec wklejki, `input` to JEDNO wejście dla herdr (już owinięte);
 * - `empty` — koniec wklejki, po czyszczeniu nie zostało nic do wpisania;
 * - `overflow` — ten kawałek przekroczył sufit; bufor wyrzucony, reszta wklejki też pójdzie
 *   do kosza (`bytes` = suma w chwili przekroczenia, do logu — nigdy treść);
 * - `dropped` — kawałek wklejki już odrzuconej (nadmiar albo przerwanie).
 */
export type PasteStep =
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly input: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'overflow'; readonly bytes: number }
  | { readonly kind: 'dropped' };

/**
 * Bufor wklejki JEDNEGO gniazda. Żadnych zegarów: wklejka kończy się znacznikiem `e`, a bufor
 * bez końca ginie razem z gniazdem (domknięcie w `ws.ts`), więc nie ma czego wygaszać.
 */
export class PasteAssembler {
  /** Kawałki treści — WYŁĄCZNIE niepuste, więc bufor rośnie tylko razem z bajtami. */
  private parts: string[] = [];
  private bytes = 0;
  /** Wklejka trwa (był kawałek bez `e`) — osobno od `parts`, bo pusty kawałek też ją zaczyna. */
  private open = false;
  /** Wklejka odrzucona w trakcie — kawałki do jej znacznika końca idą do kosza. */
  private discarding = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string, end: boolean): PasteStep {
    if (this.discarding) {
      if (end) this.discarding = false;
      return { kind: 'dropped' };
    }
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    if (this.bytes > this.maxBytes) {
      const bytes = this.bytes;
      this.reset();
      this.discarding = !end;
      return { kind: 'overflow', bytes };
    }
    // Pusty kawałek nie trafia do bufora: seria `{d:'', e:false}` rosłaby bez sufitu bajtów.
    if (chunk !== '') this.parts.push(chunk);
    if (!end) {
      this.open = true;
      return { kind: 'pending' };
    }
    const cleaned = cleanPasteText(this.parts.join(''));
    this.reset();
    return cleaned === '' ? { kind: 'empty' } : { kind: 'ready', input: wrapPaste(cleaned) };
  }

  /**
   * Wejście spoza wklejki (`in`) w jej trakcie. Zwraca `true`, gdy coś przerwało — wtedy bufor
   * jest już pusty, a reszta tej wklejki (do jej `e`) pójdzie do kosza: ogon zaczęty od nowa
   * byłby drugą, częściową wklejką.
   */
  interrupt(): boolean {
    if (!this.open) return false;
    this.reset();
    this.discarding = true;
    return true;
  }

  private reset(): void {
    this.parts = [];
    this.bytes = 0;
    this.open = false;
  }
}
