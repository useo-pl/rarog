#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Konflikt notatki projektu (409 albo zmiana z drugiego urządzenia przy brudnym polu): baner nad polem i strona
// „Porównaj" na stosie formularza. Pole zostaje pod palcami, autozapis stoi, a wybór człowiek robi, kiedy skończy
// myśl. Bez zieleni i czerwieni: kolor w apce znaczy stan sesji, nie stronę sporu. „Połącz" tylko wtedy, gdy obie
// strony wyłącznie dopisały (`NoteMerge.appended`). Każde rozstrzygnięcie najpierw oddaje nagranie (`settle`):
// wiązanie dyktowania liczy tekst od bazy sprzed wyboru, więc następny token nadpisałby wynik. Właściciel: notatki
// (apka natywna).

/// Baner nad polem: zdanie z godziną tamtej wersji, „Połącz" (same dopiski) i „Porównaj".
struct NoteConflictBanner: View {
  let doc: NoteDocument
  let conflict: NotesDoc
  /// Oddaje nagranie przed rozstrzygnięciem (`NoteDictation.handOff`).
  let settle: () -> Void
  let compare: () -> Void
  @Environment(\.horizontalSizeClass) private var sizeClass

  var body: some View {
    let layout = sizeClass == .regular
      ? AnyLayout(HStackLayout(alignment: .center, spacing: 12))
      : AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
    layout {
      Text(UICopy.noteConflict(conflict.updatedAt))
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
      if sizeClass == .regular { Spacer(minLength: 8) }
      HStack(spacing: 8) {
        Button(UICopy.noteCompare, action: compare)
          .buttonStyle(NeutralButtonStyle())
          .accessibilityIdentifier("note.compare")
        if doc.mergeResult != nil {
          Button(UICopy.noteMerge) {
            settle()
            doc.merge()
          }
            .buttonStyle(PrimaryButtonStyle(size: .inline))
            .accessibilityIdentifier("note.merge")
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface2)))
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("note.banner")
  }
}

/// Strona „Porównaj": zdanie, co da się zrobić, wersje POD SOBĄ (kreska przy liniach z jednej wersji) i akcje ze
/// zdaniem skutku. Formularz jest za wąski na dwie kolumny, a jeden układ to połowa stanów do testów.
struct NoteComparePage: View {
  let doc: NoteDocument
  let project: String
  /// Oddaje nagranie przed rozstrzygnięciem (`NoteDictation.handOff`).
  let settle: () -> Void
  /// Wybór zrobiony albo konflikt zniknął sam: powrót do pola.
  let done: () -> Void

  var body: some View {
    Group {
      if let conflict = doc.conflict {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(doc.mergeResult == nil ? UICopy.noteCompareDiverged : UICopy.noteCompareAppended)
              .appFont(.subheadline)
              .foregroundStyle(Color(uiColor: Palette.text))
              .fixedSize(horizontal: false, vertical: true)
            NoteVersionBlock(
              title: UICopy.noteServerVersion(conflict.updatedAt), text: conflict.text, other: doc.text,
              identifier: "note.version.server")
            NoteVersionBlock(
              title: UICopy.noteMineVersion, text: doc.text, other: conflict.text, copyable: true,
              identifier: "note.version.mine")
          }
          .padding(16)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { actions(conflict) }
      } else {
        Color.clear.onAppear(perform: done)
      }
    }
    .background(Color(uiColor: Palette.background))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        WindowTitle(kind: UICopy.noteCompareTitle, name: project, identifier: "note.compare.title")
      }
    }
    // Strona bierze klawiaturę: pole notatki zeszło z okna, a bez kotwicy Return trafiłby do pola wiadomości pod
    // arkuszem. Esc i Cmd+W wracają do pola przez zamknięcie arkusza (`NoteSheet`): drugi skrót Esc tutaj by
    // przegrał z jego skrótem.
    .background { SheetKeyboardAnchor() }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("note.compare.page")
  }

  private func actions(_ conflict: NotesDoc) -> some View {
    VStack(spacing: 12) {
      if doc.mergeResult != nil {
        Button(UICopy.noteMerge) {
          settle()
          doc.merge()
          done()
        }
        .buttonStyle(PrimaryButtonStyle())
        // ⏎ = „Połącz", gdy jest; bez niego Return nic nie robi — apka nie podpowiada, która wersja lepsza.
        .keyboardShortcut(.defaultAction)
        .accessibilityIdentifier("note.compare.merge")
      }
      HStack(alignment: .top, spacing: 12) {
        choice(UICopy.noteKeepMine, effect: UICopy.noteKeepMineEffect(conflict.updatedAt), id: "note.keepMine") {
          doc.keepMine()
        }
        choice(UICopy.noteTakeTheirs, effect: UICopy.noteTakeTheirsEffect, id: "note.takeTheirs") {
          doc.takeTheirs()
        }
      }
      if NoteMerge.both(mine: doc.text, theirs: conflict.text) != nil {
        Button(UICopy.noteInsertBoth) {
          settle()
          doc.insertBoth()
          done()
        }
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .frame(minHeight: 44)
        .buttonStyle(.plain)
        .accessibilityIdentifier("note.insertBoth")
      }
    }
    .padding(16)
    .background(Color(uiColor: Palette.background))
    .overlay(alignment: .top) {
      Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1).accessibilityHidden(true)
    }
  }

  private func choice(_ title: String, effect: String, id: String, action: @escaping () -> Void) -> some View {
    VStack(spacing: 6) {
      Button(title) {
        settle()
        action()
        done()
      }
      .buttonStyle(NeutralButtonStyle())
      .frame(maxWidth: .infinity)
      .accessibilityHint(effect)
      .accessibilityIdentifier(id)
      Text(effect)
        .appFont(.caption)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityHidden(true)
    }
    .frame(maxWidth: .infinity)
  }
}

/// Jedna wersja na stronie porównania: etykieta, opcjonalnie „Kopiuj", linie tekstu z kreską 2 pt `muted` przy
/// liniach, których druga wersja nie ma (`NoteMerge.lineMarks`). Tekst surowy, bez renderu markdownu: porównuje
/// się znaki, nie wygląd.
struct NoteVersionBlock: View {
  let title: String
  let text: String
  let other: String
  var copyable = false
  let identifier: String

  var body: some View {
    let lines = NoteMerge.lines(text)
    let marks = NoteMerge.lineMarks(lines, against: NoteMerge.lines(other))
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(title)
          .eyebrow()
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 8)
        if copyable {
          Button(UICopy.noteCopy) { UIPasteboard.general.string = text }
            .appFont(.footnote.weight(.semibold))
            .foregroundStyle(Color(uiColor: Palette.text))
            .frame(minHeight: 44)
            .buttonStyle(.plain)
            .accessibilityIdentifier("\(identifier).copy")
        }
      }
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
          HStack(alignment: .top, spacing: 8) {
            Rectangle()
              .fill(Color(uiColor: marks[index] ? Palette.muted : .clear))
              .frame(width: 2)
              .accessibilityHidden(true)
            Text(line.isEmpty ? " " : line)
              .appFont(.subheadline)
              .foregroundStyle(Color(uiColor: Palette.text))
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
          .accessibilityElement(children: .combine)
          .accessibilityValue(marks[index] ? UICopy.noteLineOnlyHere : "")
        }
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface)))
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(identifier)
  }
}
#endif
