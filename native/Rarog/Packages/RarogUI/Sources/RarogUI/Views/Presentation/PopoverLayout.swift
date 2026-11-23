import CoreGraphics

// Wspólny rozmiar i anatomia dymków apki: git, „w tle", model i prompty. Dymek jest tak duży jak treść
// (wytyczne Apple: „a popover should be just big enough to display its contents"), do sufitu wysokości; dłuższa
// treść przewija się w środku. Na iPadzie nie ma paska tytułu ani przycisku zamknięcia (zamyka go tap obok
// i Esc). Na telefonie dymek jest arkuszem, więc dostaje pasek z tytułem, detenty i systemowy uchwyt; przycisku
// zamknięcia nie ma —
// zamyka go przeciągnięcie w dół, tap nad arkuszem i gest „wstecz” czytnika, który bierze sam system (pomiar
// sondą `probe.axescape` na iPhonie: kontener prezentacji `UITransitionView`).
// O pasku rozstrzyga URZĄDZENIE, nie klasa szerokości: klasa zmienia się
// przy otwartym dymku (zwężone okno iPada, obrót dużego telefonu), a gałąź z paskiem zmieniłaby wtedy tożsamość
// treści i skasowała jej stan, np. niezatwierdzony wybór modelu. W zwężonym oknie
// iPada dymek jest arkuszem bez paska: zamyka go tap obok, gest i Esc. Detenty i uchwyt są stałe (dymka iPada
// nie dotyczą). Tło daje osobno `popoverSurface()`.
// Strażnik: `PopoverSurfaceSourceTests`.

/// Wymiary dymków — czyste liczby, testowane na macOS.
public enum PopoverLayout {
  public static let minWidth: CGFloat = 320
  public static let idealWidth: CGFloat = 420
  /// Szerokość w piśmie dostępności i sufit szerokości.
  public static let maxWidth: CGFloat = 560
  /// Sufit wysokości dymka na iPadzie.
  public static let ceiling: CGFloat = 600
  /// Wcięcie treści dymka od krawędzi.
  public static let contentInset: CGFloat = 20
  /// Najniższy dymek: jeden cel dotyku.
  public static let minHeight: CGFloat = 44

  /// Wysokość dymka ze zmierzonej treści i stopki, do sufitu. `nil` = arkusz telefonu (wysokość daje detent).
  /// Przed pierwszym pomiarem treść ma 0: dymek zaczyna od najniższego i rośnie, zamiast kurczyć się z domyślnego.
  public static func idealHeight(content: CGFloat, footer: CGFloat = 0, ceiling: CGFloat?) -> CGFloat? {
    guard let ceiling else { return nil }
    let measured = (content.isFinite ? max(content, 0) : 0) + (footer.isFinite ? max(footer, 0) : 0)
    return min(max(measured, minHeight), ceiling)
  }

  /// Wysokość wiersza promptu (dwie linie `subheadline` z odstępami) i etykiety sekcji przy domyślnym piśmie;
  /// wołający skaluje je metryką pisma, inaczej w piśmie dostępności jeden prompt nie mieścił się w dymku.
  public static let promptRowHeight: CGFloat = 60
  public static let promptHeaderHeight: CGFloat = 44

  /// Wysokość dymka promptów z liczby wierszy (lista jest leniwa, więc treści nie da się zmierzyć z góry).
  public static func promptsHeight(
    rows: Int, rowHeight: CGFloat = promptRowHeight, header: CGFloat = promptHeaderHeight
  ) -> CGFloat {
    // Zapas 12 pt pod ostatnim wierszem; jeden prompt nie zostawia pod sobą pustego pasa.
    min(CGFloat(max(rows, 1)) * max(rowHeight, promptRowHeight) + max(header, promptHeaderHeight) + 12, ceiling)
  }
}

#if os(iOS)
import SwiftUI
import UIKit

extension View {
  /// Rozmiar dymka: szerokość 320/420/560 pt (560 w piśmie dostępności), wysokość ze ZMIERZONEJ treści do
  /// sufitu. `ceiling == nil` w arkuszu telefonu: wysokość daje detent.
  func popoverLayout(contentHeight: CGFloat, footerHeight: CGFloat = 0, ceiling: CGFloat?) -> some View {
    modifier(PopoverSizing(contentHeight: contentHeight, footerHeight: footerHeight, ceiling: ceiling))
  }

  /// Dymek na telefonie jest arkuszem: pasek z tytułem, bez przycisku zamknięcia. Na
  /// iPadzie treść zostaje bez paska, także w zwężonym oknie. Detenty i uchwyt arkusza są stałe.
  /// `fitsContent`: the content sets its own detent (a sheet as tall as its content), so no fixed detents here — the
  /// outer detents would win over the content's.
  func popoverSheetChrome(title: String, fitsContent: Bool = false) -> some View {
    modifier(PopoverSheetChrome(title: title, fitsContent: fitsContent))
  }
}

private struct PopoverSizing: ViewModifier {
  let contentHeight: CGFloat
  let footerHeight: CGFloat
  let ceiling: CGFloat?
  @Environment(\.dynamicTypeSize) private var typeSize

  func body(content: Content) -> some View {
    content.frame(
      minWidth: PopoverLayout.minWidth,
      // W piśmie dostępności dymek bierze pełną szerokość: tytuły łamały się w środku słowa.
      idealWidth: typeSize.isAccessibilitySize ? PopoverLayout.maxWidth : PopoverLayout.idealWidth,
      maxWidth: PopoverLayout.maxWidth,
      idealHeight: PopoverLayout.idealHeight(content: contentHeight, footer: footerHeight, ceiling: ceiling),
      maxHeight: ceiling ?? .infinity)
  }
}

private struct PopoverSheetChrome: ViewModifier {
  let title: String
  let fitsContent: Bool

  func body(content: Content) -> some View {
    let chrome = Group {
      // Stałe dla urządzenia: gałąź nie zmienia się przy otwartym dymku, więc stan treści zostaje.
      if PopoverLayout.sheetBar { bar(content) } else { content }
    }
    .presentationDragIndicator(.visible)
    // Fixed for the presentation: the branch does not change while the sheet is open.
    if fitsContent { chrome } else { chrome.presentationDetents([.medium, .large]) }
  }

  /// Pasek telefonu: sam tytuł. Zamyka przeciągnięcie w dół (uchwyt), tap nad arkuszem i gest „wstecz” czytnika.
  private func bar(_ content: Content) -> some View {
    NavigationStack {
      content
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        // Pasek stoi na tym samym pełnym tle co treść (`popoverSurface()`).
        .containerBackground(Color(uiColor: Palette.surface), for: .navigation)
    }
    .tint(Color(uiColor: Palette.text))
  }
}

extension PopoverLayout {
  /// Dymek ma pasek arkusza z tytułem (bez „×”): telefon. Jedno pytanie dla SwiftUI i dla dymka promptów z UIKit.
  @MainActor static var sheetBar: Bool { UIDevice.current.userInterfaceIdiom == .phone }
}

/// Wiersz stopki dymka: przejście do większego widoku („Otwórz w panelu z prawej", „Pokaż diff"). Kreska nad nim,
/// cichy atrament (to przejście, nie główna akcja dymka), cel dotyku 44 pt; `trailing` to skrót klawiszowy.
struct PopoverFooterRow: View {
  let symbol: String
  let title: String
  /// Skrót klawiszowy pokazany z prawej („⌘I") i związany z przyciskiem.
  var trailing: String?
  var shortcut: KeyboardShortcut?
  /// Nazwa dla czytnika, gdy sama etykieta nie wystarcza.
  var spoken: String?
  let identifier: String
  let action: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      Rectangle()
        .fill(Color(uiColor: Palette.border))
        .frame(height: 1)
        .accessibilityHidden(true)
      Button(action: action) {
        HStack(spacing: 10) {
          Image(systemName: symbol)
            .appFont(.footnote)
            .foregroundStyle(Color(uiColor: Palette.muted))
          Text(title)
            .appFont(.footnote)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 8)
          if let trailing {
            Text(trailing)
              .appFont(.caption.monospaced())
              .foregroundStyle(Color(uiColor: Palette.muted2))
          }
        }
        .padding(.horizontal, PopoverLayout.contentInset)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .keyboardShortcut(shortcut)
      .accessibilityLabel(spoken ?? title)
      .accessibilityIdentifier(identifier)
    }
    .background(Color(uiColor: Palette.surface))
  }
}
#endif
