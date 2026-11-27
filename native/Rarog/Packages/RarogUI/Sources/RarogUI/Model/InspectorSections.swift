import Foundation
import RarogContract
import RarogCore

// Sections of the right panel other than the background one (shared with the popover, `BackgroundPanel`): recently
// finished from the harness notes at the transcript tail, artifacts from `SessionSummary.artifacts`, and the change
// state of the Files section from the `git-status` frame (its tree: `FileTree`, `InspectorFiles`). Pure functions,
// tests on macOS. Owner: panel.

/// Zadanie w tle, które się skończyło: notka harnessu z rodzajem, wynikiem i nazwą. Czasu końca serwer
/// nie daje osobno — niesie go wiadomość notki. Wiersz mówi oba czasy: ile temu („2 h temu", liczone przy
/// rysowaniu) i godzinę bezwzględną, a od doby wzwyż dzień zamiast godziny („3 d temu · 9 paź": sama godzina
/// nie mówi, którego dnia).
public struct FinishedTaskRow: Sendable, Equatable, Identifiable {
  public let id: String
  /// Rodzaj zadania słowem: komenda, subagent, workflow, monitor, zadanie. Oko widzi go tylko wtedy, gdy notka
  /// nie niesie nazwy (`title`); ucho słyszy zawsze (`spoken`).
  public let kind: String
  public let name: String?
  /// `nil` = plik wyniku nie mówi; brak wyniku NIE znaczy sukcesu.
  public let outcome: NoticeOutcome?
  public let exitCode: Int?
  /// Chwila końca (czas wiadomości notki); `nil`, gdy czas wiadomości nie jest czasem.
  public let at: Date?
  /// „14:05" tej chwili w strefie urządzenia.
  public let clock: String?
  /// „9 paź" tej chwili w strefie urządzenia.
  public let day: String?

  /// Pierwsza linia wiersza: nazwa zadania, a bez niej rodzaj słowem — wiersz z samym znakiem nic nie mówi.
  public var title: String { name ?? kind }

  /// „2 h temu" obok godziny; `nil` razem z nią.
  public func ago(now: Date) -> String? {
    at.map { RelativeTime.ago(since: $0, now: now) }
  }

  /// Skończyło się dobę temu albo dawniej: ta sama granica, od której „ile temu" liczy w dniach.
  private func daysAgo(now: Date) -> Bool {
    at.map { now.timeIntervalSince($0).rounded() >= 86_400 } ?? false
  }

  /// Chwila bezwzględna obok „ile temu": godzina, a od doby wzwyż dzień.
  public func stamp(now: Date) -> String? {
    daysAgo(now: now) ? day : clock
  }

  public func spoken(now: Date) -> String {
    UICopy.finishedTaskSpoken(
      kind: kind, name: name, outcome: outcome, exitCode: exitCode,
      ago: at.map { RelativeTime.spokenAgo(since: $0, now: now) },
      stamp: daysAgo(now: now) ? day : clock.map { "o \($0)" })
  }

  /// Dopisek wyniku pod nazwą („kod 1", „zatrzymane", „wynik nieznany"); `nil` przy sukcesie.
  public var note: String? { UICopy.finishedTaskNote(outcome: outcome, exitCode: exitCode) }

  /// Niepowodzenie: wiersz zostaje w pełnym atramencie, a dopisek z kodem idzie czerwienią.
  public var failed: Bool { outcome == .failed }
}

public enum FinishedTasks {
  /// How many recent ends the inspector panel and the pill's popover show: the latest few, so the panel's sections
  /// below stay in view.
  public static let limit = 3

  /// Ostatnie zakończenia zadań z załadowanego ogona transkryptu, najnowsze pierwsze. Zdarzenie monitora
  /// i sierota po restarcie CLI zakończeniem zadania nie są. Postój subagenta (`waiting`) też nie: agent stanął
  /// i czeka na własne zadanie w tle, więc nic się nie skończyło. Koniec obserwacji artefaktu też nie:
  /// to nie zadanie, a usunięcie artefaktu widać w jego wierszu.
  public static func rows(
    _ messages: [TranscriptMessage], limit: Int = limit, timeZone: TimeZone = .current
  ) -> [FinishedTaskRow] {
    var out: [FinishedTaskRow] = []
    for message in messages.reversed() where out.count < limit {
      guard let notice = message.notice, notice.outcome != .waiting, let kind = kindWord(notice.kind) else { continue }
      let name = notice.name.flatMap { $0.isEmpty ? nil : $0 }
      let at = ServerTime.parse(message.at)
      out.append(FinishedTaskRow(
        id: "m\(message.seq)", kind: kind, name: name, outcome: notice.outcome, exitCode: notice.exitCode,
        at: at, clock: at.map { ServerTime.clock($0, timeZone: timeZone) },
        day: at.map { ServerTime.day($0, timeZone: timeZone) }))
    }
    return out
  }

  static func kindWord(_ kind: NoticeKind) -> String? {
    switch kind {
    case .command: UICopy.backgroundKind(.command)
    case .agent: UICopy.backgroundKind(.agent)
    case .workflow: UICopy.backgroundKind(.workflow)
    case .monitorEnd: UICopy.backgroundKind(.monitor)
    case .unknown: UICopy.backgroundKind(.unsupported)
    case .monitorEvent, .orphan, .artifactWatch: nil
    }
  }
}

/// Artefakt (strona na claude.ai) opublikowany w bieżącej rozmowie sesji (`docs/artifacts.md`). Wiersz ma
/// gramatykę „Skończonych”: tytuł, pod nim ile temu i godzina ostatniej publikacji, od doby dzień zamiast godziny.
public struct ArtifactRow: Sendable, Equatable, Identifiable {
  /// Surowy adres z serwera — tożsamość wiersza, także gdy adres nie przeszedł gramatyki.
  public let id: String
  public let title: String
  /// Adres w gramatyce serwera (`ArtifactRows.link`); `nil` = wiersz niczego nie otwiera.
  public let url: URL?
  /// Artefakt usunięty na claude.ai: wiersz wygaszony, bez przycisku (link i tak nie działa).
  public let gone: Bool
  /// Chwila ostatniej publikacji; `nil`, gdy `publishedAt` nie jest czasem.
  public let at: Date?
  /// „14:05" tej chwili w strefie urządzenia.
  public let clock: String?
  /// „9 paź" tej chwili w strefie urządzenia.
  public let day: String?

  /// Co otwiera stuknięcie: adres w gramatyce przy artefakcie, który żyje. Inaczej wiersz nie jest przyciskiem.
  public var link: URL? { gone ? nil : url }

  /// „2 h temu" obok godziny; `nil` razem z nią.
  public func ago(now: Date) -> String? {
    at.map { RelativeTime.ago(since: $0, now: now) }
  }

  /// Opublikowany dobę temu albo dawniej: ta sama granica, od której „ile temu" liczy w dniach.
  private func daysAgo(now: Date) -> Bool {
    at.map { now.timeIntervalSince($0).rounded() >= 86_400 } ?? false
  }

  /// Chwila bezwzględna obok „ile temu": godzina, a od doby wzwyż dzień.
  public func stamp(now: Date) -> String? {
    daysAgo(now: now) ? day : clock
  }

  public func spoken(now: Date) -> String {
    UICopy.artifactSpoken(
      title: title, gone: gone, opens: link != nil,
      ago: at.map { RelativeTime.spokenAgo(since: $0, now: now) },
      stamp: daysAgo(now: now) ? day : clock.map { "o \($0)" })
  }
}

public enum ArtifactRows {
  /// Jedyna forma adresu, którą apka otwiera — ta sama gramatyka co na serwerze (`isArtifactUrl`
  /// w `server/src/herdr/background/notification.ts`): prefiks i identyfikator z liter i cyfr ASCII, nic więcej.
  static let prefix = "https://claude.ai/artifact/"

  /// Wiersze w kolejności serwera (najnowsza publikacja pierwsza). Powtórzony adres zostaje raz, pierwszy: adres
  /// jest tożsamością wiersza, a serwer i tak trzyma listę po adresie.
  public static func rows(_ artifacts: [SessionArtifact], timeZone: TimeZone = .current) -> [ArtifactRow] {
    var seen: Set<String> = []
    return artifacts.compactMap { artifact in
      guard seen.insert(artifact.url).inserted else { return nil }
      let at = ServerTime.parse(artifact.publishedAt)
      return ArtifactRow(
        id: artifact.url, title: artifact.title, url: link(artifact.url), gone: artifact.gone, at: at,
        clock: at.map { ServerTime.clock($0, timeZone: timeZone) },
        day: at.map { ServerTime.day($0, timeZone: timeZone) })
    }
  }

  /// Adres do otwarcia albo `nil`: CAŁY napis musi mieć formę `https://claude.ai/artifact/<id>`, gdzie `<id>` to
  /// niepusty ciąg liter i cyfr ASCII. Porównanie idzie po skalarach Unicode, więc znak łączący, port, dane
  /// użytkownika, dalszy segment, zapytanie, fragment, inny host, `http` i biały znak na końcu odpadają.
  static func link(_ raw: String) -> URL? {
    let scalars = raw.unicodeScalars
    let head = prefix.unicodeScalars
    guard scalars.starts(with: head) else { return nil }
    let id = scalars.dropFirst(head.count)
    guard !id.isEmpty, id.allSatisfy(isIdScalar) else { return nil }
    return URL(string: raw)
  }

  private static func isIdScalar(_ scalar: Unicode.Scalar) -> Bool {
    ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar)
  }
}

/// Pull request of the session's current conversation (`docs/pull-requests.md`): linked by a `pr-link` entry,
/// authored by the `gh` login. The row follows the artifact grammar: the first line is the GitHub title,
/// without it the `owner/repo#n` reference; under it the GitHub state label when the server knows it,
/// then the reference (when the first line is the title), how long ago and the creation time.
public struct PullRequestRow: Sendable, Equatable, Identifiable {
  /// Surowy adres z serwera — tożsamość wiersza, także gdy adres nie przeszedł gramatyki.
  public let id: String
  /// „acme/widget#42”.
  public let ref: String
  /// Tytuł z GitHuba; `nil` = serwer go nie przysłał.
  public let title: String?
  /// GitHub state from the server; `nil` = unknown, and the row reads as it did before states existed.
  public let state: PullRequestState?
  /// Adres w gramatyce serwera (`PullRequestRows.link`); `nil` = wiersz niczego nie otwiera.
  public let link: URL?
  /// Chwila utworzenia; `nil`, gdy `createdAt` nie jest czasem.
  public let at: Date?
  /// „14:05" tej chwili w strefie urządzenia.
  public let clock: String?
  /// „9 paź" tej chwili w strefie urządzenia.
  public let day: String?

  /// Pierwsza linia wiersza: tytuł, a bez niego odnośnik.
  public var heading: String { title ?? ref }

  /// „2 h temu" obok godziny; `nil` razem z nią.
  public func ago(now: Date) -> String? {
    at.map { RelativeTime.ago(since: $0, now: now) }
  }

  /// Utworzony dobę temu albo dawniej: ta sama granica, od której „ile temu" liczy w dniach.
  private func daysAgo(now: Date) -> Bool {
    at.map { now.timeIntervalSince($0).rounded() >= 86_400 } ?? false
  }

  /// Chwila bezwzględna obok „ile temu": godzina, a od doby wzwyż dzień.
  public func stamp(now: Date) -> String? {
    daysAgo(now: now) ? day : clock
  }

  /// Word of the state label that opens the line under the first; `nil` = no label.
  public var stateWord: String? { state.map { UICopy.pullRequestState($0) } }

  /// The rest of the line under the first, after the state label: the reference (only when the first line is the
  /// title), how long ago and the moment.
  public func status(now: Date) -> [String] {
    ((title != nil ? [ref] : []) + [ago(now: now), stamp(now: now)]).compactMap { $0 }
  }

  public func spoken(now: Date) -> String {
    UICopy.pullRequestSpoken(
      ref: ref, title: title, state: stateWord, opens: link != nil,
      ago: at.map { RelativeTime.spokenAgo(since: $0, now: now) },
      stamp: daysAgo(now: now) ? day : clock.map(UICopy.pullRequestSpokenAt))
  }
}

/// The PR section split in two: rows in view and rows folded under one "Merged and Closed (N)" row at the end.
public struct PullRequestSplit: Sendable, Equatable {
  /// `open`, `draft` and unknown state, in server order: a PR not known to be finished stays in view.
  public let shown: [PullRequestRow]
  /// `merged` and `closed`, in server order; empty = no folded row.
  public let folded: [PullRequestRow]
}

public enum PullRequestRows {
  /// Finished PRs (`merged`, `closed`) fold away, the rest stay in view (only open PRs and drafts
  /// in view). Both keep the server order.
  public static func split(_ rows: [PullRequestRow]) -> PullRequestSplit {
    let finished: (PullRequestRow) -> Bool = { $0.state == .merged || $0.state == .closed }
    return PullRequestSplit(shown: rows.filter { !finished($0) }, folded: rows.filter(finished))
  }

  /// Wiersze w kolejności serwera (najnowszy PR pierwszy). Powtórzony adres zostaje raz, pierwszy: adres jest
  /// tożsamością wiersza, a serwer i tak trzyma listę po adresie.
  public static func rows(_ pullRequests: [SessionPullRequest], timeZone: TimeZone = .current) -> [PullRequestRow] {
    var seen: Set<String> = []
    return pullRequests.compactMap { pr in
      guard seen.insert(pr.url).inserted else { return nil }
      let at = ServerTime.parse(pr.createdAt)
      let title = pr.title.flatMap { $0.isEmpty ? nil : $0 }
      return PullRequestRow(
        id: pr.url, ref: "\(pr.repo)#\(pr.number)", title: title, state: pr.state, link: link(pr.url), at: at,
        clock: at.map { ServerTime.clock($0, timeZone: timeZone) },
        day: at.map { ServerTime.day($0, timeZone: timeZone) })
    }
  }

  /// Adres do otwarcia albo `nil`: CAŁY napis w gramatyce serwera (`parsePullRequestUrl`
  /// w `server/src/herdr/background/pull-requests.ts`): `https://github.com/<owner>/<repo>/pull/<n>`, właściciel
  /// z liter i cyfr ASCII i łączników (do 39, nie od łącznika), repo z liter, cyfr, `.`, `_` i `-` (do 100, bez `.`
  /// i `..`), numer dodatni bez zera wiodącego (do 9 cyfr). Porównanie po skalarach Unicode, jak przy artefaktach.
  static func link(_ raw: String) -> URL? {
    let head = "https://github.com/".unicodeScalars
    let scalars = raw.unicodeScalars
    guard scalars.starts(with: head) else { return nil }
    let parts = String(String.UnicodeScalarView(scalars.dropFirst(head.count)))
      .split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 4, parts[2] == "pull" else { return nil }
    let owner = parts[0].unicodeScalars
    let repo = parts[1].unicodeScalars
    let number = parts[3].unicodeScalars
    guard (1...39).contains(owner.count), owner.allSatisfy({ isAlnum($0) || $0 == "-" }),
      owner.first.map(isAlnum) == true
    else { return nil }
    guard (1...100).contains(repo.count), repo.allSatisfy({ isAlnum($0) || ".-_".unicodeScalars.contains($0) }),
      parts[1] != ".", parts[1] != ".."
    else { return nil }
    guard (1...9).contains(number.count), number.allSatisfy(isDigit), number.first != "0" else { return nil }
    return URL(string: raw)
  }

  private static func isDigit(_ scalar: Unicode.Scalar) -> Bool { ("0"..."9").contains(scalar) }

  private static func isAlnum(_ scalar: Unicode.Scalar) -> Bool {
    ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || isDigit(scalar)
  }
}

/// A changed file of the `git-status` frame: kind letter, name, `+a −b` (a binary file without counts, marked as
/// such). It feeds the fallback file tree (`FileTree`). Without `fileDetails` only the path: no guessed letters.
public struct InspectorFileRow: Sendable, Equatable, Identifiable {
  public let path: String
  /// `nil` = sama nazwa z `files` (ramka bez szczegółów).
  public let kind: GitFileChangeKind?
  /// Brak licznika = „nie wiem" (plik nieśledzony, binarny, odczyt liczników się nie zmieścił), nie zero.
  public let added: Int?
  public let deleted: Int?
  public let binary: Bool

  public var id: String { path }

  /// Litera jak w rozwinięciu gita (`A`/`M`/`D`) — ten sam kolor (`GitInk`).
  public var status: DiffFileStatus? {
    switch kind {
    case .added?: .added
    case .modified?: .modified
    case .deleted?: .deleted
    case nil: nil
    }
  }

  /// Ścieżka do pokazania: bez cytowania gita (`PathText.gitUnquoted`). `path` zostaje dosłowny — to nim serwer
  /// nazywa plik, więc nim wiąże się wiersz z diffem.
  public var plain: String { PathText.gitUnquoted(path) }

  /// Ostatni człon ścieżki. Nieśledzony katalog (`git status` daje go z ukośnikiem na końcu) zostaje z ukośnikiem:
  /// to liść drzewa, którego zawartości git nie wylicza.
  public var name: String {
    let plain = plain
    let last = plain.split(separator: "/").last.map(String.init) ?? plain
    return plain.hasSuffix("/") && !last.isEmpty ? last + "/" : last
  }

  public var spoken: String {
    UICopy.inspectorFileSpoken(path: plain, status: status, added: added, deleted: deleted, binary: binary)
  }
}

/// The change state of the session for the Files section: the count of its header and, without tree rows, one of the
/// empty states (clean, nothing came yet, the last known state), because each says something else about the repo.
public struct InspectorChanges: Sendable, Equatable {
  public enum Body: Sendable, Equatable {
    case files([InspectorFileRow])
    /// Znane zero zmian: „Czysto od <skrót ostatniego commita>".
    case clean(commit: String?)
    /// Ramka `git-status` jeszcze nie przyszła (albo katalog bez repozytorium): „Brak danych o zmianach."
    case noData
  }

  /// Changed files of the whole repo, from the frame (`nil` = unknown).
  public let count: Int?
  public let body: Body
  /// Bez kontaktu ze źródłem: treść to ostatni znany stan.
  public let stale: Bool

  public static func make(meta: GitMeta, fresh: GitStatusEvent?, stale: Bool) -> InspectorChanges {
    var body = Body.noData
    if let fresh, !fresh.files.isEmpty {
      body = .files(rows(fresh))
    } else if (fresh?.dirtyCount ?? meta.dirtyCount) == 0 {
      body = .clean(commit: meta.lastCommit?.hash)
    }
    return InspectorChanges(count: meta.dirtyCount ?? fresh?.dirtyCount, body: body, stale: stale)
  }

  /// Wiersze z `fileDetails` (kolejność i sufit jak `files`), a bez pola — same nazwy z `files`.
  static func rows(_ event: GitStatusEvent) -> [InspectorFileRow] {
    guard let details = event.fileDetails else {
      return event.files.map { InspectorFileRow(path: $0, kind: nil, added: nil, deleted: nil, binary: false) }
    }
    return details.map { detail in
      let binary = detail.binary == true
      return InspectorFileRow(
        path: detail.path, kind: detail.kind, added: binary ? nil : detail.linesAdded,
        deleted: binary ? nil : detail.linesDeleted, binary: binary)
    }
  }
}
