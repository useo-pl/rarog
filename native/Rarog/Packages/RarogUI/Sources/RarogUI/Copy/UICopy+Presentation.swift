import Foundation

// Arkusze apki: teksty wspólnego szkieletu (`Views/Presentation/SheetScaffold`).
extension UICopy {
  /// Zamknięcie listy „Ostatnie sesje” (dymki na telefonie przycisku zamknięcia nie mają).
  static var popoverClose: String { L("presentation.close") }
  /// Tytuły dymków w pasku arkusza na telefonie (na iPadzie dymek nie ma paska).
  static var popoverBackgroundTitle: String { L("presentation.backgroundTitle") }
  static var popoverGitTitle: String { L("presentation.gitTitle") }
}
