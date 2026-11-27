#if os(iOS)
import SwiftUI

// Wspólny szkielet arkuszy apki. Arkusz jest kontenerem systemu, więc geometrię i anatomię paska daje
// system: pasek nawigacji, zamknięcie z LEWEJ (`cancellationAction`, wytyczne Apple dla arkuszy), akcje z prawej,
// przyciski paska w domyślnym wyglądzie systemu, tło i promień arkusza bez własnych nadpisań. Apka dokłada to,
// czego system nie wie: achromatyczny odcień, tytuł z nazwą projektu, obrys okna (bez niego okno na
// `background` nie ma krawędzi nad przyciemnioną apką: 1,02:1), wspólną szerokość okien, klawisze zamknięcia
// i odbiorcę klawiatury (`SheetKeyboardAnchor`), żeby te klawisze trafiały do okna, a nie pod nie.
// Wygląd przycisków paska ustawia WYŁĄCZNIE ten plik. Strażnik: `PresentationSourceTests`.

/// Przycisk zamknięcia arkusza: stoi z lewej strony paska, zawsze symbolem `xmark`.
struct SheetClose {
  /// Nazwa dla czytnika i podpowiedź pod wskaźnikiem („Zamknij zmiany").
  let label: String
  /// Identyfikator dostępności dla testów UI.
  let identifier: String
  let action: () -> Void
}

/// Okno: duża treść do czytania albo pracy (diff, historia terminala). Pasek systemowy z tytułem
/// „RODZAJ nazwa", zamknięcie z lewej, akcje z prawej; szerokość z ``WindowLayout``; Esc i Cmd+W zamykają.
struct WindowSheet<Content: View, Actions: View>: View {
  /// Rodzaj okna („Zmiany · 2 pliki", „Historia") — etykieta maszynowa przed nazwą i tytuł dla czytnika.
  let kind: String
  /// Nazwa projektu: jedyna informacja, której nie widać z treści okna.
  let name: String
  /// Identyfikator dostępności tytułu dla testów UI.
  var titleIdentifier: String?
  let close: SheetClose
  /// Treść ma przyklejone nagłówki sekcji: krawędź pod paskiem jest wtedy twarda (wytyczne Apple dla
  /// przyklejonych nagłówków), inaczej linie wracałyby rozmyte nad nagłówkiem.
  var pinnedHeaders = false
  /// Szerokość okna apki (`appWindowWidth`), odczytana POZA arkuszem.
  let windowWidth: CGFloat?
  @ViewBuilder let actions: () -> Actions
  @ViewBuilder let content: () -> Content

  var body: some View {
    NavigationStack {
      content()
        .navigationTitle(kind)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(role: .close, action: close.action) {
              Label(close.label, systemImage: "xmark")
            }
            .shortcutTip(close.label, .dismissSheet, .closeSheet)
            .accessibilityLabel(close.label)
            .accessibilityIdentifier(close.identifier)
          }
          ToolbarItem(placement: .principal) {
            WindowTitle(kind: kind, name: name, identifier: titleIdentifier)
          }
          ToolbarItemGroup(placement: .primaryAction) { actions() }
        }
        .scrollEdgeEffectStyle(pinnedHeaders ? .hard : .automatic, for: .top)
        // Okno bierze klawiaturę od chwili pokazania i oddaje ją przy zejściu. Bez tego Esc i Cmd+W szły
        // łańcuchem tego, kto trzymał ją POD oknem (pole wiadomości, terminal), a skrótów okna w nim nie ma:
        // Cmd+W zamykał scenę apki zamiast okna.
        .background { SheetKeyboardAnchor() }
    }
    .closesOnEscapeAndCommandW(close.action)
    // Na stosie, nie na stronie: wejście w głąb nie zmienia rozmiaru arkusza.
    .windowFrame(width: windowWidth)
  }
}

/// Formularz: pisanie albo zakładanie czegoś („Nowa sesja", „Ostatnie sesje"). Rozmiar `.form` i tło systemu,
/// pasek systemowy z tytułem i zamknięciem z LEWEJ; Esc i Cmd+W zamykają jak przycisk. Formularz bierze klawiaturę
/// na czas pokazania (jak okno), więc te klawisze trafiają do niego, a nie do ekranu pod spodem. W trakcie
/// żądania (`locked`: „Uruchom", „Wznów", „Rozwidl" w drodze) nie daje się zamknąć: wynik należy do tej
/// prezentacji, a zamknięty formularz zostawiłby go bez adresata.
struct FormSheet<Content: View>: View {
  let title: String
  let close: SheetClose
  /// Zamknięcie traci wpisane dane (rola `.cancel`); bez tego tylko zamyka listę (rola `.close`).
  var discards = false
  var locked = false
  @ViewBuilder let content: () -> Content

  var body: some View {
    NavigationStack {
      content()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(role: discards ? .cancel : .close, action: close.action) {
              Label(close.label, systemImage: "xmark")
            }
            .disabled(locked)
            .shortcutTip(close.label, .dismissSheet, .closeSheet)
            .accessibilityLabel(close.label)
            .accessibilityIdentifier(close.identifier)
          }
        }
        .background { SheetKeyboardAnchor() }
    }
    // Arkusz staje z korzenia sceny, gdzie odcienia szczegółu nie ma.
    .tint(Color(uiColor: Palette.text))
    .toggleStyle(.appSwitch)
    .closesOnEscapeAndCommandW { if !locked { close.action() } }
    .interactiveDismissDisabled(locked)
    .presentationSizing(.form)
  }
}

extension View {
  /// Rama okna apki na treści arkusza: achromatyczny odcień, obrys w kształcie arkusza i wspólna szerokość okien
  /// (``WindowLayout``). Bez własnego tła prezentacji, szkła i promienia. Stoi na `WindowSheet` i na oknie
  /// terminala, które pasek ma z UIKit.
  func windowFrame(width windowWidth: CGFloat?) -> some View {
    modifier(WindowFrame(windowWidth: windowWidth))
  }
}

private struct WindowFrame: ViewModifier {
  /// Szerokość okna apki (`appWindowWidth`), odczytana POZA arkuszem.
  let windowWidth: CGFloat?
  @Environment(\.horizontalSizeClass) private var sizeClass

  func body(content: Content) -> some View {
    content
      // Arkusz staje z korzenia sceny, gdzie odcienia szczegółu nie ma: bez tego przyciski paska byłyby błękitne.
      .tint(Color(uiColor: Palette.text))
      .toggleStyle(.appSwitch)
      .overlay { WindowOutline() }
      .presentationSizing(
        WindowSizing(width: WindowLayout.sheetWidth(window: windowWidth, compact: sizeClass == .compact)))
  }
}

/// Tytuł okna w pasku: rodzaj etykietą maszynową (mono, wersaliki, wyciszony), potem nazwa atramentem tekstu.
/// Systemowy podtytuł ma w jasnym motywie za mały kontrast (ok. 3,3:1), a nazwa projektu ma być głośniejsza od
/// rodzaju okna.
struct WindowTitle: View {
  let kind: String
  let name: String
  var identifier: String?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(kind)
        .eyebrow()
        .lineLimit(1)
        .fixedSize()
      if !name.isEmpty {
        Text(name)
          .appFont(.headline)
          .foregroundStyle(Color(uiColor: Palette.text))
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name.isEmpty ? kind : "\(kind): \(name)")
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier(identifier ?? "")
  }
}

/// Obrys okna w kształcie arkusza (promień bierze z arkusza). Przy „Zwiększ kontrast” mocniejszy.
private struct WindowOutline: View {
  @Environment(\.colorSchemeContrast) private var contrast

  var body: some View {
    ConcentricRectangle()
      .stroke(
        contrast == .increased ? Color(uiColor: Palette.text).opacity(0.3) : Color(uiColor: Palette.border), lineWidth: 1)
      // Kreska w całości wewnątrz arkusza.
      .padding(0.5)
      .ignoresSafeArea()
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}
#endif
