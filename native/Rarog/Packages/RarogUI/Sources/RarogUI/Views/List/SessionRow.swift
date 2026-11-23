#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Wiersz listy sesji. Właściciel: lista.

/// Wiersz sesji: kropka stanu, „projekt · nazwa #n", słowo stanu i czas, linia „na co czeka"
/// albo cicha linia etapu, pasek workflow pod pracującą kartą.
struct SessionRow: View {
  let row: SessionRowModel
  let selected: Bool
  /// The tab digit at the end of the row, in the tree's active project with a hardware keyboard
  /// (`RarogNavigation.treeTabDigits`); `nil` — no square.
  var tabDigit: Int?
  @Environment(\.dynamicTypeSize) private var typeSize
  /// Kropka w osi małych liter tytułu przy każdym rozmiarze pisma (stałe 4 pt kładło ją w AX5 na linii bazowej).
  @AppScaledMetric(relativeTo: .subheadline) private var dotLift: CGFloat = 4
  /// Chwila zamrożenia wiersza bez kontaktu ze źródłem: od niej zegar stoi.
  @State private var frozenAt: Date?

  var body: some View {
    // Wyciszenie bezczynnych nie dotyczy wiersza otwartego obok.
    let quiet = row.quiet && !selected
    let ink = Color(uiColor: quiet ? Palette.idleInk : Palette.text)
    let secondary = Color(uiColor: quiet ? Palette.idleInk : Palette.muted)
    TimelineView(.periodic(from: .now, by: 1)) { timeline in
      let now = row.clockNow(timeline.date, frozenAt: frozenAt)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        StatusDot(tone: row.status.tone, pulses: row.freshResult)
          .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + dotLift }
        VStack(alignment: .leading, spacing: 2) {
          title(secondary: secondary, quiet: quiet)
            // Gęstość kart PWA (projekt 15 px, meta 11–12 px): `subheadline` i `caption`, z Dynamic Type.
            .appFont(.subheadline)
            .foregroundStyle(ink)
            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
          // Jeden tekst, nie trzy obok siebie: przy dużym piśmie zawija się jak zdanie, zamiast
          // łamać każde słowo w osobnej, wąskiej kolumnie.
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(statusLine(now: now))
              .monospacedDigit()
            if row.isCodex {
              Text(UICopy.codexTag)
                .padding(.horizontal, 5)
                .overlay(Capsule().strokeBorder(Color(uiColor: Palette.border)))
            }
          }
          .appFont(.caption.monospaced())
          .foregroundStyle(secondary)
          .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
          if let waiting = row.waiting {
            // Wysokość zarezerwowana: pusta linia zamiast migającego napisu.
            // Proporcjonalnie jak `.session-card__activity` w PWA: więcej komendy mieści się w linii.
            Text(waiting.isEmpty ? " " : waiting)
              .appFont(.caption)
              .foregroundStyle(secondary)
              .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
              .truncationMode(.tail)
          } else if let stage = row.stage {
            StageLine(text: stage, dot: row.backgroundDot, quiet: quiet)
          }
        }
        if let tabDigit {
          Spacer(minLength: 0)
          TreeTabKey(digit: tabDigit)
        }
      }
      .padding(.vertical, SessionListMetrics.agentRowPadding)
      // Pasek w dolnym marginesie wiersza: pojawienie się nie zmienia wysokości karty. Zsunięty o 3 pt
      // w dolne wcięcie wiersza (5,5 pt): bez tego leżał w 2 pt paddingu i dotykał tekstu
      // nad sobą; od linii dzieli go 3 pt, jak `margin-top` w PWA.
      .overlay(alignment: .bottom) {
        if let progress = row.progress { WorkflowBar(segments: progress).padding(.leading, 17).offset(y: 3) }
      }
      // Nieświeże wygrywa z wyciszeniem: pełny atrament pod przygaszeniem.
      .opacity(row.frozen ? 0.55 : 1)
      // Bez gasnącej plamy przy zmianie rangi: na iPhonie czyta się jak zaznaczenie, które samo znika.
      // Zmianę rangi niosą kropka i miejsce na liście.
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(row.spoken(now: now))
      .accessibilityAddTraits(.isButton)
    }
    .onChange(of: row.frozen, initial: true) { _, frozen in
      // Zegar staje w chwili utraty kontaktu i rusza sam przy pierwszym świeżym stanie.
      frozenAt = frozen ? Date() : nil
    }
  }
}

extension SessionRow {
  /// Lista klasyczna: projekt półgruby w pełnym atramencie, „· nazwa #n" zwykłą wagą i o stopień ciszej — projekt
  /// łowi się kątem oka; wiersz wyciszony różni się samą wagą, kolor zostaje jeden. Drzewo:
  /// projekt niesie nagłówek, wiersz to sama nazwa sesji — średnia waga, a wyciszony zwykła.
  fileprivate func title(secondary: Color, quiet: Bool) -> Text {
    guard row.showsProject else { return Text(row.treeTitle).fontWeight(quiet ? .regular : .medium) }
    return Text("\(Text(row.project).fontWeight(.semibold))\(Text(row.titleTail).foregroundStyle(secondary))")
  }

  fileprivate func statusLine(now: Date) -> String {
    let clock = row.clock(now: now)
    return clock.isEmpty ? row.status.text : "\(row.status.text) · \(clock)"
  }
}

/// The status dot. A fresh unread result glows: the dot keeps its full color and a soft halo of the same color
/// breathes under it, 1.8 s a cycle; Reduce Motion keeps the plain dot. The halo is a background, so the row keeps its
/// size, and it is stronger in light mode, where a pale glow on a pale row would not show.
private struct StatusDot: View {
  let tone: StatusTone
  let pulses: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let color = Color(uiColor: Palette.tone(tone))
    let dot = Circle().fill(color).frame(width: 9, height: 9)
    if pulses && !reduceMotion {
      let peak = scheme == .dark ? 0.6 : 0.75
      dot.background {
        Circle()
          .fill(color)
          .frame(width: 9, height: 9)
          .phaseAnimator([false, true]) { halo, lit in
            halo.scaleEffect(lit ? 1.7 : 1).blur(radius: lit ? 3 : 1).opacity(lit ? peak : 0)
          } animation: { _ in
            .easeInOut(duration: 0.9)
          }
          .allowsHitTesting(false)
      }
    } else {
      dot
    }
  }
}

/// Cicha linia etapu: co agent robi albo co żyje w tle; zielona kropka „w tle", gdy pod kartą
/// nie ma paska. Bez treści linii nie ma wcale (model daje `nil`, jak `:empty` w PWA).
private struct StageLine: View {
  let text: String
  let dot: Bool
  let quiet: Bool
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 5) {
      if dot {
        Circle()
          .fill(Color(uiColor: Palette.run))
          .frame(width: 5, height: 5)
          .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 3 }
      }
      Text(text)
        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
        .truncationMode(.tail)
    }
    .appFont(.caption)
    .foregroundStyle(Color(uiColor: quiet ? Palette.idleInk : Palette.muted2))
  }
}

/// Pasek postępu workflow: 2 pt, segment na fazę planu, przerwa 3 pt zamiast etykiet. Postęp
/// rośnie skokami bez animacji szerokości — skok jest prawdą (dolne oszacowanie).
private struct WorkflowBar: View {
  let segments: [ProgressSegment]

  var body: some View {
    HStack(spacing: 3) {
      ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule().fill(Color(uiColor: segment.active ? Palette.run.withAlphaComponent(0.3) : Palette.border))
            Capsule()
              .fill(Color(uiColor: Palette.run))
              .frame(width: proxy.size.width * min(1, max(0, segment.fill)))
          }
        }
      }
    }
    .frame(height: 2)
    .transaction { $0.animation = nil }
    .accessibilityHidden(true)
  }
}

/// The tab digit square at the end of an agent row of the active project, without a fill: the digit of the strip's
/// Cmd key for this session's tab, on the column background with a hairline edge,
/// both in a quiet colour (`treeTabKeyEdge`, `treeTabDigit`). The state stays with the dot, so the square has no state
/// colour. Decoration: the shortcut menu reads the tabs.
struct TreeTabKey: View {
  let digit: Int

  var body: some View {
    Text(String(digit))
      .appFont(.caption2.monospaced().weight(.medium))
      .foregroundStyle(Color(uiColor: Palette.dynamic(PaletteTokens.treeTabDigit)))
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .overlay(RoundedRectangle.ghost.strokeBorder(Color(uiColor: Palette.dynamic(PaletteTokens.treeTabKeyEdge))))
      .accessibilityHidden(true)
  }
}
#endif
