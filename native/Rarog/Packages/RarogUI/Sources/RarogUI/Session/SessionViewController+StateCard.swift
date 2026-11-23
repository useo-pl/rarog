#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Karta stanu w miejscu pola wiadomości: pole znika, gdy zamiast niego stoi
// karta (Wznów, limit, gotowe…) albo dok decyzji (`+Dock`), gdy karta decyzji czeka w transkrypcie (tryb
// `.transcript`), albo gdy sesji jeszcze/już nie ma na liście.
// Karta to SwiftUI (`StateCardView`) w `stateCardSlot`, który stoi z polem w jednym stosie. Właściciel: karty.
extension SessionViewController {
  /// Wstawia kartę stanu. Woła host ekranu przy tworzeniu kontrolera: SwiftUI osadzone w UIKit nie
  /// dziedziczy środowiska, więc nawigację (zamknięcie, nowa sesja) podaje on.
  func installStateCard(navigation: RarogNavigation) {
    let host = UIHostingController(
      rootView: StateCardView(store: store, sessionId: sessionId).environment(navigation).textScaleHost())
    host.sizingOptions = [.intrinsicContentSize]
    host.safeAreaRegions = []
    host.view.backgroundColor = .clear
    host.view.translatesAutoresizingMaskIntoConstraints = false
    addChild(host)
    stateCardSlot.addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: stateCardSlot.topAnchor),
      host.view.leadingAnchor.constraint(equalTo: stateCardSlot.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: stateCardSlot.trailingAnchor),
      host.view.bottomAnchor.constraint(equalTo: stateCardSlot.bottomAnchor),
    ])
    host.didMove(toParent: self)
  }

  /// Pole, dok decyzji albo karta stanu — nigdy dwa naraz i nigdy pole bez sesji. Reguła stopy:
  /// `FootContent` z renderu, miejsce karty decyzji: `DecisionDock.placement` (`+Dock`).
  func renderStateCard(_ state: AppState) {
    let foot = footContent
    let composerShown: Bool
    switch foot {
    case .none, .stateCard: composerShown = false
    case .composer: composerShown = true
    // Decyzja chowa pole według trybu (`DecisionDock.placement`): przy `.transcript` karta (albo zastępnik) stoi
    // w transkrypcie, a stopa jest pusta; przy `.dock` w miejscu pola staje dok; przy `.readOnlyComposer` pole zostaje
    // tylko do odczytu pod kartą w transkrypcie.
    case .decision: composerShown = !dockPlacement.hidesComposer
    }
    let cardShown = foot == .stateCard
    let dockShown = dockModel != nil && !composerShown
    renderDock()
    let composerHadVoiceOver = !composerShown && !composer.isHidden && voiceOverFocusInComposer()
    if composer.isHidden == composerShown {
      // Pole znika razem z klawiaturą; szkic, załączniki i tekst z dyktowania zostają w polu na powrót sesji do pracy.
      if !composerShown, composer.textView.isFirstResponder { composer.textView.resignFirstResponder() }
      composer.isHidden = !composerShown
    }
    if decisionSlot.isHidden == dockShown { decisionSlot.isHidden = !dockShown }
    if stateCardSlot.isHidden == cardShown { stateCardSlot.isHidden = !cardShown }
    // The activity row follows the field: its first line, or its own narrow card over the rest of the foot.
    placeActivityRow()
    moveVoiceOverToDecision(composerHadFocus: composerHadVoiceOver)
    footFrames.append((composer: !composer.isHidden, dock: !decisionSlot.isHidden))
    if footFrames.count > 64 { footFrames.removeFirst(footFrames.count - 64) }
  }
}
#endif
