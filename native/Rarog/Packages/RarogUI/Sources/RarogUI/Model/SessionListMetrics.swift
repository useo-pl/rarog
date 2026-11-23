import CoreGraphics

/// Odstępy kolumny listy sesji. Czyste liczby, testowane na macOS (`SessionListMetricsTests`); widok
/// w `Views/List/SessionListView`. Właściciel: kontener listy.
enum SessionListMetrics {
  /// Wcięcie wiersza agenta u góry i u dołu. Cel dotyku i tak ≥ 44 pt.
  static let rowVerticalInset: CGFloat = 5.5
  /// Wcięcie wiersza z boku: z prawej treść wiersza kończy się tyle przed końcem komórki; w drzewie z lewej liczy się
  /// od niego wcięcie agenta (`ProjectTreeRows.agentIndent`).
  static let rowSideInset: CGFloat = 8
  /// Margines listy od lewej krawędzi kolumny: tu zaczyna się komórka i jej treść (cel strzałki, nazwa). 4 pt:
  /// treść stoi blisko lewej krawędzi podświetlenia, a samo podświetlenie ma własną krawędź (`plateEdge`).
  static let listLeadingMargin: CGFloat = 4
  /// Plama wiersza (wskaźnik, fokus; nagłówek projektu, szkielet, pusta lista) od lewej krawędzi kolumny — jak przed
  /// zmniejszeniem marginesu listy. Plama agenta w drzewie stoi dalej, za prowadnicą
  /// (`ProjectTreeRows.agentPlateInset`).
  static let plateEdge: CGFloat = 8
  /// To samo od krawędzi komórki: `plateEdge − listLeadingMargin` = 4 pt.
  static let rowPlateInset: CGFloat = plateEdge - listLeadingMargin
  /// Margines listy od prawej krawędzi kolumny (koniec plamy, liczniki) — bez zmian.
  static let listTrailingMargin: CGFloat = 8

  /// Nagłówek projektu w drzewie: najniższa wysokość (cel dotyku) i odstęp tekstu od góry — 44 pt.
  static let projectRowMinHeight: CGFloat = 44
  static let projectRowPadding: CGFloat = 6
  /// Odstęp treści wiersza agenta od jego wcięć u góry i u dołu (`SessionRow`).
  static let agentRowPadding: CGFloat = 2
  /// Od linii tekstu agenta do krawędzi jego komórki: wcięcie i padding wiersza (5,5 + 2 pt).
  static let agentEdge: CGFloat = rowVerticalInset + agentRowPadding

  // Odstępy drzewa oddzielają projekty od siebie. Reguła:
  // odstęp od linii bazowej ostatniej linii bloku wyżej do górnej krawędzi małych liter pierwszej linii niżej jest
  // równy w parach (a) nagłówek → pierwszy agent i agent ↔ agent oraz (b) ostatni agent → następny nagłówek
  // i nagłówek bez agentów → następny nagłówek (~33 pt przed nagłówkiem z gałęzią: 23 pt bez oddechu + 10 pt). Wysokość
  // wiersza zależy tylko od niego samego i od tego, czy wiersz wyżej to nagłówek bez linii gałęzi — zwinięcie projektu
  // nie zmienia wysokości wierszy, które zostają, więc kotwica przewinięcia trzyma zaznaczony wiersz
  // (`ProjectTreeListTests`). Stałe nie rosną z pismem.

  /// Pod tekstem nagłówka tyle co pod tekstem agenta. Linia gałęzi nagłówka i linia stanu
  /// agenta to ten sam krój (`caption` mono), więc (a) nagłówek → pierwszy agent = agent ↔ agent, a zwinięty nagłówek z gałęzią kończy się jak agent (b).
  static let projectRowBottomPadding: CGFloat = agentEdge
  /// Oddech między projektami: nad nagłówkiem, który nie stoi pierwszy na liście, po agencie i po nagłówku z gałęzią.
  /// Nigdy między agentami. Plama i fokus nagłówka zaczynają się pod nim.
  static let projectGap: CGFloat = 10
  /// (b) O tyle niżej kończy się nagłówek bez linii gałęzi (projekt bez gita) niż agent albo nagłówek z gałęzią. Nazwę
  /// (linia 18 pt pisma 15 pt) trzyma na środku cel strzałki 44 pt, więc pod linią zostaje (44 − 18) / 2 = 13 pt,
  /// a pod linią stanu agenta `agentEdge` = 7,5 pt; 5,5 pt plus ~0,5 pt różnicy zejść liter pisma 15 i 12 pt.
  /// Zmierzone na zrzucie iPada w zwykłym piśmie: 6,0 pt (agent → nagłówek 23,0 pt, nagłówek bez agentów → nagłówek
  /// 29,0 pt, bez tej dopłaty). O ten luz oddech po takim nagłówku jest mniejszy (10 − 6 = 4 pt).
  static let emptyHeaderBottomExtra: CGFloat = 6

  // Buttons at the end of a project header's first line: the pop-up terminal, the Recent Sessions clock and the note
  // glyph, placed by `TreeHeaderButtonGeometry`.

  /// Height of a project header button's target: the full 44 pt touch height.
  static let treeButtonHeight: CGFloat = 44
  /// Narrowest target of a project header button. Narrower than 44 pt so the three glyphs stand close together; the
  /// height stays 44 pt.
  static let treeButtonWidth: CGFloat = 36
  /// Smallest air between two header glyphs; the gap grows only where `treeButtonWidth` needs more room.
  static let treeButtonGap: CGFloat = 16
  /// How far the last button's target reaches past its glyph: the cell's trailing inset, outside of which a tap does
  /// not reach the button.
  static let treeButtonReach: CGFloat = rowSideInset

  /// Miejsce w pasku listy na prawo od „AGENCI (N)” i statusu: odstęp, „Ustawienia” i „Nowa sesja” (dwa ciche glify
  /// w celach 44 pt bez kapsuły szkła) i margines paska — z zapasem,
  /// żeby nagłówek nie wszedł pod przycisk. Z rezerwą na jeden przycisk „AGENCI” wyjeżdża za lewą krawędź
  /// („GENCI (8)” na iPadzie).
  static let headerTrailingReserve: CGFloat = 128

  /// Najmniejsza szerokość nagłówka listy (`.principal`). Bez systemowego uchwytu w pasku jedyny przycisk
  /// stoi po prawej, a pasek centruje element, który mieści się symetrycznie: nagłówek odjeżdżałby od lewej krawędzi.
  /// Minimum większe niż miejsce symetryczne trzyma go przy lewej. Kolumna niezmierzona (0) — bez minimum.
  static func headerMinWidth(columnWidth: CGFloat) -> CGFloat {
    max(0, columnWidth - headerTrailingReserve)
  }
}
