#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// „Ostatnie sesje" projektu — z zegara w nagłówku sesji: 10 najświeższych ZAMKNIĘTYCH
/// rozmów do wznowienia (otwarte odsiewa serwer i mówi to jedno zdanie pod nagłówkiem). Skrót
/// powrotu, nie przegląd historii — cała historia katalogu stoi w „Wznów istniejącą". Globalnej
/// listy ponad projektami nie ma. Lista to migawka dysku: wczytana raz na wejście. Właściciel: sterowanie sesją.
struct RecentSessionsSheet: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let presenter: NewSessionPresenter
  let recent: NewSessionPresenter.Recent

  @State private var entries: [ResumableSession]?
  @State private var failed = false
  @State private var busy: String?
  @State private var errors: [String: String] = [:]
  /// Szerokość arkusza: wąski (iPhone, Split View) stawia metadane wiersza pod tytułem.
  @State private var width: CGFloat = 0

  var body: some View {
    FormSheet(
      title: UICopy.recentSessionsTitle,
      close: SheetClose(label: UICopy.popoverClose, identifier: "recent.close") { presenter.close(recent) },
      locked: busy != nil
    ) {
      List {
        Section {
          ForEach(entries ?? [], id: \.engineSessionId) { entry in
            ResumeRowView(
              entry: entry, now: Date(), busy: busy == entry.engineSessionId, disabled: busy != nil,
              stacked: width < NewSessionSheet.oneLineStartWidth, error: errors[entry.engineSessionId],
              resume: { Task { await resume(entry) } }, open: nil, fork: nil)
            // Gęstość jak w „Rozmowach w tym katalogu” (ten sam wiersz): cel 44 pt jest w wierszu, domyślne
            // marginesy komórki tylko go rozpychały.
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
          }
          if entries == nil, !failed {
            ForEach(0..<4, id: \.self) { _ in
              Text("ostatnia rozmowa w tym projekcie").redacted(reason: .placeholder).accessibilityHidden(true)
            }
          }
          if let status {
            Text(status).appFont(.footnote).foregroundStyle(Color(uiColor: Palette.muted))
              .accessibilityIdentifier("recent.status")
          }
        } header: {
          VStack(alignment: .leading, spacing: 4) {
            Text(projectLabel).appFont(.footnote.monospaced()).textCase(nil)
            Text(UICopy.recentSessionsHint).appFont(.footnote).textCase(nil)
          }
        }
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("recent.sheet")
    .task { await load() }
  }

  /// „willow · ~/Projects/willow" — który projekt, raz w nagłówku zamiast w każdym wierszu.
  private var projectLabel: String {
    let name = ProjectPath.name(recent.cwd)
    let path = PathText.shortPath(ProjectPath.normalized(recent.cwd))
    return name.isEmpty ? path : "\(name) · \(path)"
  }

  private var status: String? {
    if failed { return UICopy.recentSessionsFailed }
    if let entries, entries.isEmpty { return UICopy.recentSessionsEmpty }
    return nil
  }

  private func load() async {
    switch await store.resumableSessions(cwd: recent.cwd, recent: true) {
    case let .loaded(list): entries = list
    case .failed: failed = true
    case .loggedOut: break
    }
  }

  private func resume(_ entry: ResumableSession) async {
    guard busy == nil else { return }
    busy = entry.engineSessionId
    errors[entry.engineSessionId] = nil
    Announcer.shared.say(UICopy.resuming)
    let outcome = await store.launchSession(CreateSessionBody(cwd: entry.cwd, resumeFrom: entry.engineSessionId))
    busy = nil
    guard presenter.isCurrent(recent) else { return }
    if case let .created(id, _) = outcome {
      presenter.close(recent)
      navigation.openLaunched(id)
    } else if let message = UICopy.launchMessage(outcome, fallback: UICopy.resumeRowFailed) {
      // Powód z serwera: 409 „dwóch pisarzy" trzeba przeczytać — ponowienie nigdy się nie uda.
      errors[entry.engineSessionId] = message
      Announcer.shared.say(message, priority: .urgent)
    }
  }
}
#endif
