import Foundation

/// Wskaźnik (gładzik, mysz) nad tym, co się klika — czyste liczby, testowane na
/// macOS (`HoverTokensTests`). Widoki: `Views/Common/Hover.swift`. Osobny plik obok `PaletteTokens`: tokeny kolorów
/// zmieniają też inne obszary. Właściciel: wygląd wspólny.
public enum HoverTokens {
  /// Wypełnienie pod wskaźnikiem: atrament tekstu w tym kryciu. Opcje kart, przyciski tekstowe, chipy bez obrysu, ikony.
  public static let wash: Double = 0.05

  /// Kreska obrysowanej kontrolki rzędu pod polem wiadomości (spinacz, pigułki, mikrofon) pod wskaźnikiem: atrament
  /// kreski `border` (biel / czerń) w tym kryciu zamiast 8 % / 10 % w spoczynku.
  public static let outlineStroke: Double = 0.30

  /// Przycisk z kolorowym obrysem („Odrzuć”, „Ponów”): jego kolor w tym kryciu jako tło — `.btn--deny:hover` w PWA
  /// (8 %, nie 12 %: przy 12 % czerwona etykieta w jasnym spadała pod 4,5:1). Pod palcem dalej 14 %.
  public static let outlineTint: Double = 0.08

  /// Przycisk wypełniony kolorem stanu („Zatwierdź”): domieszka atramentu tekstu — `.btn--accent:hover` w PWA
  /// (86 % akcentu + 14 % tekstu). W ciemnym rozjaśnia, w jasnym ściemnia: etykieta odcina się mocniej w obu.
  public static let filledMix: Double = 0.14

  /// Przycisk wypełniony atramentem tekstu („Wyślij” karty pytania, „Nowa sesja”, „Sparuj”): domieszka tła w tym
  /// kryciu. Domieszka tekstu w wypełnieniu tekstem nic nie zmienia, a cień `.btn--primary:hover` z PWA na czarnym tle
  /// ciemnego motywu nie widać; napis zostaje ponad 7:1.
  public static let inkFillMix: Double = 0.12

  /// Wiersz agenta pod wskaźnikiem: plama zaznaczenia (`surface2`) w połowie krycia — „ten background mu się
  /// zaświeci, ale bardziej przydymiony”. PWA daje `--surface` (`.session-card:hover`), ton pod `--surface-2`
  /// zaznaczenia, ale ta różnica to ~67 % kroku zaznaczenia i obok zaznaczonego wiersza ginęła; połowa krycia ~41 %.
  public static let agentRowAlpha: Double = 0.5

  /// Tło wiersza agenta na tle kolumny: zaznaczenie wygrywa, wskaźnik daje połowę zaznaczenia, bez obu — tło kolumny.
  public static func agentRow(selected: Bool, hovered: Bool, dark: Bool) -> UInt32 {
    let background = dark ? PaletteTokens.background.dark : PaletteTokens.background.light
    let selection = dark ? PaletteTokens.surface2.dark : PaletteTokens.surface2.light
    if selected { return selection }
    return hovered ? PaletteTokens.over(selection, alpha: agentRowAlpha, on: background) : background
  }
}
