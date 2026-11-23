#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Dymek w prawej kolumnie. Właściciel: łączność. Reguły i cykl życia: `Model/ToastCenter`.

/// Dymek u DOŁU prawej kolumny na ekranach bez transkryptu (terminal, Codex, projekt, pusta kolumna); ekran sesji
/// ma go u siebie, nad promptem (`SessionViewController+Toast`) — wtedy nakładka
/// milczy (`ToastPlacement`). Na liście iPada go nie ma — tam stan mówi kropka wiersza; lista iPhone'a (stos bez
/// kolumny szczegółu) pokazuje tylko dymki z akcją (`actionsOnly`: „Cofnij" po skasowaniu notatki nie może przepaść
/// tylko dlatego, że formularz zamknięto nad listą). Okno terminala Cmd+F/Cmd+G stawia ten sam modyfikator u dołu
/// arkusza (`slot: .terminalWindow`); kolumna pod nim wtedy milczy. Zegar i ogłoszenie czytnika prowadzi `ToastCenter`.
struct ToastOverlay: ViewModifier {
  let navigation: RarogNavigation
  /// Gdzie dymek stoi teraz (`ToastPlacement.resolve`).
  let placement: ToastPlacement
  var actionsOnly = false
  /// Które osadzenie rysuje ten modyfikator: kolumna (`overlay`) albo okno terminala (`terminalWindow`).
  var slot: ToastPlacement = .overlay
  /// Opcjonalnie: ekran hostowany bez centrum dymków (testy) rysuje się bez nakładki.
  @Environment(ToastCenter.self) private var toasts: ToastCenter?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .bottom) {
        let current = placement == slot ? toasts?.current : nil
        let toast = actionsOnly && current?.action == nil ? nil : current
        ZStack {
          if let toast {
            ToastCard(toast: toast, action: { open(toast) }, perform: { perform(toast) })
              .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
          }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        // Animacja należy WYŁĄCZNIE do kontenera dymka. Na całej kolumnie zamiana ekranu w tej
        // samej transakcji co zniknięcie dymka (stuknięcie → nowa sesja) animowała się razem z nim, na wątku
        // zajętym budową nowego kontrolera — stąd rwanie.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: toast?.id)
      }
  }

  /// Tap: dymek o sesji prowadzi do niej (i gaśnie), komunikat apki tylko się zamyka. Bez animacji: dymek
  /// gaśnie od razu, a informacją zwrotną jest nowy ekran — przełączany dopiero w NASTĘPNEJ klatce
  /// (`ToastHandoff`), żeby budowa nowego ekranu nie trzymała na wierzchu starej klatki z dymkiem.
  private func open(_ toast: Toast) {
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { toasts?.dismiss(toast.id) }
    guard let sessionId = toast.sessionId else { return }
    ToastHandoff.open(sessionId, navigation: navigation)
  }

  /// Segment akcji: dymek gaśnie bez animacji, akcja rusza (centrum wykonuje ją tylko dla dymka na ekranie).
  private func perform(_ toast: Toast) {
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { toasts?.performAction(toast.id) }
  }
}

/// Przełączenie sesji po stuknięciu w dymek bez zacięcia animacji znikania. Nowy ekran sesji buduje się na głównym
/// wątku: zgaszenie dymka i zamiana ekranu w tej samej
/// transakcji zostawiają na ekranie STARĄ klatkę z dymkiem na cały czas budowy (nagranie symulatora: 190 ms bez
/// nowej klatki, dymek schodzi dopiero razem z nowym ekranem). Dlatego zgaszenie idzie na ekran od razu
/// (`CATransaction.flush()`), a przełączenie czeka na następną klatkę (`CADisplayLink`: jedna klatka, bez sztucznej
/// pauzy) — w czasie budowy stoi stary ekran już bez dymka. Samo `setCompletionBlock` nie wystarcza: bez animacji
/// woła się od razu, przed wyświetleniem klatki. Właściciel: łączność.
@MainActor
enum ToastHandoff {
  /// Sesja z dymka w następnej klatce — o ile człowiek nie przeszedł w tym czasie gdzie indziej (ten sam ekran
  /// prawej kolumny co w chwili stuknięcia; przepięcie „Nowego terminala" na jego id ekranu nie zmienia). Bez
  /// animacji zamiany ekranu.
  static func open(_ sessionId: String, navigation: RarogNavigation) {
    let screen = navigation.screenRevision
    afterHiding { [weak navigation] in
      guard let navigation, navigation.screenRevision == screen else { return }
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) { navigation.selectSession(sessionId) }
    }
  }

  /// Wysyła bieżące zmiany warstw na ekran i woła `action` przy następnej klatce.
  static func afterHiding(_ action: @escaping @MainActor () -> Void) {
    CATransaction.flush()
    NextFrame(action).start()
  }

  /// Jednorazowy `CADisplayLink`: pętla trzyma cel do `invalidate`, więc obiekt żyje dokładnie do pierwszej klatki.
  @MainActor
  private final class NextFrame: NSObject {
    private var action: (@MainActor () -> Void)?

    init(_ action: @escaping @MainActor () -> Void) {
      self.action = action
    }

    func start() {
      CADisplayLink(target: self, selector: #selector(fire(_:))).add(to: .main, forMode: .common)
    }

    @objc private func fire(_ link: CADisplayLink) {
      link.invalidate()
      let action = action
      self.action = nil
      action?()
    }
  }
}

/// Dymek: słowo rodzaju w kolorze tonu, „projekt · sesja" wyciszone i strzałka „prowadzi dalej";
/// komunikat apki to samo zdanie, bez tonu i bez strzałki, a z akcją — osobny segment za pionową kreską
/// (stuknięcie w resztę dymka tylko go zamyka). Potwierdzenie (`ToastStyle.confirmation`) ma znacznik „✓” przed
/// zdaniem.
struct ToastCard: View {
  let toast: Toast
  let action: () -> Void
  /// Segment akcji (`Toast.action`).
  var perform: () -> Void = {}

  var body: some View {
    HStack(spacing: 0) {
      Button(action: action) { message }
        .buttonStyle(.plain)
        .accessibilityLabel(toast.text)
        .accessibilityHint(toast.sessionId == nil ? UICopy.toastClose : UICopy.toastOpenHint)
        .accessibilityIdentifier(toast.sessionId == nil ? "toast.notice" : "toast.session")
      if let toastAction = toast.action {
        Rectangle()
          .fill(Color(uiColor: Palette.border))
          .frame(width: 1)
          .padding(.vertical, 8)
          .accessibilityHidden(true)
        Button(action: perform) {
          Text(toastAction.label)
            .fontWeight(.semibold)
            .foregroundStyle(Color(uiColor: Palette.text))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(toastAction.identifier)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .appFont(.callout)
    .background(Color(uiColor: Palette.surface), in: .capsule)
    .overlay(Capsule().strokeBorder(Color(uiColor: Palette.border)))
    .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
  }

  private var message: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if let kind = toast.kind, let place = toast.place {
        Text(kind)
          .fontWeight(.semibold)
          .foregroundStyle(Color(uiColor: toast.tone.map(Palette.tone) ?? Palette.text))
        Text(place)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .lineLimit(1)
          .truncationMode(.middle)
      } else {
        if toast.style == .confirmation {
          // Potwierdzenie gestu (kopia w terminalu): znacznik przed zdaniem, bez koloru.
          Image(systemName: "checkmark")
            .appFont(.footnote.weight(.semibold))
            .foregroundStyle(Color(uiColor: Palette.text))
            .accessibilityHidden(true)
        }
        Text(toast.text)
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
      }
      if toast.sessionId != nil {
        Image(systemName: "chevron.right")
          .appFont(.footnote.weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.muted))
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .contentShape(Rectangle())
  }
}
#endif
