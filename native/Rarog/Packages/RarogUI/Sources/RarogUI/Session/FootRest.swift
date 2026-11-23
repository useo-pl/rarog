// Pole wiadomości przy schowanej klawiaturze, przy dolnej krawędzi ekranu. Bez UIKit — testowane na macOS
// (`RarogUILogicTests`). Właściciel: pole.

/// The base rule for a card's distance from the bottom edge of the screen with the keyboard down: next to the home
/// indicator the card goes 16 pt into the safe area, but not closer to the edge than 12 pt; without a safe area 8 pt.
/// iPhone Air (34 pt) → 18 pt, iPad with a home bar (20 pt) → 12 pt. The floating glass cards — the field card (or the
/// dock or the state card in its place) and the list footer card — take it with a 14 pt floor,
/// `ListFooterMetrics.bottomGap`, so on the iPad both end on one line.
public enum FootRest {
  public static func gap(safeBottom: Double) -> Double {
    safeBottom > 0 ? max(12, safeBottom - 16) : 8
  }

  /// Empty band under the last transcript row, over the top of the foot.
  public static let transcriptBreath = 12.0

  /// Bottom inset of the transcript (`adjustedContentInset.bottom`): the list runs under the foot, so the inset
  /// covers everything from the top of the foot (the activity row counts) to the bottom of the view, plus the breath.
  public static func transcriptInset(footTop: Double, viewBottom: Double) -> Double {
    max(0, viewBottom - footTop) + transcriptBreath
  }

  /// Najwyższy pasek skrótów klawiatury sprzętowej (pigułka „PL EN + mikrofon”, ~50–65 pt z marginesem). Wyżej
  /// sięga już klawiatura (pływająca ma ponad 150 pt) — próg jak `KEYBOARD_MIN_PX` w PWA.
  public static let shortcutBarMaxHeight = 150.0

  /// O ile dół stopy może zejść pod górę prowadnicy klawiatury (`+` = niżej) — stała `footDown`
  /// i `footAboveKeyboard`. `rest` = spoczynek stopy względem dolnej krawędzi widoku, `overlap` = ile prowadnica
  /// wchodzi w widok od dołu, `guideHeight` = wysokość samej prowadnicy.
  /// - Schowana klawiatura: luz do spoczynku (niżej trzyma `footAtRest`).
  /// - Pasek skrótów (niska prowadnica przy klawiaturze sprzętowej): iPadOS zgłasza pigułkę prowadnicą na całą
  ///   szerokość okna (zmierzone na iPadzie: pole stałoby dołem na górze pigułki), więc luz sięga pod nią, do
  ///   spoczynku — pigułka leży NAD polem i nie przesuwa układu. Bez klawiatury
  ///   sprzętowej niska prowadnica to klawiatura ekranowa przycięta do okna Stage Managera.
  /// - Klawiatura: 0, stopa kończy się na jej górze. Też pusta ramka z pierwszego przebiegu układu (prowadnica
  ///   w początku widoku, wysokość 0).
  public static func guideSlack(rest: Double, overlap: Double, guideHeight: Double, hardwareKeyboard: Bool) -> Double {
    let resting = max(0, rest)
    guard overlap > 0.5 else { return resting }
    guard isShortcutBar(guideHeight: guideHeight, hardwareKeyboard: hardwareKeyboard) else { return 0 }
    return overlap + resting
  }

  /// Prowadnica klawiatury to pasek skrótów klawiatury sprzętowej, nie klawiatura (`guideSlack`).
  public static func isShortcutBar(guideHeight: Double, hardwareKeyboard: Bool) -> Bool {
    hardwareKeyboard && guideHeight > 0.5 && guideHeight < shortcutBarMaxHeight
  }
}
