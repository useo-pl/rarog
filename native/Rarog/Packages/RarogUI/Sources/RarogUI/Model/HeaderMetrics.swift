import CoreGraphics

/// Wcięcia i odstępy rzędów nagłówka sesji (pasek zakładek, linia statusu, ikony w prawym górnym rogu).
/// Czyste liczby, testowane na macOS (`HeaderMetricsTests`); widoki w `Views/Header`. Właściciel: nagłówek.
///
/// Treść rzędów stoi tam, gdzie tekst transkryptu, 16 pt od krawędzi kolumny, po obu stronach.
enum HeaderMetrics {
  /// Pierwszy tekst zakładek, pierścień kontekstu i prawa krawędź pigułek.
  static let contentInset: CGFloat = 16
  /// Treść zakładki (kafelek albo kwadracik, etykieta) od brzegu jej celu dotyku; płytka bieżącej zakładki sięga
  /// brzegu celu, więc wystaje poza treść o tyle z każdej strony.
  static let tabLabelInset: CGFloat = 8
  /// Pasek zakładek: cel dotyku pierwszej zakładki zaczyna się `tabLabelInset` przed treścią.
  static let tabBarInset: CGFloat = contentInset - tabLabelInset
  /// Pasek zakładek bliżej linii gita o 4 pt. Linia statusu traci górny margines (2 → 0),
  /// a treść zakładki schodzi o 2 pt w celu 44 pt (``tabLabelDrop``), który dalej ma 44 pt.
  static let statusTopPadding: CGFloat = 0
  static let statusBottomPadding: CGFloat = 2
  /// O tyle treść zakładki (i „+" w jej osi) stoi niżej niż środek celu: 4 pt od dołu celu. Płytka bieżącej
  /// zakładki ma środek w tej samej osi (`TabTokens.plateTopInset`).
  static let tabLabelDrop: CGFloat = 2
  /// Cel dotyku ikony nagłówka („Terminal w oknie", „×").
  static let iconTarget: CGFloat = 44
  /// Odstęp między celami ikon w prawym górnym rogu. Trzy osobne elementy paska narzędzi stoją co 12 pt
  /// (odstęp systemu), środki glifów co 56 pt; jedna grupa z 2 pt daje 46 pt.
  static let iconSpacing: CGFloat = 2
  /// Ikony prawego górnego rogu, pod które liczy się sufit tytułu („Terminal w oknie", „⋯" terminala, „×"),
  /// i najwięcej ikon na telefonie (``HeaderTrailingIcons``).
  static let trailingIconsMax = 3

  // MARK: - Lewy górny róg

  /// Przycisk zwijania listy stoi w lewym górnym rogu nagłówka sesji, a nazwa projektu i ścieżka tuż za nim, wyrównane
  /// do lewej. Między celem przycisku a tytułem ten sam odstęp, co między ikonami prawego rogu.
  static let titleSpacing: CGFloat = iconSpacing
  /// Margines paska nawigacji od krawędzi kolumny, z każdej strony, i najmniejszy luz między tytułem a ikonami
  /// (iPad; telefon: ``phoneTitleMaxWidth(columnWidth:closeArmed:)``).
  static let barSideInset: CGFloat = contentInset
  static let titleTrailingGap: CGFloat = contentInset

  /// Uzbrojone „×” mówi pytanie (`projects.confirmQuestion`, `terminal.closeConfirm`) tekstem szerszym niż cel 44 pt
  /// (`subheadline` półgruby): na te 5 s tytuł oddaje tyle miejsca, żeby nie wejść pod napis. Zapas liczy najszerszy
  /// język katalogu: polskie „Na pewno?” do xxxLarge ma ~100 pt, angielskie “Sure?” i “Close?” są węższe.
  static let armedCloseExtra: CGFloat = 64

  /// Najszerszy tytuł (nazwa projektu i ścieżka) obok przycisku zwijania: szerokość kolumny bez przycisku,
  /// kompletu ikon prawego rogu (zawsze trzech, żeby tytuł nie skakał, gdy któraś znika), napisu
  /// uzbrojonego „×” i marginesów paska. Długi tytuł ucina się, zamiast wchodzić pod ikony. Kolumna jeszcze
  /// niezmierzona (0) — bez limitu.
  static func titleMaxWidth(columnWidth: CGFloat, toggle: Bool, closeArmed: Bool = false) -> CGFloat? {
    guard columnWidth > 0 else { return nil }
    let leading = toggle ? iconTarget + titleSpacing : 0
    let armed = closeArmed ? armedCloseExtra : 0
    return max(0, columnWidth - 2 * barSideInset - leading - trailingIconsWidth - armed - titleTrailingGap)
  }

  /// Komplet ikon prawego rogu, pod który liczy się sufit tytułu.
  static let trailingIconsWidth = CGFloat(trailingIconsMax) * iconTarget + CGFloat(trailingIconsMax - 1) * iconSpacing

  // MARK: - Tytuł na telefonie (stos, za systemowym „wstecz")

  /// Odstęp, który pasek nawigacji trzyma między swoimi elementami: za „wstecz" przed tytułem i między tytułem
  /// a grupą ikon. Zmierzone na iOS 27 (iPhone Air i 17): tytuł szerszy o 1 pt od miejsca z tym odstępem
  /// wypycha całą grupę ikon do „⋯" przepełnienia paska, które jej nie pokazuje.
  static let barItemSpacing: CGFloat = 12
  /// Margines paska nawigacji telefonu od krawędzi ekranu: 20 pt na szerokim modelu, 16 pt na węższym. Zmierzone
  /// na iOS 27: iPhone Air (420 pt) i 18 Pro Max (440 pt) — 20, iPhone 17 (402 pt) — 16, więc próg leży
  /// między 402 a 420 pt.
  static let phoneWideBarMinWidth: CGFloat = 414
  static func phoneBarSideInset(columnWidth: CGFloat) -> CGFloat { columnWidth >= phoneWideBarMinWidth ? 20 : 16 }

  /// Najszerszy tytuł na telefonie: kolumna bez marginesów paska z obu stron, „wstecz", kompletu ikon i dwóch
  /// odstępów paska (wzór iPada z marginesem 16 pt i odstępami 2 i 16 pt chowałby ikony w „⋯" przy długiej nazwie
  /// albo ścieżce projektu).
  static func phoneTitleMaxWidth(columnWidth: CGFloat, closeArmed: Bool = false) -> CGFloat? {
    guard columnWidth > 0 else { return nil }
    let side = phoneBarSideInset(columnWidth: columnWidth)
    let armed = closeArmed ? armedCloseExtra : 0
    return max(0, columnWidth - 2 * side - iconTarget - 2 * barItemSpacing - trailingIconsWidth - armed)
  }
}

/// Które ikony stoją w prawym górnym rogu nagłówka (`HeaderSessionSlot` rysuje je w tej kolejności). Na telefonie
/// (`compact`) najwyżej ``HeaderMetrics/trailingIconsMax``: przy czterech system chowa całą grupę w „⋯"
/// przepełnienia paska, które grupy nie pokazuje, więc tapnięcie nic nie robi (ekran terminala: „Terminal
/// w oknie", zegar, „⋯" i „×"). „Terminal w oknie" wchodzi wtedy do „⋯"
/// terminala — w pasku zostają trzy ikony, a żadna akcja nie znika. The Recent Sessions clock does not stand here: it
/// is a button in the project header of the list, so a phone shows at most three icons anyway and
/// the move to the menu is a guard for a fourth icon.
struct HeaderTrailingIcons: Equatable {
  /// „Terminal w oknie" ikoną w pasku.
  private(set) var popup: Bool
  /// „Terminal w oknie" pozycją menu „⋯" terminala.
  private(set) var popupInMenu = false
  let inspector: Bool
  /// „⋯" terminala.
  let terminalMenu: Bool
  /// „×" terminala; przy „×" sesji obok go nie ma (wpis agenta w terminalu Raroga zamyka panel sam).
  let terminalClose: Bool
  let sessionClose: Bool

  init(popup: Bool, inspector: Bool, terminal: Bool, sessionClose: Bool, compact: Bool) {
    self.popup = popup
    self.inspector = inspector
    terminalMenu = terminal
    terminalClose = terminal && !sessionClose
    self.sessionClose = sessionClose
    if compact && terminal && count > HeaderMetrics.trailingIconsMax {
      self.popup = false
      popupInMenu = popup
    }
  }

  /// Ikony w pasku.
  var count: Int {
    [popup, inspector, terminalMenu, terminalClose, sessionClose].filter { $0 }.count
  }
}
