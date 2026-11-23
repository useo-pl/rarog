import Foundation
import RarogCore

/// Wartości tokenów kolorów z `docs/design.md` — jedno źródło dla `Palette` (iOS) i testów
/// kontrastu (macOS, `PaletteContrastTests`). Para: motyw ciemny (pierwszy) i jasny (za systemem).
/// Właściciel tokenów kontrastu: dostępność; zmiana wartości = test kontrastu w tym samym commicie.
public enum PaletteTokens {
  public struct Pair: Sendable, Equatable {
    public let dark: UInt32
    public let light: UInt32
  }

  public static let background = Pair(dark: 0x0A0A0A, light: 0xF2F2F7)
  public static let surface = Pair(dark: 0x171717, light: 0xFFFFFF)
  /// Boki ekranu iPada: lista obok sesji i prawy panel, o stopień od tła transkryptu, żeby kolumny się nie zlewały.
  /// Jasny #EDEDF2, nie #E8E8ED: przy tamtym `muted2`, `behind`,
  /// `runSmoked` i prowadnica drzewa spadają pod swoje progi (`PaletteContrastTests`, `ProjectTreeRowsTests`).
  public static let sidebar = Pair(dark: 0x111111, light: 0xEDEDF2)
  public static let surface2 = Pair(dark: 0x1C1C1C, light: 0xF7F7FA)
  /// Selection plate of the stacked list (iPhone, narrow window), which stands on `background`, not on `sidebar`.
  /// Dark as `surface2`; light `surface`, because `surface2` on the light background is about 1.04:1 and the row
  /// the human came back from could not be told apart (`PaletteContrastTests`).
  public static let stackedPlate = Pair(dark: surface2.dark, light: surface.light)
  public static let text = Pair(dark: 0xF5F5F5, light: 0x1C1C1E)
  /// Wyciszony atrament: ≥ 7:1 na tle w obu motywach, bo przygaszony transkrypt ma zostać ponad 7:1.
  /// Jasny 0x51515A, nie 0x52525B: tamten ma 6,93:1 na #F2F2F7.
  public static let muted = Pair(dark: 0xA3A3A3, light: 0x51515A)
  public static let muted2 = Pair(dark: 0x8E8E93, light: 0x6B6B73)
  /// `muted2` przy „Zwiększ kontrast”: 7,4:1 / 6,1:1 na tle zamiast 6,1:1 / 4,7:1, dalej ciszej niż
  /// `muted`, więc oba stopnie wyciszenia zostają rozróżnialne (`PaletteContrastTests`).
  public static let muted2High = Pair(dark: 0x9E9EA3, light: 0x5A5A62)
  /// Tekst drugiego planu: w połowie drogi między `text` a `muted` (prawy panel). Nazwa
  /// skończonego zadania i nazwa pliku w drzewie zmian w spoczynku — czytelniej niż `muted`, ciszej niż `text`;
  /// pod wskaźnikiem nazwa pliku wraca do `text`. ≥ 7:1 na tle i na `surface` (`PaletteContrastTests`).
  public static let text2 = Pair(dark: 0xCCCCCC, light: 0x36363C)
  /// Proza odpowiedzi agenta w transkrypcie: w ciemnym motywie o ton ciemniejsza od `text`, żeby pogrubienie
  /// i nagłówki w `strong` odcinały się jasnością, nie samą grubością kroju. Jasny motyw bez zmian. ≥ 7:1 na tle
  /// także po przygaszeniu pod kartą decyzji (`PaletteContrastTests`).
  public static let prose = Pair(dark: 0xD4D4D4, light: 0x1C1C1E)
  /// Pogrubienie i nagłówki w prozie odpowiedzi agenta, para do `prose`.
  public static let strong = Pair(dark: 0xFFFFFF, light: 0x1C1C1E)
  /// Nagłówek listy (nazwa tailnetu) stoi na tle kolumny `background`: `muted` daje 7,04:1 (jasny) i 7,85:1
  /// (ciemny).
  public static let listHeaderInk = muted
  /// Atrament wiersza bezczynnego — świadomie poniżej AA: bezczynny wiersz ma być mocno wygaszony.
  public static let idleInk = Pair(dark: 0x58585F, light: 0x92929A)
  /// Pole do wpisania (token, blok komendy na karcie) — jak `--input` w PWA.
  public static let input = Pair(dark: 0x141414, light: 0xFFFFFF)
  /// Pole wiadomości w spoczynku — jak `--composer-rest` w PWA.
  public static let composerRest = Pair(dark: 0x111111, light: 0xF7F7FA)
  /// The dictation microphone's plate in the field card: `text` at 14 % (dark) and 10 % (light) over the card's rest
  /// tone, so the mic outranks the outlined controls beside it without taking the accent, which only a filled Send
  /// carries. The icon on it is `text`; the plate stands out from the card by ≥ 1.2:1 (`PaletteContrastTests`).
  public static let micPlate = Pair(
    dark: over(text.dark, alpha: 0.14, on: composerRest.dark), light: over(text.light, alpha: 0.10, on: composerRest.light))
  /// The microphone's plate while it is lit (dictation recording, a muted voice conversation): `err` at 16 % (dark)
  /// and 12 % (light) over the card's rest tone, with the icon and the outline in `err` (≥ 3:1 on it).
  public static let micPlateLive = Pair(
    dark: over(err.dark, alpha: 0.16, on: composerRest.dark), light: over(err.light, alpha: 0.12, on: composerRest.light))
  /// Strzałki gałęzi względem zdalnej: przed (↑) i za (↓) — `--ahead`, `--behind` w PWA; to nie kolory stanu.
  public static let ahead = Pair(dark: 0xC084FC, light: 0x6D28D9)
  public static let behind = Pair(dark: 0x22D3EE, light: 0x0E7490)
  /// Dymek wiadomości człowieka: śliwkowy szary, przydymiony: śliwka #322C34 / #E0D9E1 w kryciu 70 % na
  /// tle transkryptu, czyli #262227 / #E5E1E8 (50 % zlałoby dymek z blokiem kodu).
  /// Nasycenie C* ~4 — szarość z odcieniem, nie kolor; barwa ~318° stoi obok `ahead` (312°), ale to kierunek commitów,
  /// nie stan, i w transkrypcie go nie ma (`docs/design.md`). Koszt przyjęty świadomie: od bloku kodu w odpowiedzi
  /// dymek odcina się jasnością już ledwo (1,10:1 ciemny, 1,04:1 jasny), resztę robi kształt i krój.
  public static let userPlate = Pair(
    dark: over(0x322C34, alpha: 0.7, on: background.dark), light: over(0xE0D9E1, alpha: 0.7, on: background.light))
  /// Dymek pod palcem — pasek cytatu promptu, który stoi na tle dymku: w ciemnym biel
  /// 8 % nad dymkiem (#373438), w jasnym czerń 7 % (#D5D1D8). Tekst dalej ≥ 7:1, ikona (grafika) ≥ 3:1, a zmianę tła
  /// widać bez szkła.
  public static let userPlatePressed = Pair(
    dark: over(0xFFFFFF, alpha: 0.08, on: userPlate.dark), light: over(0x000000, alpha: 0.07, on: userPlate.light))
  public static let codeBlockFill = Pair(dark: 0x1B1B1B, light: 0xE6E6EB)
  /// Blok kodu w dymku człowieka: w jasnym `codeBlockFill` (#E6E6EB) różni się od
  /// dymku tylko o włos i czyta się jak dziura w dymku — biel 50 % nad dymkiem (#F2F0F4) odcina go wyraźnie. W ciemnym
  /// czerń 30 % nad dymkiem (#1B181B): na oko to `codeBlockFill` (#1B1B1B), ale ten na przydymionym dymku
  /// daje 1,0995:1, tuż pod progiem 1,1.
  public static let codeInPlateFill = Pair(
    dark: over(0x000000, alpha: 0.3, on: userPlate.dark), light: over(0xFFFFFF, alpha: 0.5, on: userPlate.light))
  /// Atrament kodu w linii: ciepły, wygaszony bursztyn — rodzina `--note-ink` z PWA, wyraźnie jaśniejszy i mniej
  /// nasycony niż `wait` (bursztyn stanu „czeka”), żeby kod nie wołał o uwagę. ≥ 4,5:1 na tle kodu w linii w treści
  /// agenta i w dymku człowieka, w obu motywach (`PaletteContrastTests`). Jasny #6E4914, bo #7A5218
  /// daje na śliwkowym dymku 4,2:1.
  public static let inlineCodeInk = Pair(dark: 0xDDB988, light: 0x6E4914)
  /// Glif notatki projektu z treścią: ten sam wygaszony bursztyn co kod w linii — rodzina
  /// `--note-ink` z PWA — a nie `wait`, który woła człowieka. Bez notatki glif jest szary (`muted2`). Grafika: ≥ 3:1 na
  /// tle kolumny, `surface2` i płytce zakładki (`PaletteContrastTests`).
  public static let noteInk = inlineCodeInk
  /// Atrament linku w treści: stonowany, mało nasycony niebieski — obok podkreślenia;
  /// spokojniejszy niż `new` (niebieski stanu
  /// „skończyła”). ≥ 4,5:1 na tle transkryptu, dymku człowieka i bloku kodu w obu motywach (`PaletteContrastTests`).
  public static let linkInk = Pair(dark: 0x93B5DD, light: 0x2D5C99)
  /// Krycie kreski `border` (włos, obrys, separator): biel w ciemnym, czerń w jasnym; na tle ≈ 1,2:1.
  public static let borderAlpha: (dark: Double, light: Double) = (0.08, 0.10)
  /// Kreska przy „Zwiększ kontrast”: na tle 1,9:1 (ciemny) i 1,8:1 (jasny). Słabiej niż kreska pod
  /// wskaźnikiem (`HoverTokens.outlineStroke`), żeby wskaźnik dalej było widać (`PaletteContrastTests`).
  public static let borderAlphaHigh: (dark: Double, light: Double) = (0.22, 0.25)
  /// Krycie tła kodu w linii: biel w ciemnym, czerń w jasnym (przy 6 % / 5 % „mało się odznaczał”).
  public static let inlineCodeFillAlpha: (dark: Double, light: Double) = (0.13, 0.08)

  /// Zaznaczony wiersz okna przełącznika sesji: atrament `text` w kryciu 9 % (ciemny) i 6 % (jasny) nad
  /// `surface` — neutralnie, bez koloru akcentu. Słowa stanów i `muted` trzymają na nim 4,5:1; `muted2` i kolor
  /// `done` już nie, więc w zaznaczonym wierszu tekst drugorzędny idzie w `muted` (`PaletteContrastTests`).
  public static let switcherSelection = Pair(
    dark: over(text.dark, alpha: 0.09, on: surface.dark), light: over(text.light, alpha: 0.06, on: surface.light))

  public static let wait = Pair(dark: 0xFFB454, light: 0x9B5700)
  public static let run = Pair(dark: 0x4ADE80, light: 0x1C773D)
  /// Przydymiona zieleń stanu „czeka na zadanie w tle”: `run` w 62 % (ciemny) i 75 % (jasny) nad
  /// `background`, zapisana jako kolor kryjący. W jasnym 70 % dałoby 2,91:1, poniżej 3:1 dla elementu stanu.
  /// ≥ 3:1 nad `background` i `surface` w obu motywach (`PaletteContrastTests`).
  public static let runSmoked = Pair(
    dark: over(run.dark, alpha: 0.62, on: background.dark), light: over(run.light, alpha: 0.75, on: background.light))
  /// Cyfra kafelka zakładki na przydymionej zieleni: ciemna w obu motywach, bo `onState` w jasnym (biel) daje na
  /// `runSmoked` 3,5:1, poniżej 4,5:1 dla tekstu (`PaletteContrastTests`).
  public static let onRunSmoked = Pair(dark: 0x0A0A0A, light: 0x0A0A0A)
  public static let err = Pair(dark: 0xF87171, light: 0xB31B1B)
  public static let new = Pair(dark: 0x7EB6FF, light: 0x0B57D0)
  /// Kreska linii „NOWE" w transkrypcie: błękit `new` w tym kryciu, napis w pełnym.
  public static let newMarkerRuleAlpha: Double = 0.55
  public static let done = Pair(dark: 0x71717A, light: 0x676770)
  /// `done` przy „Zwiększ kontrast”: kropka ciszy i glify skończonego mocniej, 6,1:1 / 6,6:1 na tle
  /// zamiast 4,1:1 / 5,0:1 (`PaletteContrastTests`).
  public static let doneHigh = Pair(dark: 0x8E8E96, light: 0x55555D)
  public static let onState = Pair(dark: 0x0A0A0A, light: 0xFFFFFF)

  /// Kolor stanu sesji (kropka, kafelek i kwadracik zakładki, licznik projektu).
  public static func tone(_ tone: StatusTone) -> Pair {
    switch tone {
    case .working: run
    case .waiting: wait
    case .failed: err
    case .unread: new
    case .quiet: done
    case .backgroundWait: runSmoked
    }
  }

  // MARK: Kolory składni

  // Jedyne kolory spoza słownika stanów, wyłącznie wewnątrz bloku kodu, karty narzędzia w transkrypcie i bloku
  // komendy karty zgody (`docs/design.md` „First exception"). Ciemne wartości to `--hl-*` z PWA;
  // jasne napis, liczba, literał i komentarz są ciemniejsze niż w PWA, bo jasne tło bloku
  // kodu apki (`codeBlockFill` #E6E6EB) jest ciemniejsze od powierzchni PWA (#FFFFFF): tam PWA miała 4,50 / 3,91
  // / 4,47 / 4,25:1, apka trzyma
  // ≥ 4,6:1 przy tym samym odcieniu (`PaletteContrastTests`). Komentarz to wyciszenie (PWA: `--muted-2`), linie
  // `+`/`−` diffu to zieleń i czerwień karty edycji (PWA: `--run`/`--err`), z jasną zielenią przyciemnioną jak napis.

  /// Słowo kluczowe, nazwa znacznika.
  public static let hlK = Pair(dark: 0xC678DD, light: 0xA626A4)
  /// Napis (PWA jasny #1C773D: 4,50:1 na #E6E6EB).
  public static let hlS = Pair(dark: 0x98C379, light: 0x1C753C)
  /// Liczba (PWA jasny #986801: 3,91:1).
  public static let hlN = Pair(dark: 0xD19A66, light: 0x895E01)
  /// Literał `true`/`false`/`null` (PWA jasny #0A6F9E: 4,47:1).
  public static let hlL = Pair(dark: 0x56B6C2, light: 0x0A6C9A)
  /// Nazwa: funkcja, komenda, klucz obiektu, atrybut.
  public static let hlF = Pair(dark: 0x61AFEF, light: 0x2A5FD4)
  /// Komentarz: ciemny = `muted2`; jasny ciemniejszy od `muted2` (#6B6B73: 4,25:1).
  public static let hlC = Pair(dark: 0x8E8E93, light: 0x65656D)
  /// Linia dodana w diffie: ciemny = `run`; jasny jak napis (`run` #1C773D: 4,50:1).
  public static let hlAdd = Pair(dark: 0x4ADE80, light: 0x1C753C)
  /// Linia usunięta w diffie = `err`.
  public static let hlDel = err
  /// Plama karty narzędzia w transkrypcie — drugie tło, na którym stoją kolory składni (komenda powłoki).
  public static let toolCard = Pair(dark: 0x111111, light: 0xFFFFFF)

  /// Kolor klasy tokenu składni.
  public static func syntax(_ kind: SyntaxClass) -> Pair {
    switch kind {
    case .k: hlK
    case .s: hlS
    case .n: hlN
    case .l: hlL
    case .f: hlF
    case .c: hlC
    case .add: hlAdd
    case .del: hlDel
    }
  }
}

extension PaletteTokens {
  /// Kolor `top` w kryciu `alpha` na `bottom`, mieszany w sRGB jak warstwy Core Animation.
  public static func over(_ top: UInt32, alpha: Double, on bottom: UInt32) -> UInt32 {
    func channel(_ shift: UInt32) -> UInt32 {
      let t = Double((top >> shift) & 0xFF)
      let b = Double((bottom >> shift) & 0xFF)
      return UInt32((alpha * t + (1 - alpha) * b).rounded())
    }
    return channel(16) << 16 | channel(8) << 8 | channel(0)
  }
}
