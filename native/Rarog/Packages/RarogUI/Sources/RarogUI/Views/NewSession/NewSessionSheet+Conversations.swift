#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Conversations section of the "New Session" sheet: conversations in the
// chosen directory in two groups, "Open" over "Resumable", with "Resume", "Fork" and going to an open conversation;
// while the directory browser is open, one sentence instead. Owner: session control.

extension NewSessionSheet {
  // MARK: - Rozmowy

  var resumeSection: some View {
    Section {
      if browser.browsing {
        Text(UICopy.resumeAfterChoice).appFont(.footnote).foregroundStyle(Color(uiColor: Palette.muted))
          .accessibilityIdentifier("newSession.resumeStatus")
      } else {
        if let status = resumes.status {
          Text(status).appFont(.footnote).foregroundStyle(Color(uiColor: Palette.muted))
            .accessibilityIdentifier("newSession.resumeStatus")
        }
        ForEach(ResumeGroups.split(resumes.entries)) { group in
          // Group label in capitals, as in mockup variant C: "Open" above "Resumable".
          Text(UICopy.resumeGroup(group.kind))
            .appFont(.caption)
            .textCase(.uppercase)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier(group.kind == .open ? "newSession.resumeOpen" : "newSession.resumeResumable")
          ForEach(group.entries, id: \.engineSessionId) { entry in
            ResumeRowView(
              entry: entry, now: Date(), busy: resumes.busy == entry.engineSessionId, disabled: resumes.busy != nil,
              stacked: stackedRows, error: resumes.errors[entry.engineSessionId],
              resume: { Task { await resume(entry, fork: false) } },
              open: { open(entry) },
              fork: { Task { await resume(entry, fork: true) } })
            // A one-line row has a 44 pt target by itself; the default cell insets added ~22 pt and an iPad showed
            // a row and a half (screenshot). 4 pt, not 2: at 2 pt the card corner clipped the pointer highlight of
            // the first and last row (simulator screenshot); highlights are now 8 pt apart.
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
          }
        }
      }
    } header: {
      Text(UICopy.resumeTitle).foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityIdentifier("newSession.resumeHeader")
    } footer: {
      if !browser.browsing, !resumes.entries.isEmpty {
        Text(UICopy.resumeSettingsNote).accessibilityIdentifier("newSession.resumeNote")
      }
    }
  }

  /// Wiersz rozmowy w jednej linii tylko w szerokim arkuszu; węższy (iPhone, Split View) stawia metadane pod tytułem.
  private var stackedRows: Bool { sheetSize.width < Self.oneLineStartWidth }

  func loadResumes(_ dir: String?) async {
    guard dir != resumes.cwd else { return }
    resumes = ResumeSection(cwd: dir, status: dir == nil ? nil : UICopy.resumeSearching)
    guard let dir else { return }
    let outcome = await store.resumableSessions(cwd: dir)
    guard resumes.cwd == dir, presenter.isCurrent(request) else { return }
    switch outcome {
    case let .loaded(entries):
      resumes.entries = entries
      resumes.status = entries.isEmpty ? UICopy.resumeEmpty : nil
    case .failed:
      // Ton neutralny: brak listy niczego nie blokuje, obok stoi kompletny formularz.
      resumes.status = UICopy.resumeListFailed
    case .loggedOut:
      break
    }
  }

  private func resume(_ entry: ResumableSession, fork: Bool) async {
    guard !requesting else { return }
    resuming = true
    defer { resuming = false }
    resumes.busy = entry.engineSessionId
    resumes.errors[entry.engineSessionId] = nil
    Announcer.shared.say(fork ? UICopy.forking : UICopy.resuming)
    // Kontynuacja rozmowy: model i tryb z ustawień konta, nie z formularza.
    let body = CreateSessionBody(cwd: entry.cwd, resumeFrom: entry.engineSessionId, fork: fork ? true : nil)
    let outcome = await store.launchSession(body)
    resumes.busy = nil
    guard presenter.isCurrent(request) else { return }
    if case .created = outcome {
      finish(outcome, failure: "")
    } else if let message = UICopy.launchMessage(outcome, fallback: fork ? UICopy.forkRowFailed : UICopy.resumeRowFailed) {
      resumes.errors[entry.engineSessionId] = message
      Announcer.shared.say(message, priority: .urgent)
    }
  }

  /// Przejście do otwartej rozmowy: karta z `sessionId` wpisu. Bez celu okno zostaje, a zdanie
  /// stoi przy wierszu — dawniej okno się zamykało i zdanie trafiało na listę, z dala od tego, co stuknięto.
  private func open(_ entry: ResumableSession) {
    guard !requesting else { return }
    let state = store.state
    guard let id = ResumeRow.openTarget(entry, in: state) else {
      let message = ResumeRow.openMiss(entry, in: state)
      resumes.errors[entry.engineSessionId] = message
      Announcer.shared.say(message, priority: .urgent)
      return
    }
    presenter.close(request)
    navigation.detail = .session(id)
  }
}

/// Stan sekcji „Wznów istniejącą": katalog, dla którego wisi (albo doszła) odpowiedź.
struct ResumeSection: Equatable {
  var cwd: String?
  var status: String?
  var entries: [ResumableSession] = []
  /// Wiersz, którego „Wznów"/„Rozwidl" trwa.
  var busy: String?
  var errors: [String: String] = [:]
}
#endif
