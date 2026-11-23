import Foundation
import RarogCore
#if os(iOS)
import SwiftUI
import UIKit
#endif

// Wejścia parowania: skaner QR, „Mam link” i arkusz „Sparować z <host>?”. Te same kontrolki stoją
// na ekranie startowym (bez serwera, po odpięciu) i w „Ustawieniach” — każda droga kończy
// się kartą potwierdzenia, link nigdy nie podmienia serwera po cichu. Stan: `AppState.pairing.flow`.
// A link to another server than the paired one (the store's `PairingState.replacedServer`) gets a
// warning with "Cancel" as the default and "Replace"; every link with a server key shows its fingerprint. The controls
// and the warning are plain types, so `swift test` checks them on macOS (`PairingCopyTests`); the SwiftUI views below
// draw from them.

/// A control of the pairing card (`PairingFlowCard.controls`, ``PairingReplaceWarning/controls``).
enum PairingCardControl: Hashable, Sendable {
  case confirm, retry, cancel
  /// "Replace": pairs with a link to another server than the paired one (`confirmPairing(replacing: true)`).
  case replace
  /// "Pairing…" with a spinner: the request is on its way, no "Cancel".
  case busy
  /// A spinner beside "Cancel" while the relay has not admitted the server yet (the sentence is the card's detail).
  case waiting

  var identifier: String {
    switch self {
    case .confirm: "pair.confirm"
    case .replace: "pair.replace"
    case .retry: "pair.retry"
    case .cancel: "pair.cancel"
    case .busy: "pair.busy"
    case .waiting: "pair.waiting"
    }
  }
}

/// The card's warning while a link to another server than the paired one waits for confirmation:
/// the sentence names the paired server, and "Cancel" stands first in place of "Pair", drawn as the main action and
/// on Return, so the habitual tap and key do not replace the pairing. "Replace" is the second control.
struct PairingReplaceWarning: Equatable, Sendable {
  let text: String
  /// The card's controls from left to right in place of "Pair" and "Cancel".
  let controls: [PairingCardControl] = [.cancel, .replace]
  /// The control drawn as the main action and run by Return.
  let defaultControl: PairingCardControl = .cancel

  /// `nil` = no warning: the sheet does not wait for confirmation (the request after "Replace" is on its way), there
  /// is no paired server (first pairing), or the link leads to the paired server. The rule of "another server" is the
  /// store's (`PairingState.replacedServer`).
  init?(_ pairing: PairingState) {
    guard case .confirming = pairing.flow, let paired = pairing.replacedServer else { return nil }
    text = UICopy.pairReplaceWarning(paired)
  }
}

#if os(iOS)

/// „Skanuj kod QR” i „Mam link”. Zły tekst = zdanie pod polem, arkusz bez zmian.
struct PairingActions: View {
  let store: RarogStore
  @State private var linkOpen = false
  @State private var text = ""
  @State private var problem: String?
  @State private var scanning = false
  @FocusState private var fieldFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        if PairingScanner.isAvailable {
          Button(UICopy.pairScan, systemImage: "qrcode.viewfinder") { scanning.toggle() }
            .buttonStyle(NeutralButtonStyle())
            .accessibilityIdentifier("pair.scan")
        }
        Button(UICopy.pairHaveLink, systemImage: "link") {
          linkOpen.toggle()
          if linkOpen { fieldFocused = true }
        }
        .buttonStyle(NeutralButtonStyle())
        .accessibilityIdentifier("pair.haveLink")
      }
      if scanning {
        PairingScannerPanel { scanned in
          scanning = false
          offer(scanned)
        } close: {
          scanning = false
        }
      }
      if linkOpen { linkField }
    }
  }

  private var linkField: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(UICopy.pairLinkField)
        .eyebrow()
        .accessibilityHidden(true)
      HStack(spacing: 8) {
        TextField(UICopy.pairLinkField, text: $text, prompt: Text(UICopy.pairLinkPrompt))
          .accessibilityLabel(UICopy.pairLinkField)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .submitLabel(.go)
          .focused($fieldFocused)
          .onSubmit { offer(text) }
          .appFont(.body)
          .padding(.horizontal, 12)
          .frame(minHeight: 44)
          .background(Color(uiColor: Palette.input), in: .inner)
          .overlay(RoundedRectangle.inner.strokeBorder(Color(uiColor: Palette.border)))
          .accessibilityIdentifier("pair.link")
        // Przycisk systemu: wklejenie bez pytania „Pozwolić na wklejenie?” (gest człowieka jest zgodą).
        PasteButton(payloadType: String.self) { strings in
          if let pasted = strings.first { text = pasted }
        }
        .labelStyle(.iconOnly)
        .accessibilityIdentifier("pair.paste")
      }
      Button(UICopy.pairLinkNext) { offer(text) }
        .buttonStyle(NeutralButtonStyle())
        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("pair.next")
      if let problem {
        Text(problem)
          .appFont(.callout)
          .foregroundStyle(Color(uiColor: Palette.err))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("pair.linkProblem")
      }
    }
  }

  private func offer(_ value: String) {
    problem = store.offerPairing(text: value).map(UICopy.pairLinkError)
    if problem == nil {
      text = ""
      linkOpen = false
    }
  }
}

/// The sheet's card: "Pair with <host>?" with "Pair" and "Cancel", "Pairing…" while the request is on its way, the
/// server's sentence after a refusal. A link to another server than the paired one: the warning, "Cancel" as the
/// default and "Replace" (``PairingReplaceWarning``). Empty when nothing waits.
struct PairingFlowCard: View {
  let store: RarogStore

  var body: some View {
    let flow = store.state.pairing.flow
    let warning = PairingReplaceWarning(store.state.pairing)
    if flow.isActive {
      VStack(alignment: .leading, spacing: 12) {
        Text(Self.title(flow))
          .appFont(.headline)
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier("pair.confirm.title")
        if let link = flow.link {
          Text(verbatim: UICopy.pairConfirmSubtitle(link))
            .appFont(.callout.monospaced())
            .foregroundStyle(Color(uiColor: Palette.muted))
            .textSelection(.enabled)
          if let fingerprint = UICopy.pairFingerprint(link) {
            Text(fingerprint)
              .appFont(.callout.monospaced())
              .foregroundStyle(Color(uiColor: Palette.muted))
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
              .accessibilityIdentifier("pair.confirm.fingerprint")
          }
        }
        if let warning {
          Text(warning.text)
            .appFont(.callout.weight(.semibold))
            .foregroundStyle(Color(uiColor: Palette.wait))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("pair.confirm.warning")
        }
        if let detail = Self.detail(flow) {
          Text(detail)
            .appFont(.callout)
            .foregroundStyle(Color(uiColor: isFailure(flow) ? Palette.err : Palette.muted))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("pair.confirm.detail")
        }
        HStack(spacing: 8) {
          ForEach(warning?.controls ?? Self.controls(flow), id: \.self) { control in
            switch control {
            case .confirm:
              // The task confirms the link drawn here (`shown`), not one offered before the task starts.
              Button(UICopy.pairConfirm) { Task { await store.confirmPairing(shown: flow.link) } }
                .buttonStyle(PrimaryButtonStyle(size: .inline))
                .accessibilityIdentifier(control.identifier)
            case .replace:
              Button(UICopy.pairReplace, role: .destructive) {
                Task { await store.confirmPairing(replacing: true, shown: flow.link) }
              }
                .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.err)))
                .accessibilityIdentifier(control.identifier)
            case .cancel where warning?.defaultControl == .cancel:
              Button(UICopy.pairCancel) { Self.cancel(store) }
                .buttonStyle(PrimaryButtonStyle(size: .inline))
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier(control.identifier)
            case .retry:
              if let link = flow.link {
                Button(UICopy.unknownRetry) { store.offerPairing(link) }
                  .buttonStyle(NeutralButtonStyle())
                  .accessibilityIdentifier(control.identifier)
              }
            case .busy:
              ProgressView()
              Text(UICopy.pairBusy).appFont(.callout).foregroundStyle(Color(uiColor: Palette.muted))
            case .waiting:
              ProgressView()
            case .cancel:
              Button(UICopy.pairCancel) { Self.cancel(store) }
                .buttonStyle(NeutralButtonStyle())
                .accessibilityIdentifier(control.identifier)
            }
          }
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(uiColor: Palette.surface), in: .block)
      .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("pair.card")
    }
  }

  /// Tytuł karty według celu linku (`UICopy.pairConfirmTitle(_:)` dla `PairingLink`).
  static func title(_ flow: PairingFlow) -> String {
    if case .rejected = flow { return UICopy.pairRejectedTitle }
    return flow.link.map(UICopy.pairConfirmTitle) ?? UICopy.pairConfirmTitle("")
  }

  /// The line under the title: the question, the wait for the relay (`waitingForRelay`) or the refusal.
  static func detail(_ flow: PairingFlow) -> String? {
    switch flow {
    case .idle, .pairing: nil
    case .waitingForRelay: UICopy.pairWaitingForRelay
    case .confirming: UICopy.pairConfirmBody
    case let .failed(_, failure): UICopy.pairFailure(failure)
    case let .rejected(error): UICopy.pairLinkError(error)
    }
  }

  /// The card's controls from left to right. `.pairing` has no "Cancel" (the request is on its way); while the relay
  /// has not admitted a freshly sponsored server yet (from the first request on), "Cancel" ends the pairing
  /// (`RarogStore.cancelPairing`). A link to another server than the paired one draws
  /// ``PairingReplaceWarning/controls`` instead of `.confirming`'s.
  static func controls(_ flow: PairingFlow) -> [PairingCardControl] {
    switch flow {
    case .confirming: [.confirm, .cancel]
    case .failed: [.retry, .cancel]
    case .pairing: [.busy]
    case .waitingForRelay: [.waiting, .cancel]
    case .idle, .rejected: [.cancel]
    }
  }

  /// "Cancel" of the card.
  static func cancel(_ store: RarogStore) { store.cancelPairing() }

  private func isFailure(_ flow: PairingFlow) -> Bool {
    switch flow {
    case .failed, .rejected: true
    case .idle, .confirming, .pairing, .waitingForRelay: false
    }
  }
}
#endif
