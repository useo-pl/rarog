#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Stany transkryptu bez treści: pusty i przed pierwszym stanem. Właściciel: transkrypt.

/// Pusty transkrypt: zdanie od lewej, krojem treści — pierwsza linijka rozmowy.
struct EmptyTranscriptView: View {
  let text: String
  let sub: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      // Zdanie podpowiedzi, nie wypowiedź: mniejsze i wyciszone, jak `.empty--flow` w PWA.
      Text(text).appFont(.subheadline).foregroundStyle(Color(uiColor: Palette.muted))
      if let sub { Text(sub).appFont(.footnote).foregroundStyle(Color(uiColor: Palette.muted)) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 12)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("transcript.empty")
  }
}

/// Szkielet transkryptu przed pierwszym stanem — wiernie powtarza układ treści.
struct TranscriptSkeletonView: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach([0.55, 0.9, 0.75, 0.4], id: \.self) { fraction in
        GeometryReader { proxy in
          RoundedRectangle.ghost
            .fill(Color(uiColor: Palette.border))
            .frame(width: proxy.size.width * fraction, height: 12)
        }
        .frame(height: 12)
      }
    }
    .padding(.top, 16)
    .accessibilityHidden(true)
  }
}
#endif
