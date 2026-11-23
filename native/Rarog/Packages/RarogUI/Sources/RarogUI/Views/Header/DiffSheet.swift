#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Diff sesji względem HEAD jako okno apki: jedno przewijanie z sekcją na plik. Sekcja to
/// przyklejony nagłówek-przycisk (strzałka, litera, ścieżka, bilans), a pod nim — dopiero po rozwinięciu — patch
/// kolorowany po prefiksie linii. Okno pobiera listę plików i patch TYLKO rozwiniętych plików, po jednym
/// (`DiffWindowModel`): plik da się obejrzeć niezależnie od wagi zmian w pozostałych. Otwiera się od góry albo
/// od pliku stukniętego w prawym panelu lub dymku gita (`RarogNavigation.openDiff`, arkusz stawia `SheetHost`):
/// ten plik jest rozwinięty od razu, a okno przewija do niego raz. Nowa ramka repozytorium w trakcie oglądania
/// odświeża listę i rozwinięte pliki; na czas odczytu stoi poprzednia treść, a tożsamość sekcji to ścieżka,
/// więc miejsce czytania nie skacze. Stoi na wspólnym szkielecie okien (`WindowSheet`): szerokość okna
/// terminala, pasek systemowy z „×" z lewej, tytuł „ZMIANY · N plików" i nazwa projektu, obrys. Zamyka go „×",
/// Esc, Cmd+W, tap obok albo przeciągnięcie paska w dół; zamknięcie anuluje odczyty. Tylko do odczytu.
/// Właściciel: nagłówek.
struct DiffSheet: View {
  let store: RarogStore
  let sessionId: String
  /// Szerokość okna apki (`appWindowWidth`), odczytana poza arkuszem.
  let windowWidth: CGFloat?
  @State private var model: DiffWindowModel
  @Environment(\.dismiss) private var dismiss

  init(store: RarogStore, request: DiffRequest, windowWidth: CGFloat?) {
    self.store = store
    self.sessionId = request.sessionId
    self.windowWidth = windowWidth
    // Rewizja z chwili otwarcia: okno czyta od nowa przy każdym otwarciu, a odświeża je dopiero NOWSZA ramka.
    _model = State(initialValue: DiffWindowModel(
      sessionId: request.sessionId, focus: request.path,
      revision: store.state.transcripts[request.sessionId]?.repoRevision ?? 0))
  }

  var body: some View {
    // Każda ramka `git-status`/`usage` i zmiana podsumowania gita to nowa rewizja, także gdy licznik stoi.
    let revision = store.state.transcripts[sessionId]?.repoRevision ?? 0
    WindowSheet(
      kind: UICopy.diffWindowTitle(files: model.fileCount, truncated: model.listTruncated),
      name: store.state.sessions[sessionId].map { ProjectPath.name($0.cwd) } ?? "",
      titleIdentifier: "diff.title",
      close: SheetClose(label: UICopy.diffClose, identifier: "diff.close") { dismiss() },
      pinnedHeaders: true, windowWidth: windowWidth
    ) {
      EmptyView()
    } content: {
      DiffWindowContent(model: model)
        .background(Color(uiColor: Palette.background))
    }
    // Jeden przebieg odczytów na okno; zamknięcie okna anuluje zadanie, a z nim żądanie w drodze.
    .task {
      await model.run(
        list: { await store.sessionDiffFiles($0) }, file: { await store.sessionDiffFile($0, path: $1) })
    }
    .onChange(of: revision) { _, revision in model.noteRevision(revision) }
    // Kontener, nie etykieta na dzieciach: identyfikator na samym stosie przykrywał identyfikatory wnętrza.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("diff.sheet")
  }
}

/// Treść okna. Czyta wyłącznie model okna, nie stan apki: ramka strumienia, która diffa nie dotyczy, nie
/// przelicza sekcji.
private struct DiffWindowContent: View {
  let model: DiffWindowModel

  var body: some View {
    switch model.phase {
    case .loading:
      status(UICopy.diffLoading)
    case let .failed(message):
      VStack(spacing: 12) {
        Text(message)
          .appFont(.subheadline)
          .foregroundStyle(Color(uiColor: Palette.err))
          .multilineTextAlignment(.center)
          .accessibilityIdentifier("diff.failure")
        Button(UICopy.diffRetry) { model.retryList() }
          .buttonStyle(NeutralButtonStyle())
          .accessibilityIdentifier("diff.retry")
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .loaded:
      let sections = model.sections
      if sections.isEmpty, let failure = model.refreshFailure {
        // Ostatnia dobra lista była pusta, a odświeżenie padło: „brak zmian" to stan sprzed porażki, nie bieżący.
        VStack(spacing: 12) {
          Text(UICopy.diffEmpty)
            .appFont(.subheadline)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .accessibilityIdentifier("diff.status")
          Text(UICopy.list([UICopy.diffRefreshFailed, failure], .sentence))
            .appFont(.footnote)
            .foregroundStyle(Color(uiColor: Palette.err))
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("diff.refresh")
          Button(UICopy.diffRetry) { model.retryList() }
            .buttonStyle(NeutralButtonStyle())
            .accessibilityIdentifier("diff.refresh.retry")
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if sections.isEmpty {
        status(UICopy.diffEmpty)
      } else {
        DiffSections(model: model, sections: sections)
      }
    }
  }

  private func status(_ text: String) -> some View {
    Text(text)
      .appFont(.subheadline)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityIdentifier("diff.status")
  }
}

/// Sekcje plików. Leniwy stos z przyklejonymi nagłówkami: lista ma do 500 plików, patch pliku do pół megabajta,
/// a okno ma się otworzyć od razu.
private struct DiffSections: View {
  let model: DiffWindowModel
  let sections: [DiffSection]
  /// Numer budowy widoku przewijania. Nowy numer = leniwy stos zbudowany od zera (`rebuild(at:)`).
  @State private var build = 0
  /// Sekcja, na której ma stanąć świeżo zbudowany widok; `nil` = od góry.
  @State private var anchorAfterBuild: String?
  /// Geometria przewijania trzymana poza stanem widoku: jej zmiana niczego nie przerysowuje. Każda budowa widoku
  /// ma własną, więc spóźniony odczyt z rozbieranego stosu nie trafia do nowego.
  @State private var scrolling = ScrollBox()

  private final class ScrollBox {
    var idle = true
    /// Ramki nagłówków na ekranie, w układzie widoku przewijania: przyklejony stoi górną krawędzią na zerze.
    var headers: [String: CGRect] = [:]
    /// Górna krawędź treści rozwiniętych sekcji, w tym samym układzie. Brak wpisu = treść zeszła z ekranu
    /// (leniwy stos ją rozebrał) albo jeszcze nie została zmierzona.
    var starts: [String: CGFloat] = [:]

    func top(_ path: String) -> CGFloat { headers[path]?.minY ?? .infinity }

    func pinned(_ path: String) -> Bool { top(path) <= 0.5 }

    /// Nagłówek jest przyklejony, a początek treści schował się pod nim albo zszedł z ekranu: człowiek czyta
    /// w środku pliku. Plik, który stoi u góry bez przewinięcia w głąb (treść zaczyna się zaraz pod nagłówkiem),
    /// nie: jego zwinięcie niczego spod palca nie zabiera. Bez pomiaru początku treści liczy się jak środek.
    func readingInside(_ path: String) -> Bool {
      guard let header = headers[path], header.minY <= 0.5 else { return false }
      guard let start = starts[path] else { return true }
      return start < header.maxY - 0.5
    }
  }

  var body: some View {
    let scrolling = self.scrolling
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
          ForEach(sections) { section in
            Section {
              // Linie wprost w sekcji leniwego stosu: plik tysięcy linii nie buduje się naraz.
              content(section, scrolling)
            } header: {
              DiffSectionHeader(section: section) {
                // Zwinięcie pliku czytanego w środku (nagłówek przyklejony nad przewiniętą treścią): jego treść
                // znika spod palca.
                let readingInside = section.expanded && scrolling.readingInside(section.path)
                model.toggle(section.path)
                if readingInside { rebuild(at: section.path) }
              }
              .onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView(axis: .vertical)) } action: {
                scrolling.headers[section.path] = $0
              }
              .id(Self.anchor(section.path))
            }
          }
          if model.listTruncated {
            footnote(UICopy.diffListTruncated(), identifier: "diff.list.truncated")
          }
          if let failure = model.refreshFailure {
            FailureRow(message: UICopy.list([UICopy.diffRefreshFailed, failure], .sentence), identifier: "diff.refresh") {
              model.retryList()
            }
          }
        }
        // Ostatnia linia da się przewinąć ponad zaokrąglony róg okna.
        .padding(.bottom, WindowLayout.scrollBottomInset)
      }
      // Skok do pliku stukniętego w panelu albo dymku (raz, przy pierwszej pokazanej liście) albo do sekcji,
      // przy której widok został zbudowany od nowa.
      .onAppear {
        guard let target = anchorAfterBuild ?? model.takeScrollTarget() else { return }
        anchorAfterBuild = nil
        proxy.scrollTo(Self.anchor(target), anchor: .top)
      }
      // Treść skurczyła się pod miejscem czytania sama (odświeżony plik jest krótszy, sekcja zniknęła z listy)
      // i przewinięcie stoi za jej końcem. Tylko w spoczynku: przy palcu na ekranie koniec treści odbija system.
      .onScrollPhaseChange { _, phase in scrolling.idle = phase == .idle }
      .onScrollGeometryChange(for: Bool.self) { geometry in
        let last = max(
          -geometry.contentInsets.top,
          geometry.contentSize.height + geometry.contentInsets.bottom - geometry.containerSize.height)
        return geometry.contentOffset.y > last + 1
      } action: { _, beyond in
        if beyond, scrolling.idle { rebuild(at: reading(scrolling)) }
      }
      .id(build)
    }
  }

  /// Plik, którego nagłówek jest teraz przyklejony: ten, który człowiek czyta. Nagłówek wypychany przez następny
  /// ma krawędź nad zerem, więc z przyklejonych liczy się najniższy.
  private func reading(_ scrolling: ScrollBox) -> String? {
    sections.map(\.path).filter(scrolling.pinned).max { scrolling.top($0) < scrolling.top($1) }
  }

  /// Buduje widok przewijania od zera i stawia go na sekcji `path`. Gdy treść nagle kurczy się pod miejscem
  /// czytania, leniwy stos z przyklejonymi nagłówkami zostaje bez wierszy na ekranie: okno jest puste, choć
  /// przewinięcie wróciło na górę (zmierzone na iOS 27: zwinięcie pliku czytanego 70 linii w głąb).
  /// Samo `scrollTo` tego nie naprawia, świeży stos — tak. Kosztuje przerysowanie wierszy widocznych na ekranie.
  private func rebuild(at path: String?) {
    anchorAfterBuild = path
    scrolling = ScrollBox()
    build += 1
  }

  /// Ciało sekcji: nic przy zwiniętej, „Wczytuję…", zdanie z ponowieniem albo linie patcha ze stopkami.
  @ViewBuilder
  private func content(_ section: DiffSection, _ scrolling: ScrollBox) -> some View {
    if section.expanded {
      // Początek treści sekcji: po nim widać, czy plik jest przewinięty w głąb (`ScrollBox.readingInside`).
      Color.clear
        .frame(height: 0)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView(axis: .vertical)).minY } action: {
          scrolling.starts[section.path] = $0
        }
        .onDisappear { scrolling.starts[section.path] = nil }
        .accessibilityHidden(true)
    }
    switch section.body {
    case .collapsed:
      EmptyView()
    case .loading:
      footnote(UICopy.diffFileLoading, identifier: "diff.loading.\(section.path)")
      SectionEnd()
    case let .failed(message):
      FailureRow(message: message, identifier: "diff.failed.\(section.path)") { model.retry(section.path) }
      SectionEnd()
    case let .patch(patch):
      ForEach(patch.rows) { row in
        PatchLine(row: row)
      }
      if patch.rows.isEmpty {
        footnote(UICopy.diffFileEmpty, identifier: "diff.empty.\(section.path)")
      }
      if patch.truncated {
        footnote(UICopy.diffFileTruncated(), identifier: "diff.truncated.\(section.path)")
      }
      if let stale = patch.stale {
        FailureRow(message: stale, identifier: "diff.failed.\(section.path)") { model.retry(section.path) }
      }
      SectionEnd()
    }
  }

  private func footnote(_ text: String, identifier: String) -> some View {
    Text(text)
      .appFont(.footnote)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .padding(.horizontal, WindowLayout.sideInset)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityIdentifier(identifier)
  }

  static func anchor(_ path: String) -> String { "diff-file-\(path)" }
}

/// Nagłówek sekcji pliku: przycisk na całą szerokość okna, który rozwija i zwija patch. Strzałka jak przy
/// katalogach drzewa zmian w panelu, litera rodzaju w kolorze linii gita, ścieżka i zaraz za nią bilans. Nagłówek
/// jest przyklejony, więc ma kryjące tło: rozwinięty — `surface2` (belka nad czytanym patchem), zwinięty — tło
/// okna (cichy wiersz listy).
private struct DiffSectionHeader: View {
  let section: DiffSection
  let toggle: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Button(action: toggle) {
      RarogHoverReader { hovered in
        HStack(spacing: 8) {
          Image(systemName: "chevron.right")
            .appFont(.caption.weight(.semibold))
            .imageScale(.small)
            .foregroundStyle(Color(uiColor: Palette.muted2))
            .rotationEffect(.degrees(section.expanded ? 90 : 0))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: section.expanded)
            .frame(width: 12)
          Text(section.status?.rawValue ?? " ")
            .foregroundStyle(Color(uiColor: GitInk.color(section.status)))
            .frame(width: 14)
          Text(section.path)
            .fontWeight(section.expanded ? .semibold : .regular)
            .foregroundStyle(Color(uiColor: section.expanded || hovered ? Palette.text : Palette.text2))
            .lineLimit(2)
            .truncationMode(.middle)
            .multilineTextAlignment(.leading)
          // Bilans stoi przy nazwie, nie przy prawej krawędzi: okno ma ponad tysiąc punktów szerokości.
          GitFileStats(added: section.added, deleted: section.deleted, binary: section.binary)
            .padding(.leading, 4)
          Spacer(minLength: 0)
        }
        .appFont(.footnote.monospaced())
        .padding(.horizontal, WindowLayout.sideInset)
        .padding(.vertical, 8)
        // Cel dotyku 44 pt; rośnie z pismem razem z dwiema liniami ścieżki.
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background {
          Color(uiColor: section.expanded ? Palette.surface2 : Palette.background)
          if hovered { Color(uiColor: Palette.text).opacity(HoverTokens.wash) }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1) }
        .contentShape(Rectangle())
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(section.spoken)
    .accessibilityValue(section.expanded ? UICopy.diffFileExpanded : UICopy.diffFileCollapsed)
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier("diff.file.\(section.path)")
  }
}

/// Koniec rozwiniętej sekcji: oddech i kreska. Bez niej nagłówek następnego, zwiniętego pliku (tło okna)
/// wyglądałby jak ostatnia linia patcha nad nim.
private struct SectionEnd: View {
  var body: some View {
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(height: 1)
      .padding(.top, 8)
      .accessibilityHidden(true)
  }
}

/// Zdanie porażki z „Spróbuj ponownie": pod nagłówkiem pliku albo pod listą.
private struct FailureRow: View {
  let message: String
  let identifier: String
  let retry: () -> Void

  var body: some View {
    ViewThatFits(in: .horizontal) {
      // Ponowienie stoi przy zdaniu, nie przy prawej krawędzi okna.
      HStack(spacing: 16) {
        sentence
        button
        Spacer(minLength: 0)
      }
      VStack(alignment: .leading, spacing: 8) {
        sentence
        button
      }
    }
    .padding(.horizontal, WindowLayout.sideInset)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var sentence: some View {
    Text(message)
      .appFont(.footnote)
      .foregroundStyle(Color(uiColor: Palette.err))
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier(identifier)
  }

  private var button: some View {
    Button(UICopy.diffRetry, action: retry)
      .buttonStyle(NeutralButtonStyle())
      .accessibilityIdentifier("\(identifier).retry")
  }
}

/// Linia patcha: kolor z prefiksu (dodane zieleń, usunięte czerwień, nagłówek hunka błękit),
/// tło przy dodanych i usuniętych — kolor dubluje znak `+`/`−` na początku linii.
private struct PatchLine: View {
  let row: PatchRow

  var body: some View {
    Text(row.text.isEmpty ? " " : row.text)
      .appFont(.caption.monospaced())
      .foregroundStyle(Color(uiColor: ink(row.kind)))
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16)
      .background(fill(row.kind))
  }

  private func ink(_ kind: PatchLineKind) -> UIColor {
    switch kind {
    case .meta: Palette.muted2
    case .hunk: Palette.new
    case .added: Palette.run
    case .deleted: Palette.err
    case .context: Palette.text
    }
  }

  private func fill(_ kind: PatchLineKind) -> Color {
    switch kind {
    case .added: Color(uiColor: Palette.run).opacity(0.10)
    case .deleted: Color(uiColor: Palette.err).opacity(0.10)
    case .meta, .hunk, .context: .clear
    }
  }
}
#endif
