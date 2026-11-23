#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Linia statusu sesji pod paskiem zakładek: `◔ 12% · main · ↓2 ↑1 · +3 ~5 −1` po lewej,
// pigułki („↑ CLI", „w tle") po prawej, w jednym rzędzie, gdy się mieszczą.
// Model i tryb stoją w rzędzie pod polem wiadomości (`Session/ComposerPills`).
// Właściciel: nagłówek.

/// Kolory linii gita (`docs/design.md` „Status and git"): kolor dubluje znak, nigdy go nie zastępuje.
enum GitInk {
  /// `↑` do wysłania — fiolet (`--ahead`).
  static let ahead = Palette.dynamic(dark: 0xC084FC, light: 0x6D28D9)
  /// `↓` do pobrania — cyjan (`--behind`).
  static let behind = Palette.dynamic(dark: 0x22D3EE, light: 0x0E7490)

  static func color(_ kind: GitSegment.Kind) -> UIColor {
    switch kind {
    case .branch: Palette.text
    case .behind: behind
    case .ahead: ahead
    case .added: Palette.run
    case .modified: Palette.accent
    case .deleted: Palette.err
    case .files: Palette.muted
    }
  }

  /// Litera statusu pliku: A zieleń, M bursztyn, D czerwień, nieznana wyciszona.
  static func color(_ status: DiffFileStatus?) -> UIColor {
    switch status {
    case .added?: Palette.run
    case .modified?: Palette.accent
    case .deleted?: Palette.err
    case nil: Palette.muted2
    }
  }
}

struct SessionStatusBar: View {
  let store: RarogStore
  let session: SessionSummary
  @Environment(RarogNavigation.self) private var navigation
  /// Klasa szerokości PREZENTUJĄCEGO: w wąskiej (zwężone okno iPada) dymek gita jest arkuszem, więc wysokość daje
  /// detent. Telefon dymka gita nie ma: linia otwiera tam panel sesji jako arkusz.
  @Environment(\.horizontalSizeClass) private var sizeClass
  @State private var gitOpen = false

  var body: some View {
    let state = store.state
    let fresh = state.transcripts[session.id]?.git
    let meta = GitMeta(session: session, fresh: fresh)
    let context = ContextGauge.make(context: session.context, usage: session.usage)
    let segments = meta.segments
    let line = context != nil || !segments.isEmpty
    // Prawy panel pokazuje „w tle" i zmiany: pigułka znika, a git przewija panel.
    let panel = navigation.inspectorVisible(state)
    let restarting = state.restartInProgress(session.id)
    let pills = StatusPills.visible(session, backgroundInPanel: panel, restarting: restarting)
    // Telefon: linia i pigułka „w tle” otwierają panel jako arkusz (`Model/InspectorSheet.swift`).
    let phone = PopoverLayout.sheetBar
    let tap = navigation.gitLineTap(state, session: session, isRepo: meta.isRepo, phone: phone)
    let pillTap = navigation.backgroundPillTap(state, sessionId: session.id, phone: phone)
    // Ta sama reguła stawia kreskę pod paskiem zakładek, gdy linii nie ma (`HeaderTabsSlot`).
    if StatusLine.isShown(session, fresh: fresh, backgroundInPanel: panel, restarting: restarting) {
      bar(meta: meta, context: context, segments: segments, line: line, pills: pills, panel: panel, tap: tap,
          pillTap: pillTap)
    }
  }

  private func bar(
    meta: GitMeta, context: ContextGauge?, segments: [GitSegment], line: Bool, pills: Bool, panel: Bool,
    tap: GitLineTap, pillTap: BackgroundPillTap
  ) -> some View {
    StatusLineLayout {
      if line {
        gitLine(meta: meta, context: context, segments: segments, tap: tap)
      }
      if pills {
        SessionPills(store: store, session: session, backgroundInPanel: panel, backgroundTap: pillTap)
      }
    }
    // Pierścień (albo gałąź) i prawa krawędź pigułek na wspólnym wcięciu nagłówka (16 pt, `HeaderMetrics`).
    .padding(.horizontal, HeaderMetrics.contentInset)
    // Bez górnego marginesu: linia stoi tuż pod paskiem zakładek (`HeaderMetrics`).
    .padding(.top, HeaderMetrics.statusTopPadding)
    .padding(.bottom, HeaderMetrics.statusBottomPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: Palette.background))
    // Kreska oddziela nagłówek od transkryptu: linia statusu jest ostatnim rzędem nagłówka.
    .overlay(alignment: .bottom) {
      Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("header.status")
  }

  /// Co robi tap, mówi `RarogNavigation.gitLineTap`: dymek gita i przewinięcie stojącego panelu na iPadzie (rozwinięcie
  /// tylko tam, gdzie ma pokrycie w danych, `StatusLine.gitExpands`), arkusz panelu na telefonie.
  @ViewBuilder
  private func gitLine(meta: GitMeta, context: ContextGauge?, segments: [GitSegment], tap: GitLineTap) -> some View {
    let line = GitStatusLine(context: context, segments: segments).frame(minHeight: 32)
    if tap != .none {
      Button {
        switch tap {
        case let .panelSheet(anchor):
          navigation.openInspectorSheet(sessionId: session.id, anchor: anchor)
        case .scrollPanel:
          // Zmiany stoją w panelu obok: tap przewija panel do sekcji zamiast otwierać popover.
          navigation.inspector.anchors[session.id] = InspectorModel.changesAnchor
        case .gitPopover:
          gitOpen = true
        case .none:
          break
        }
      } label: {
        line.contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(meta.spoken(context: context))
      .accessibilityHint(tap.opensSheet ? UICopy.inspectorSheetHint : UICopy.gitDetailsHint)
      .accessibilityIdentifier("header.git")
      .popover(isPresented: $gitOpen, arrowEdge: .top) {
        // Okno diffa staje nad całą apką; dymek zdejmuje system, gdy staje arkusz. Dymek diffa nie
        // pobiera: wiersze ma z ramki `git-status`, a patch czyta dopiero okno.
        GitDetailsPanel(store: store, sessionId: session.id, compact: sizeClass != .regular) { path in
          navigation.openDiff(sessionId: session.id, path: path)
        }
        .dismissOnEscape { gitOpen = false }
        .popoverSheetChrome(title: UICopy.popoverGitTitle)
        .popoverSurface()
        .presentationCompactAdaptation(.sheet)
      }
    } else {
      line
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(meta.spoken(context: context))
        .accessibilityIdentifier("header.git")
    }
  }
}

/// Wizualna linia: pierścień z procentem, potem segmenty gita z kropką między grupami. Kropka
/// jest osobnym węzłem, bo o tym, czy stoi, decydują dane (pary `↓2 ↑1` i `+3 ~5 −1` kleją się).
struct GitStatusLine: View {
  let context: ContextGauge?
  let segments: [GitSegment]

  /// Kreska pierścienia (2,5 pt) stoi na obrysie koła, więc połowa jej grubości wystaje poza ramkę.
  /// Odstęp o tyle stawia na wcięciu nagłówka atrament pierścienia, nie jego ramkę.
  static let ringOverhang: CGFloat = 2.5 / 2

  var body: some View {
    HStack(spacing: 6) {
      if let context {
        RingGauge(fraction: Double(context.percent) / 100, tone: context.tone, lineWidth: Self.ringOverhang * 2)
          .padding(.horizontal, Self.ringOverhang)
        Text(context.text)
          .fontWeight(UsageInk.weight(context.tone))
          .foregroundStyle(Color(uiColor: UsageInk.color(context.tone)))
      }
      ForEach(Array(segments.enumerated()), id: \.element.id) { index, segment in
        if index > 0 || context != nil, !segment.glued {
          Text("·").foregroundStyle(Color(uiColor: Palette.muted2))
        }
        Text(segment.text)
          .foregroundStyle(Color(uiColor: GitInk.color(segment.kind)))
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .appFont(.footnote.monospaced())
    .accessibilityHidden(true)
  }
}
#endif
