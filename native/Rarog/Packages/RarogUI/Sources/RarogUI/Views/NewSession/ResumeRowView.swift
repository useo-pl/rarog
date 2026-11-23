#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// Wiersz rozmowy CLI — wspólny dla „Rozmów w tym katalogu" i „Ostatnich sesji". Jedna
/// linia i jeden cel dotyku: zamknięta rozmowa wznawia się stuknięciem w cały wiersz (koło ▶ jest jego
/// częścią), otwarta w herdr przechodzi do swojej karty, a „Rozwidl” stoi obok jako osobny przycisk. Rozmowy żywej
/// NIGDY się nie wznawia (dwóch pisarzy jednego pliku). Błąd stoi PRZY wierszu. Właściciel: sterowanie sesją.
struct ResumeRowView: View {
  let entry: ResumableSession
  let now: Date
  /// Akcja tego wiersza w toku (spinner, reszta wierszy czeka).
  let busy: Bool
  let disabled: Bool
  /// Metadane pod tytułem (wąski arkusz): w jednej linii czas, gałąź, znacznik i „Rozwidl” zostawiały tytułowi
  /// kilka liter.
  var stacked = false
  let error: String?
  let resume: () -> Void
  let open: (() -> Void)?
  let fork: (() -> Void)?
  @Environment(\.dynamicTypeSize) private var typeSize

  /// Plama wskaźnika wychodzi tyle poza treść wiersza: kończąca się równo z tekstem wygląda na uciętą.
  /// Ujemny odstęp oddaje to miejsce, więc tekst zostaje w linii z nagłówkiem sekcji.
  static let hoverOutset: CGFloat = 8

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      let large = typeSize.isAccessibilitySize
      // „Rozwidl” w piśmie dostępności schodzi pod wiersz, inaczej zabierał tytułowi połowę szerokości. W linii stoi
      // za plamą wskaźnika, nie na jej krawędzi.
      let rowLayout = large
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
        : AnyLayout(HStackLayout(alignment: .center, spacing: 8 + Self.hoverOutset))
      rowLayout {
        Button(action: primary) {
          // W piśmie dostępności i w wąskim arkuszu tytuł i metadane idą w pionie: w jednej linii czas i gałąź
          // wypychały tytuł do „Dopi…” (kadr AX5). Koło ▶ i znacznik zostają wtedy z prawej (poza
          // pismem dostępności): w kolumnie stały w osobnej linii i wiersz zajmował trzy.
          let line = large
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 10))
          let text = large || stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 10))
          line {
            text {
              Text(ResumeRow.title(entry))
                .appFont(.subheadline)
                .foregroundStyle(Color(uiColor: Palette.text))
                .lineLimit(large ? nil : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
              Text(ResumeRow.meta(entry, now: now))
                .appFont(.caption.monospaced())
                .foregroundStyle(Color(uiColor: Palette.muted))
                .lineLimit(large ? nil : 1)
                .fixedSize(horizontal: !large, vertical: false)
            }
            // The status of an open conversation is a muted word in the metadata (`ResumeRow.meta`), not a capsule
            // (mockup); a closed one has the ▶ circle.
            if !entry.liveInHerdr, !busy {
              // Koło bez wypełnienia: wiersz formularza systemowego nie niesie kryjących plam akcentu.
              Image(systemName: "play.fill")
                .appFont(.caption)
                .foregroundStyle(Color(uiColor: Palette.text))
                .frame(width: 28, height: 28)
                .overlay(Circle().strokeBorder(Color(uiColor: Palette.muted)))
            }
          }
          // Dwie linie tekstu nie stykają się z górą i dołem plamy; jedna ma ten oddech z celu 44 pt.
          .padding(.vertical, large || stacked ? 6 : 0)
          .frame(minHeight: 44)
          .padding(.horizontal, Self.hoverOutset)
          .contentShape(Rectangle())
          .rarogHover(.fill, in: RoundedRectangle(cornerRadius: Radius.inner), enabled: !disabled)
          .padding(.horizontal, -Self.hoverOutset)
        }
        .buttonStyle(.plain)
        .disabled(disabled || (entry.liveInHerdr && open == nil))
        .help(entry.liveInHerdr ? UICopy.resumeOpen : UICopy.resume)
        .accessibilityLabel(primarySpoken)
        .accessibilityIdentifier(entry.liveInHerdr
          ? "resume.open.\(entry.engineSessionId)" : "resume.resume.\(entry.engineSessionId)")
        if busy {
          ProgressView().frame(minWidth: 44, minHeight: 44)
        } else if entry.liveInHerdr, let fork {
          // „Rozwidl” zakłada nową sesję, więc obrys w atramencie tekstu. Bez bursztynu: akcent zostaje przy
          // „Wyślij", a w tym formularzu bursztyn znaczy tryb auto.
          Button(UICopy.resumeFork, action: fork)
            .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.text)))
            .fixedSize()
            .disabled(disabled)
            .accessibilityLabel(UICopy.resumeForkSpoken(entry))
            .accessibilityIdentifier("resume.fork.\(entry.engineSessionId)")
        }
      }
      if let error {
        Text(error)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.err))
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  /// Cel stuknięcia w wiersz: otwarta → jej karta, zamknięta → wznowienie.
  private func primary() {
    if entry.liveInHerdr { open?() } else { resume() }
  }

  private var primarySpoken: String {
    let action = entry.liveInHerdr ? UICopy.resumeOpenSpoken(entry) : UICopy.resumeSpoken(entry)
    return "\(action), \(UICopy.resumeMetaSpoken(entry, now: now))"
  }
}
#endif
