#if os(iOS)
import UIKit

// Theme and text of the transcript cells. Going to the background, iOS takes app switcher snapshots in BOTH
// themes, so the screen's traits change there and back; rebuilding all cells on each change (new texts, new
// heights) would make the list reach its place over several frames and lose the text selection on return. So in
// the background a change is only recorded, and in the foreground cells are rebuilt ONLY for a real difference
// from the traits they were configured with. Owner: transcript.

/// Cechy, od których zależy konfiguracja komórek: motyw (kolory warstw) i rozmiar pisma (Dynamic Type), and the
/// transcript width and density modes.
struct TranscriptLook: Equatable {
  let style: UIUserInterfaceStyle
  let category: UIContentSizeCategory
  /// The app's text size on the flat path (`Fonts.category`), where a step changes no trait; Large on the standard
  /// path, so there only the traits decide.
  let scale: TextSizeCategory
  /// The transcript width mode (``TranscriptWidth``): it decides where the agent's prose ends.
  let fullWidth: Bool
  /// The transcript density (``TranscriptDensity``): the gaps between elements and the side margin.
  let density: TranscriptDensityMode

  init(_ traits: UITraitCollection, fullWidth: Bool, density: TranscriptDensityMode = .standard) {
    style = traits.userInterfaceStyle
    category = traits.preferredContentSizeCategory
    scale = Fonts.category
    self.fullWidth = fullWidth
    self.density = density
  }
}

/// Faza apki dla transkryptu: w tle zmiany cech pochodzą ze zrzutów przełącznika, nie od człowieka.
@MainActor
enum TranscriptAppPhase {
  /// Testy podmieniają (w procesie testów apka jest zawsze na wierzchu).
  static var isBackground: () -> Bool = { UIApplication.shared.applicationState == .background }
  /// Powrót na wierzch — tu rozstrzyga się zmiana cech z tła.
  static let foreground = UIApplication.willEnterForegroundNotification
}

extension SessionViewController {
  /// `viewDidLoad`: powrót na wierzch rozstrzyga zmianę cech z tła.
  func installLook() {
    NotificationCenter.default.addObserver(
      self, selector: #selector(lookForeground), name: TranscriptAppPhase.foreground, object: nil)
  }

  /// Zmiana motywu albo pisma: w tle tylko znacznik, na wierzchu przebudowa przy realnej różnicy.
  func lookChanged() {
    if TranscriptAppPhase.isBackground() {
      readingChrome.lookPending = true
      return
    }
    applyLookIfChanged()
  }

  @objc func lookForeground() {
    guard readingChrome.lookPending else { return }
    readingChrome.lookPending = false
    applyLookIfChanged()
  }

  /// Przebudowa komórek (pamięć markdownu i rekonfiguracja) tylko, gdy motyw albo pismo różnią się od tych,
  /// z którymi komórki skonfigurowano — ten sam motyw po powrocie z tła nie rusza ani wysokości, ani zaznaczenia.
  func applyLookIfChanged() {
    let look = currentLook()
    guard let configured = readingChrome.look else {
      readingChrome.look = look
      return
    }
    guard look != configured else { return }
    readingChrome.look = look
    markdown.removeAll()
    reconfigureAll()
    // A density change moves the side inset of the list and the quote bar with it (`+Spacing`).
    if look.density != configured.density { applyTranscriptSides() }
  }

  /// The look the cells are configured with now: the screen's traits and the two transcript modes from Settings.
  func currentLook() -> TranscriptLook {
    TranscriptLook(traitCollection, fullWidth: transcriptWidth.full, density: transcriptDensity.mode)
  }
}
#endif
