import Foundation
import RarogContract
import RarogCore

// Formularz „Nowa sesja", „Wznów istniejącą" i ekran „Ostatnie sesje". Właściciel: sterowanie sesją.
extension UICopy {
  // MARK: Formularz

  public static var newSessionTitle: String { L("newSession.title") }
  public static var newSessionOpen: String { L("newSession.open") }
  static var launch: String { L("newSession.launch") }
  static var launching: String { L("newSession.launching") }
  static var launchFailed: String { L("newSession.launchFailed") }
  static var projectLabel: String { L("newSession.projectLabel") }
  static var startLabel: String { L("newSession.startLabel") }
  static var changeProject: String { L("newSession.changeProject") }
  static var changeDirectory: String { L("newSession.changeDirectory") }
  static var directoryUp: String { L("newSession.directoryUp") }
  static var modeLabel: String { L("newSession.modeLabel") }
  static var modelLabel: String { L("newSession.modelLabel") }
  static var effortLabel: String { L("newSession.effortLabel") }
  /// Effort bez flagi: panel wstaje na poziomie z ustawień konta (`effortLevel` w `~/.claude/settings.json`).
  static var effortAuto: String { L("newSession.effortAuto") }
  static var effortAutoShort: String { L("newSession.effortAutoShort") }
  static var modelAccountDefault: String { L("newSession.modelAccountDefault") }
  static var modelAccountShort: String { L("newSession.modelAccountShort") }
  static var enterProject: String { L("newSession.enterProject") }
  /// Przełącznik startu z ultracode i zdanie pod nim, tylko przy włączonym: co daje i ile kosztuje.
  static var ultracodeLabel: String { L("newSession.ultracodeLabel") }
  static var ultracodeStartNote: String { L("newSession.ultracodeStartNote") }

  /// Segment przełącznika, pozycja menu trybu w piśmie dostępności i słowo trybu w podsumowaniu.
  static func startModeShort(_ mode: StartMode) -> String {
    switch mode {
    case .auto: L("newSession.startModeShort.auto")
    case .manual: L("newSession.startModeShort.manual")
    case .acceptEdits: L("newSession.startModeShort.acceptEdits")
    case .plan: L("newSession.startModeShort.plan")
    }
  }

  /// Zdanie pod przełącznikiem — dla auto jest ostrzeżeniem od pierwszej klatki. Treść według
  /// dokumentacji trybów CLI: reguły `allow` i `ask` działają w każdym trybie, więc zdania nie
  /// obiecują „pyta o wszystko” ani „nie pyta nigdy”. Jedna linia na iPadzie: zdanie ma być czytane, nie omijane.
  static func startModeHint(_ mode: StartMode) -> String {
    switch mode {
    case .plan: L("newSession.startModeHint.plan")
    case .manual: L("newSession.startModeHint.manual")
    case .acceptEdits: L("newSession.startModeHint.acceptEdits")
    case .auto: L("newSession.startModeHint.auto")
    }
  }

  /// „9 zmian” w linii kontekstu projektu.
  static func dirtyFiles(_ n: Int) -> String { L("newSession.dirtyFiles", n) }
  /// „2 otwarte sesje” w linii kontekstu projektu.
  static func openSessions(_ n: Int) -> String { L("newSession.openSessions", n) }

  /// Wynik „Uruchom"/„Wznów"/„Rozwidl" do pokazania w formularzu; `nil` = bez zdania.
  static func launchMessage(_ outcome: LaunchOutcome, fallback: String) -> String? {
    switch outcome {
    case .created, .loggedOut: nil
    case let .blocked(detail): launchBlocked(detail)
    case let .cwdRefused(message), let .ultracodeRefused(message), let .refused(message): message ?? fallback
    case .offline: serverSilent
    case .timedOut: timedOut
    case .failed: fallback
    }
  }

  /// Folded Start section while the browser is open: next to the settings summary.
  static var startAfterChoice: String { L("newSession.startAfterChoice") }
  /// Conversations section while the browser is open.
  static var resumeAfterChoice: String { L("newSession.resumeAfterChoice") }

  // MARK: Przeglądarka katalogów

  static var dirEmpty: String { L("newSession.dirEmpty") }
  static var dirNoRoots: String { L("newSession.dirNoRoots") }
  static var dirFailed: String { L("newSession.dirFailed") }
  static var filterPlaceholder: String { L("newSession.filterPlaceholder") }
  /// Footer while the browser is open, beside Cancel and Choose.
  static var browseHint: String { L("newSession.browseHint") }
  static var moreProjects: String { L("newSession.moreProjects") }
  static var chooseAnyway: String { L("newSession.chooseAnyway") }
  /// Muted word on the row of the directory chosen in the window.
  static var dirCurrent: String { L("newSession.dirCurrent") }

  static func dirNothingMatches(_ filter: String) -> String { L("newSession.dirNothingMatches", filter) }
  static func dirTruncated(_ shown: Int) -> String { L("newSession.dirTruncated", shown) }
  /// "Choose rarog-site": the button in the footer while the browser is open.
  static func choose(_ name: String) -> String { L("newSession.choose", name) }

  /// Warning before choosing a directory without `git` and without history; `known == false` = the server says
  /// nothing about it.
  static func chooseWarning(_ path: String, known: Bool) -> String {
    known ? L("newSession.chooseWarning.plain", path) : L("newSession.chooseWarning.unknown", path)
  }

  /// Znacznik katalogu z historią rozmów CLI obok nazwy (ukryty przed czytnikiem: ten słyszy `dirRowSpoken`).
  static var historyMarker: String { L("newSession.historyMarker") }

  /// Directory row for VoiceOver (a tap opens it, ``dirRowHint``): the name and the marks in words.
  static func dirRowSpoken(_ entry: DirEntry, marks: [DirMark]) -> String {
    let words = marks.map { mark in
      switch mark {
      case .current: dirCurrent
      case .git: L("newSession.dirRowSpoken.git")
      case .history: L("newSession.dirRowSpoken.history")
      }
    }
    return list([entry.name] + words, .comma)
  }

  static var dirRowHint: String { L("newSession.dirRowHint") }

  /// Up before the path: "Up to Projects"; plain "Up" towards the roots level and when it is disabled.
  static func upSpoken(_ step: UpStep?) -> String {
    guard case let .directory(parent) = step else { return directoryUp }
    return L("newSession.upTo", PathText.projectName(parent))
  }

  /// Header of a conversation group (mockup variant C).
  static func resumeGroup(_ kind: ResumeGroups.Kind) -> String {
    switch kind {
    case .open: L("newSession.resumeGroupOpen")
    case .resumable: L("newSession.resumeGroupResumable")
    }
  }

  static func directoryError(_ outcome: DirectoryOutcome) -> String {
    switch outcome {
    case let .refused(message): message ?? dirFailed
    case .offline: serverSilent
    case .timedOut: timedOut
    case .loaded, .failed, .loggedOut: dirFailed
    }
  }

  // MARK: New Directory

  /// Button beside Up (a folder glyph) and its VoiceOver label.
  static var newDirectory: String { L("newSession.newDirectory") }
  static var newDirectoryPlaceholder: String { L("newSession.newDirectoryPlaceholder") }
  static var createDirectory: String { L("newSession.createDirectory") }
  /// A refusal without the server's sentence and an unreadable reply.
  static var createDirFailed: String { L("newSession.createDirFailed") }

  /// Sentence under the name field after a failed New Directory.
  static func createDirError(_ outcome: DirectoryCreateOutcome) -> String {
    switch outcome {
    case let .refused(message), let .exists(message): message ?? createDirFailed
    case .offline: serverSilent
    case .timedOut: timedOut
    case .created, .failed, .loggedOut: createDirFailed
    }
  }

  static func recentChipSpoken(_ cwd: String) -> String { L("newSession.recentChipSpoken", PathText.shortPath(cwd)) }
  /// Projekt dla czytnika: nazwa, ścieżka i linia kontekstu jednym zdaniem.
  static func projectSpoken(name: String, path: String, context: String?) -> String {
    list([name, path, context].compactMap { $0 }, .comma)
  }

  // MARK: Wznów istniejącą

  static var resumeTitle: String { L("newSession.resumeTitle") }
  /// Pod listą: wznowienie nie bierze ustawień z sekcji Start.
  static var resumeSettingsNote: String { L("newSession.resumeSettingsNote") }
  static var resumeLiveTag: String { L("newSession.resumeLiveTag") }
  static var resumeSearching: String { L("newSession.resumeSearching") }
  static var resumeEmpty: String { L("newSession.resumeEmpty") }
  /// Lista rozmów do wznowienia nie przyszła (inne zdanie niż `resumeFailed` karty stanu).
  static var resumeListFailed: String { L("newSession.resumeListFailed") }
  static var resumeUntitled: String { L("newSession.resumeUntitled") }
  // „Wznów" i „Wznawiam sesję…" — te same słowa co na karcie stanu: `UICopy+Cards`.
  static var resumeOpen: String { L("newSession.resumeOpen") }
  static var resumeFork: String { L("newSession.resumeFork") }
  static var forking: String { L("newSession.forking") }
  static var resumeRowFailed: String { L("newSession.resumeRowFailed") }
  static var forkRowFailed: String { L("newSession.forkRowFailed") }
  static var resumeOpenMissing: String { L("newSession.resumeOpenMissing") }
  static var resumeOpenAmbiguous: String { L("newSession.resumeOpenAmbiguous") }

  static func resumeSpoken(_ entry: ResumableSession) -> String { L("newSession.resumeSpoken", ResumeRow.title(entry)) }
  static func resumeOpenSpoken(_ entry: ResumableSession) -> String {
    L("newSession.resumeOpenSpoken", ResumeRow.title(entry))
  }
  static func resumeForkSpoken(_ entry: ResumableSession) -> String { L("newSession.resumeForkSpoken", ResumeRow.title(entry)) }

  /// Metadane wiersza zdaniem (skrót „4 min" na głos nie mówi, czy to chwila, czy tydzień).
  static func resumeMetaSpoken(_ entry: ResumableSession, now: Date) -> String {
    var parts: [String] = []
    if let at = ServerTime.parse(entry.mtime) {
      parts.append(L("newSession.resumeMetaSpoken.ago", spokenAgo(max(0, Int(now.timeIntervalSince(at).rounded())))))
    } else {
      parts.append(L("newSession.resumeMetaSpoken.unknownTime"))
    }
    if let branch = entry.gitBranch, !branch.isEmpty { parts.append(L("newSession.resumeMetaSpoken.branch", branch)) }
    if entry.liveInHerdr { parts.append(L("newSession.resumeMetaSpoken.liveInHerdr")) }
    return list(parts, .comma)
  }

  /// „4 godziny", „1 dzień" — mianownik do „ostatnio … temu" (`describeRelative` w PWA).
  static func spokenAgo(_ seconds: Int) -> String {
    if seconds < 60 { return L("newSession.spokenAgo.seconds", seconds) }
    let minutes = seconds / 60
    if minutes < 60 { return L("newSession.spokenAgo.minutes", minutes) }
    let hours = minutes / 60
    if hours < 24 { return L("newSession.spokenAgo.hours", hours) }
    return L("newSession.spokenAgo.days", hours / 24)
  }

  // MARK: Ostatnie sesje

  public static var recentSessionsTitle: String { L("newSession.recentSessionsTitle") }
  static var recentSessionsHint: String { L("newSession.recentSessionsHint") }
  static var recentSessionsEmpty: String { L("newSession.recentSessionsEmpty") }
  static var recentSessionsFailed: String { L("newSession.recentSessionsFailed") }

  /// Zegar w nagłówku: dokąd prowadzi.
  static func recentSessionsLabel(_ project: String) -> String { L("newSession.recentSessionsLabel", project) }
}
