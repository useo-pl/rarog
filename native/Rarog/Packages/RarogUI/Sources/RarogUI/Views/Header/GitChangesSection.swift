#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Treść rozwinięcia gita bez przewijania i bez pobierania czegokolwiek: ostatni commit nad listą
/// plików („co już weszło" obok „co jeszcze wisi"), lista z literą A/M/D i bilansem `+a −b` albo same
/// ścieżki — wiersze z ramki `git-status` daje właściciel. Wiersz oddaje cel otwarcia diffa (`open`: ścieżka
/// pliku); „Pokaż diff" od góry stoi w stopce dymka, a okno i patch należą do nawigacji (`GitDetailsPanel`).
/// Właściciel: nagłówek.
struct GitChangesSection: View {
  let meta: GitMeta
  let rows: [InspectorFileRow]
  /// „pokazano 50 z 73", gdy ramka nie niesie wszystkich plików.
  let shown: String?
  let open: (_ path: String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let commit = meta.lastCommit { CommitRow(commit: commit) }
      if rows.isEmpty {
        Text(GitChangesModel.emptyNote(meta: meta))
          .appFont(.subheadline)
          .foregroundStyle(Color(uiColor: Palette.muted))
      } else {
        // Bez odstępu między wierszami: cele 44 pt stykają się, nie nakładają. Odstęp wizualny daje sama
        // wysokość wiersza, więc nagłówek i „pokazano …” stoją tak daleko od tekstu wiersza jak przy 36 + 4.
        VStack(alignment: .leading, spacing: 0) {
          Text(UICopy.changedFilesHeader(meta.dirtyCount ?? rows.count).uppercased())
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: Palette.muted2))
            .accessibilityAddTraits(.isHeader)
          ForEach(rows) { row in
            GitFileRowButton(row: row) { open(row.path) }
          }
          if let shown {
            Text(shown)
              .appFont(.caption)
              .foregroundStyle(Color(uiColor: Palette.muted))
              .padding(.top, 4)
          }
        }
      }
    }
  }
}

/// `3f9a2c1 feat(notes): zapis notatki · 3 paź 14:05` — skrót SHA na głos nie znaczy nic,
/// więc czytnik dostaje zdanie.
struct CommitRow: View {
  let commit: GitCommit
  @Environment(\.sectionPlace) private var place

  var body: some View {
    let when = GitChangesModel.commitWhen(commit.at, now: Date())
    Text(line(when: when))
      .appFont(.footnote.monospaced())
      .lineLimit(3)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(UICopy.commitSpoken(subject: commit.subject, when: when))
      .accessibilityIdentifier(place.id("git.commit"))
  }

  private func line(when: String?) -> AttributedString {
    var hash = AttributedString(commit.hash)
    hash.foregroundColor = Color(uiColor: Palette.muted2)
    var subject = AttributedString(" \(commit.subject)")
    subject.foregroundColor = Color(uiColor: Palette.text)
    var tail = AttributedString(when.map { " · \($0)" } ?? "")
    tail.foregroundColor = Color(uiColor: Palette.muted2)
    return hash + subject + tail
  }
}

/// Bilans pliku po prawej stronie wiersza: `+a` zielenią i `−b` czerwienią (minus U+2212: w cyfrach
/// tabelarycznych ma szerokość plusa), plik binarny — „bin". Zero i „nie wiem" nie tworzą członu. Ten sam znak
/// w drzewie zmian panelu, w dymku gita i w nagłówkach okna diffa.
struct GitFileStats: View {
  let added: Int?
  let deleted: Int?
  let binary: Bool

  var body: some View {
    if binary {
      Text(UICopy.inspectorBinary)
        .appFont(.caption.monospaced())
        .foregroundStyle(Color(uiColor: Palette.muted2))
    } else {
      HStack(spacing: 4) {
        if let added, added > 0 {
          Text("+\(added)").foregroundStyle(Color(uiColor: Palette.run))
        }
        if let deleted, deleted > 0 {
          Text("−\(deleted)").foregroundStyle(Color(uiColor: Palette.err))
        }
      }
      .appFont(.caption.monospacedDigit())
    }
  }
}

/// Wiersz pliku: litera, ścieżka (środek ucinany — nazwa pliku zostaje), bilans. Każdy wiersz
/// otwiera diff na tym pliku, także sama ścieżka bez litery. Cała rama wiersza (co najmniej 44 pt, HIG) jest
/// celem dotyku (`contentShape`).
private struct GitFileRowButton: View {
  let row: InspectorFileRow
  let open: () -> Void
  @Environment(\.sectionPlace) private var place

  var body: some View {
    Button(action: open) {
      HStack(spacing: 8) {
        Text(row.status?.rawValue ?? " ")
          .foregroundStyle(Color(uiColor: GitInk.color(row.status)))
          .frame(width: 14)
        Text(row.plain)
          .foregroundStyle(Color(uiColor: Palette.text))
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer(minLength: 8)
        GitFileStats(added: row.added, deleted: row.deleted, binary: row.binary)
      }
      .appFont(.footnote.monospaced())
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(row.spoken)
    .accessibilityIdentifier(place.id("git.file.\(row.path)"))
  }
}
#endif
