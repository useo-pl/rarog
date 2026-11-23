@testable import RarogUI
import Testing

// Pole wiadomości przy schowanej klawiaturze. Geometrię na
// prawdziwym ekranie sesji sprawdza `RarogUIKitTests/SessionLayoutTests`. Właściciel: pole.

@Suite("pole przy dolnej krawędzi ekranu (FootRest)")
struct FootRestTests {
  @Test("16 pt w głąb safe area, nie bliżej krawędzi niż 12 pt; bez safe area 8 pt — jak stopka listy")
  func gap() {
    #expect(FootRest.gap(safeBottom: 34) == 18, "iPhone Air")
    #expect(FootRest.gap(safeBottom: 20) == 12, "iPad z paskiem home")
    #expect(FootRest.gap(safeBottom: 21) == 12, "iPhone w poziomie")
    #expect(FootRest.gap(safeBottom: 48) == 32)
    #expect(FootRest.gap(safeBottom: 0) == 8, "bez safe area")
  }

  @Test("the transcript inset covers the foot from its top to the bottom of the view, plus 12 pt")
  func transcriptInset() {
    #expect(FootRest.transcriptInset(footTop: 726, viewBottom: 852) == 138, "iPhone, field at rest")
    #expect(FootRest.transcriptInset(footTop: 426, viewBottom: 852) == 438, "foot over a keyboard")
    #expect(FootRest.transcriptInset(footTop: 852, viewBottom: 852) == 12, "no foot: only the breath")
    #expect(FootRest.transcriptInset(footTop: 900, viewBottom: 852) == 12, "foot below the view never shrinks it")
  }

  @Test("pasek skrótów klawiatury sprzętowej (niska prowadnica) leży nad polem, klawiatura podnosi pole")
  func guideSlack() {
    func slack(_ rest: Double, _ overlap: Double, _ height: Double, hardware: Bool = true) -> Double {
      FootRest.guideSlack(rest: rest, overlap: overlap, guideHeight: height, hardwareKeyboard: hardware)
    }
    #expect(slack(-2, 0, 0) == 0, "schowana klawiatura")
    #expect(slack(4, 0, 20) == 4, "widok nad dołem okna: prowadnica ma wysokość pasa pod nim, ale w widok nie wchodzi")
    #expect(slack(-2, 56, 56) == 56, "pigułka: stopa schodzi pod nią")
    #expect(slack(4, 3, 3) == 7, "klatka animacji pigułki")
    #expect(slack(-2, 149, 149) == 149)
    #expect(slack(-2, 150, 150) == 0, "od 150 pt to klawiatura")
    #expect(slack(-2, 310, 300) == 0, "pływająca: stopa na jej górze")
    #expect(slack(-2, 1194, 0) == 0, "pusta ramka z pierwszego przebiegu układu — jak przed rewizją")
    #expect(slack(2, 100, 100, hardware: false) == 0,
            "bez klawiatury sprzętowej: klawiatura ekranowa przycięta do okna Stage Managera, pole nad nią")
  }

  /// `guideSlack` zakłada, że dół ekranu sesji nie rusza się, gdy pojawia się pigułka. SwiftUI liczy ją jako region
  /// klawiatury, a przy nim sam region kontenera nie oddaje pasa wskaźnika home: ekran robił się krótszy, tracił
  /// dolną wstawkę i pole podjeżdżało o 21 pt (iPad). Symulator pigułki ani klawiatury ekranowej
  /// w teście hostowanym nie pokazuje, więc pilnujemy źródła.
  @Test("ekran sesji i tło szczegółu ignorują przy dolnej krawędzi wszystkie regiony safe area")
  func screenReachesTheEdgeInEveryRegion() throws {
    let screen = try SessionListSourceTests.code("Session/SessionScreen.swift")
    #expect(screen.contains(".ignoresSafeArea(edges: .bottom)"), "ekran sesji: wszystkie regiony")
    #expect(!screen.contains(".ignoresSafeArea(.container"), "sam kontener nie wystarcza przy regionie klawiatury")
    let detail = try SessionListSourceTests.code("Views/DetailView.swift")
    #expect(detail.contains("Color(uiColor: Palette.background).ignoresSafeArea()"), "tło szczegółu pod regionem klawiatury")
  }
}
