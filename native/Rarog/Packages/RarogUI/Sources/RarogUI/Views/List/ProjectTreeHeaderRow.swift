#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// A project header of the tree: the chevron, the name with the agent count, the branch, and the header buttons (the
// pop-up terminal, the Recent Sessions clock and the note glyph) drawn over placeholders in the first line. Owner:
// list and projects.

/// Nagłówek projektu: strzałka (osobny przycisk, cel 44 pt) i treść jak wiersz karty PROJEKTY — nazwa, pod spodem
/// gałąź z rozjazdem (i ścieżka przy niejednoznacznej nazwie). No counters: the agent count
/// and the state are in the screen reader label only. Własne tokeny
/// drzewa (`PaletteTokens+Tree`): nagłówek stoi na tle kolumny, nie na karcie. Projekt otwarty obok i cel Cmd+L nie
/// mają znacznika — mówi o nich tylko etykieta czytnika.
///
/// Glif notatki stoi w treści na końcu pierwszej linii, ale jest osobnym przyciskiem POZA
/// elementem nagłówka (ten ignoruje dzieci): w treści zostaje niewidoczny zastępnik tej samej wielkości, a przycisk
/// rysuje nakładka w miejscu zastępnika (`TreeHeaderButtonAnchors`). Czytnik dostaje go jako osobny element za
/// nagłówkiem. The Recent Sessions clock (`TreeRecentButton`) stands before the note the same way:
/// its own placeholder in the first line, its own button in the overlay, its own element for the screen reader. The
/// pop-up terminal glyph (`TreeTerminalButton`) stands before the clock the same way.
struct ProjectTreeHeaderRow: View {
  let header: ProjectTreeHeaderModel
  /// Glif notatki projektu; `nil` — serwer bez notatek albo widok bez rejestru notatek (testy widoków).
  var note: NoteTabModel?
  var openNote: () -> Void = {}
  /// Opens Recent Sessions of the project; `nil` — no clock (view without a presenter).
  var openRecent: (() -> Void)?
  /// Opens the project's shell in the pop-up window; `nil` — no glyph (terminal off on the server).
  var openTerminal: (() -> Void)?
  /// Pins or unpins the project (the reader's action; the menu item stands in the list's context menu); `nil` — no
  /// action (view without a list).
  var pin: (() -> Void)?
  let toggle: () -> Void
  @Environment(\.dynamicTypeSize) private var typeSize

  /// Szerokość celu strzałki (≥ 44 pt).
  static let chevronTarget: CGFloat = 44

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      if header.collapsible {
        // Strzałka bez własnego hovera: cały nagłówek zwija i rozwija, a pod wskaźnikiem świeci plama
        // całego nagłówka. Systemowy
        // efekt wskaźnika zdjęty jak w całej apce: w komórce listy SwiftUI liczył położenie od złego widoku.
        Button(action: toggle) {
          TreeChevron(collapsed: header.collapsed)
        }
        .buttonStyle(.borderless)
        .hoverEffectDisabled()
        .accessibilityLabel(header.toggleLabel)
        .accessibilityIdentifier("tree.toggle.\(header.row.name)")
      } else {
        Color.clear.frame(width: Self.chevronTarget, height: Self.chevronTarget).accessibilityHidden(true)
      }
      ProjectTreeHeaderLabel(
        row: header.row, pinned: header.pinned, note: note, recent: openRecent != nil, terminal: openTerminal != nil)
        .padding(.top, SessionListMetrics.projectRowPadding)
        .padding(.bottom, SessionListMetrics.projectRowBottomPadding)
        .frame(maxWidth: .infinity, minHeight: SessionListMetrics.projectRowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(header.row.spoken)
        .accessibilityValue(header.spokenValue)
        .accessibilityAddTraits([.isHeader, .isButton])
        .accessibilityIdentifier("project.\(header.row.name)")
        .modifier(TreeHeaderActions(header: header, toggle: toggle, pin: pin))
        .overlayPreferenceValue(TreeHeaderButtonAnchors.self) { anchors in
          GeometryReader { proxy in
            // Targets from the same geometry that placed the placeholders (`TreeHeaderButtonsLayout`): they touch,
            // the last one reaches into the cell's trailing inset, the first one into the space before the name.
            let present = TreeHeaderButton.allCases.filter { anchors[$0] != nil }
            let glyphs = present.compactMap { anchors[$0].map { proxy[$0] } }
            if let last = glyphs.last {
              let geometry = TreeHeaderButtonGeometry(glyphWidths: glyphs.map(\.width))
              ForEach(present.indices, id: \.self) { index in
                let target = geometry.targets[index]
                button(present[index], width: target.width, reach: target.maxX - geometry.glyphTrailing[index])
                  .position(x: last.maxX + target.midX, y: glyphs[index].midY)
              }
            }
          }
        }
    }
  }

  @ViewBuilder
  private func button(_ kind: TreeHeaderButton, width: CGFloat, reach: CGFloat) -> some View {
    switch kind {
    case .terminal:
      if let openTerminal {
        TreeTerminalButton(name: header.row.name, width: width, reach: reach, open: openTerminal)
      }
    case .recent:
      if let openRecent {
        TreeRecentButton(name: header.row.name, width: width, reach: reach, open: openRecent)
      }
    case .note:
      if let note {
        TreeNoteButton(model: note, name: header.row.name, width: width, reach: reach, open: openNote)
      }
    }
  }
}

/// The header buttons' placeholders in the first line, at the glyph positions of `TreeHeaderButtonGeometry`: equal
/// gaps, the last glyph at the trailing edge, and room before the first glyph for its target, so a tight line
/// truncates the name instead of letting a target reach over the name or the count. Glyphs share the text baseline.
private struct TreeHeaderButtonsLayout: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let geometry = TreeHeaderButtonGeometry(glyphWidths: subviews.map { $0.sizeThatFits(.unspecified).width })
    return CGSize(width: geometry.width, height: Self.rows(subviews).height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
    let geometry = TreeHeaderButtonGeometry(glyphWidths: sizes.map(\.width))
    let rows = Self.rows(subviews)
    for (index, subview) in subviews.enumerated() {
      let x = bounds.maxX + geometry.glyphTrailing[index] - sizes[index].width
      subview.place(
        at: CGPoint(x: x, y: bounds.minY + rows.tops[index]), anchor: .topLeading, proposal: ProposedViewSize(sizes[index]))
    }
  }

  func explicitAlignment(
    of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) -> CGFloat? {
    guard guide == .firstTextBaseline || guide == .lastTextBaseline else { return nil }
    return bounds.minY + Self.rows(subviews).baseline
  }

  /// Tops that put every glyph on one baseline, the baseline from the top, and the height they take.
  private static func rows(_ subviews: Subviews) -> (tops: [CGFloat], baseline: CGFloat, height: CGFloat) {
    let dimensions = subviews.map { $0.dimensions(in: .unspecified) }
    let baseline = dimensions.map { $0[VerticalAlignment.firstTextBaseline] }.max() ?? 0
    let tops = dimensions.map { baseline - $0[VerticalAlignment.firstTextBaseline] }
    let height = zip(tops, dimensions).map { $0 + $1.height }.max() ?? 0
    return (tops, baseline, height)
  }
}

/// Buttons drawn over the header's first line: the pop-up terminal, the Recent Sessions clock and the note glyph.
private enum TreeHeaderButton: Hashable, CaseIterable {
  case terminal, recent, note
}

/// Frames of the invisible placeholders of the header buttons' glyphs in the header content (`ProjectTreeHeaderLabel`).
private struct TreeHeaderButtonAnchors: PreferenceKey {
  static var defaultValue: [TreeHeaderButton: Anchor<CGRect>] { [:] }
  static func reduce(
    value: inout [TreeHeaderButton: Anchor<CGRect>], nextValue: () -> [TreeHeaderButton: Anchor<CGRect>]
  ) {
    value.merge(nextValue()) { first, _ in first }
  }
}

/// Glif notatki przy nagłówku projektu jako przycisk: zawsze klikalny — z treścią dymek
/// przy nagłówku, bez treści (albo z niezapisanym szkicem) formularz. Szary bez notatki, bursztyn z notatką, pod
/// wskaźnikiem szary wraca do tekstu. Styl `borderless`: w komórce listy przycisk nie przejmuje stuknięć całego wiersza.
/// Under the pointer the glyph stands on a plate in both tones, with a note and without one: `TreeNotePlate`, so the
/// amber glyph reacts too.
private struct TreeNoteButton: View {
  let model: NoteTabModel
  let name: String
  /// Target 44 pt high and `width` wide, ending `reach` past the glyph (`TreeHeaderButtonGeometry`).
  let width: CGFloat
  let reach: CGFloat
  let open: () -> Void
  @State private var hovered = false

  var body: some View {
    Button(action: open) {
      NoteGlyph(model: model, lit: hovered)
        .appFont(TreeRecentButton.glyphFont)
        .fixedSize()
        .background { if hovered { TreeNotePlate() } }
        .padding(.trailing, reach)
        .frame(width: width, height: SessionListMetrics.treeButtonHeight, alignment: .trailing)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .hoverEffectDisabled()
    .onHover { hovered = $0 }
    .pointerTip(UICopy.noteProject)
    .accessibilityLabel(UICopy.noteProject)
    .accessibilityValue(model.spokenValue)
    .accessibilityHint(model.readable ? UICopy.noteTabReadHint : UICopy.noteTabWriteHint)
    .accessibilityIdentifier("tree.note-glyph.\(name)")
  }
}

/// Plate under the note glyph (and the Recent Sessions clock, `TreeRecentButton`) while the pointer is over it: the
/// wash of icon buttons (text ink at `HoverTokens.wash`) in an inner-radius rounded rectangle. Not the tab bar's
/// `TabPlate` (`surface2` at half opacity): the header under it is already lit with that same plate, so a second one would be a step of about 1.03:1. The wash stays a visible
/// step there (≥ 1.08:1, `ProjectTreeRowsTests`). In the background with negative padding: the glyph does not move,
/// and the plate (a few points around the glyph) fits in the header's first line and in the cell.
struct TreeNotePlate: View {
  /// Reach past the glyph's bounds on each side.
  static let horizontalReach: CGFloat = 5
  static let verticalReach: CGFloat = 4

  var body: some View {
    RoundedRectangle.inner
      .fill(Color(uiColor: Palette.text).opacity(HoverTokens.wash))
      .padding(.horizontal, -Self.horizontalReach)
      .padding(.vertical, -Self.verticalReach)
      .accessibilityHidden(true)
  }
}

/// Strzałka zwijania w celu 44 pt: glif `treeChevron`, bez tła. Własnego hovera nie ma:
/// cały nagłówek zwija i rozwija, a pod wskaźnikiem świeci jego plama.
struct TreeChevron: View {
  let collapsed: Bool

  var body: some View {
    Image(systemName: "chevron.right")
      .appFont(.caption.weight(.semibold))
      .foregroundStyle(Color(uiColor: Palette.dynamic(PaletteTokens.treeChevron)))
      .rotationEffect(.degrees(collapsed ? 0 : 90))
      .frame(width: ProjectTreeHeaderRow.chevronTarget, height: ProjectTreeHeaderRow.chevronTarget)
      .contentShape(Rectangle())
  }
}

/// Screen reader actions on the header: Collapse or Expand (without looking for the chevron next to it), and Pin or
/// Unpin, the same item as the context menu.
private struct TreeHeaderActions: ViewModifier {
  let header: ProjectTreeHeaderModel
  let toggle: () -> Void
  let pin: (() -> Void)?

  func body(content: Content) -> some View {
    content
      .modifier(NamedAction(
        action: header.collapsible ? toggle : nil, name: header.collapsed ? UICopy.treeExpand : UICopy.treeCollapse))
      .modifier(NamedAction(action: pin, name: header.pinned ? UICopy.treeUnpin : UICopy.treePin))
  }

  /// A named reader action only when there is something to do.
  private struct NamedAction: ViewModifier {
    let action: (() -> Void)?
    let name: String

    func body(content: Content) -> some View {
      if let action {
        content.accessibilityAction(named: name, action)
      } else {
        content
      }
    }
  }
}

/// Treść nagłówka: nazwa z liczbą agentów w nawiasie, pod spodem gałąź `↑3 ↓1` i ścieżka. Pismo mono jak wiersz karty
/// PROJEKTY.
private struct ProjectTreeHeaderLabel: View {
  let row: ProjectRowModel
  /// Pinned on this device: a small pin glyph after the name and the count.
  let pinned: Bool
  let note: NoteTabModel?
  /// Placeholder of the Recent Sessions clock before the note (`TreeRecentButton`).
  let recent: Bool
  /// Placeholder of the pop-up terminal glyph before the clock (`TreeTerminalButton`).
  let terminal: Bool
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let meta = Color(uiColor: Palette.dynamic(PaletteTokens.treeHeaderMeta))
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        // Pismo dostępności: nazwa się łamie zamiast ucinać.
        Text(row.name)
          .appFont(.subheadline.monospaced().weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.dynamic(PaletteTokens.treeHeaderName)))
          .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
          .truncationMode(.tail)
        if let badge = row.agentsBadge {
          // The agent count right after the name, "willow (10)": `footnote` mono, a step
          // below the name, without the weight, dimmed like the branch, on the name's baseline.
          // The name truncates before it; the bracket never goes. Decoration for the screen reader: the header says
          // the count.
          Text(badge)
            .appFont(.footnote.monospaced())
            .monospacedDigit()
            .foregroundStyle(Color(uiColor: Palette.dynamic(PaletteTokens.treeHeaderCount)))
            .fixedSize()
            .layoutPriority(1)
            .accessibilityHidden(true)
        }
        if pinned {
          // The pin after the name and the count, in the count's quiet colour. Fixed size: the name truncates before
          // it, and it never pushes the header buttons out. Decoration for the screen reader: the header's value
          // says "pinned".
          Image(systemName: "pin.fill")
            .appFont(.caption2)
            .foregroundStyle(Color(uiColor: Palette.dynamic(PaletteTokens.treeHeaderCount)))
            .fixedSize()
            .layoutPriority(1)
            .accessibilityHidden(true)
        }
        Spacer(minLength: 4)
        if terminal || recent || note != nil {
          // Placeholders only: the header's overlay draws the buttons on them. The layout gives equal gaps and
          // reserves the first target's room before the first glyph.
          TreeHeaderButtonsLayout {
            if terminal {
              // Pop-up terminal before the clock (`TreeTerminalButton`).
              Image(systemName: TreeTerminalButton.symbol)
                .appFont(TreeRecentButton.glyphFont)
                .fixedSize()
                .hidden()
                .anchorPreference(key: TreeHeaderButtonAnchors.self, value: .bounds) { [.terminal: $0] }
            }
            if recent {
              // Recent Sessions clock before the note (`TreeRecentButton`).
              Image(systemName: TreeRecentButton.symbol)
                .appFont(TreeRecentButton.glyphFont)
                .fixedSize()
                .hidden()
                .anchorPreference(key: TreeHeaderButtonAnchors.self, value: .bounds) { [.recent: $0] }
            }
            if let note {
              // The project note at the end of the first line, at every project: grey without a note, amber with
              // one (`TreeNoteButton`).
              NoteGlyph(model: note)
                .appFont(TreeRecentButton.glyphFont)
                .fixedSize()
                .hidden()
                .anchorPreference(key: TreeHeaderButtonAnchors.self, value: .bounds) { [.note: $0] }
            }
          }
        }
      }
      if row.hasMeta {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          if let branch = row.branch {
            Text(branch).lineLimit(typeSize.isAccessibilitySize ? nil : 1).truncationMode(.middle).layoutPriority(0)
          }
          if row.ahead != nil || row.behind != nil {
            // Strzałki względem zdalnej w kolorach `--ahead`/`--behind`: to nie kolory stanu.
            HStack(spacing: 4) {
              if let ahead = row.ahead { Text("↑\(ahead)").foregroundStyle(Color(uiColor: Palette.ahead)) }
              if let behind = row.behind { Text("↓\(behind)").foregroundStyle(Color(uiColor: Palette.behind)) }
            }
            .monospacedDigit()
            .fixedSize()
            .layoutPriority(1)
          }
          if let path = row.path {
            Text(row.branch == nil ? path : "· \(path)").lineLimit(1).truncationMode(.head)
          }
        }
        .appFont(.caption.monospaced())
        .foregroundStyle(meta)
      }
    }
  }
}
#endif
