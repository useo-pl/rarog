#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Karta pytania w transkrypcie albo w doku w miejscu pola. Właściciel: karty pytań.

/// Co karta pytania zleca ekranowi sesji (`SessionViewController+Answers`). Karta przekazuje
/// model z chwili gestu; ekran sprawdza go na bieżącym stanie, zanim cokolwiek wyśle.
struct QuestionCardActions {
  /// Tapnięcie opcji (sekcja, etykieta). Na karcie `instant` od razu wysyła.
  let pick: (QuestionCardModel, Int, String) -> Void
  /// Tapnięcie wiersza „Własna odpowiedź" — rozwija pole.
  let openCustom: (QuestionCardModel, Int) -> Void
  /// Tekst pola „Własna odpowiedź".
  let setCustom: (QuestionCardModel, Int, String) -> Void
  /// Tekst pola „Notatka".
  let setNote: (QuestionCardModel, Int, String) -> Void
  /// „Odpowiedz" z kompletem odpowiedzi i notatkami (`nil` = bez notatek; wyjście nigdy ich nie niesie).
  let send: (QuestionCardModel, [[String]], [String?]?) -> Void
  /// „Odpowiedz" bez kompletu albo z notatką, której nie da się wysłać: zdanie pod kartą.
  let missing: (QuestionCardModel, String) -> Void
}

/// Karta pytania: odpowiedzi autora jako WIERSZE z kluczem (cyfra n-tej widocznej
/// opcji), opis pod etykietą, rekomendacja na górze ze słowem „rekomendacja", opcja „tylko
/// w terminalu" czytelna, ale bez gestu; formularz to jedna karta z sekcjami i jedną stopką.
/// Po odpowiedzi wiersz stanu zastępuje stopkę: „Wysłano „X" → czekam na ekran", potem
/// „Odpowiedź przyjęta: „X"".
///
/// Kolejność sekcji: nagłówek → pytanie (albo lista przeglądu formularza) → opcje →
/// podgląd zaznaczonej opcji → pole „Notatka" (tylko przy `notes`). Podgląd
/// i notatka stoją POD opcjami: zmiana wyboru nie przesuwa wierszy, w które człowiek właśnie tapie.
///
/// Szkic (zaznaczenia, pole) czyta z `QuestionDraftBook` wprost — pisanie i zaznaczanie nie
/// przebudowują transkryptu; etap, zdanie i treść karty przychodzą modelem.
///
/// Pod sufitem doku (`decisionDockCeiling`) karta ma układ zwarty: nagłówek
/// i zamknięcie stoją w ramce, sekcje między nimi przewijają się w karcie (`docked`). Bez sufitu jak w transkrypcie.
struct QuestionCardView: View {
  let card: QuestionCardModel
  let drafts: QuestionDraftBook
  let actions: QuestionCardActions
  @FocusState private var field: Field?
  @AccessibilityFocusState private var spoken: String?
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(\.decisionDockCeiling) private var dockCeiling
  /// Wysokość sekcji w doku zmierzona w karcie (0 = przed pomiarem); środek układu zwartego bierze najwyżej tyle.
  @State private var sectionsHeight: CGFloat = 0

  /// Odstęp nad i pod kartą; pod sufitem doku liczy się do wysokości karty.
  private static let outerPadding: CGFloat = 8

  var body: some View {
    let draft = drafts.draft(card.qId, sections: card.sections.count)
    Group {
      if let ceiling = dockCeiling {
        docked(draft, ceiling: ceiling)
      } else {
        VStack(alignment: .leading, spacing: 0) {
          header
          sections(draft)
          closing(draft)
        }
      }
    }
    .background(Color(uiColor: Palette.surface), in: .block)
    .clipShape(.block)
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .padding(.vertical, Self.outerPadding)
    .sensoryFeedback(.success, trigger: sentSummary)
    // Fokus klawiatury i cyfry obsługuje komórka transkryptu albo dok (`SessionViewController+KeysAnswers`).
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("card.question.\(card.qId)")
  }

  /// Sekcje pytań jedna pod drugą.
  @ViewBuilder
  private func sections(_ draft: QuestionDraft) -> some View {
    ForEach(card.sections) { section in
      sectionView(section, draft: draft)
        // Granica między pytaniami wyraźniejsza niż odstęp pytania od jego opcji.
        .padding(.top, section.index == 0 ? 0 : 18)
    }
  }

  /// Zamknięcie karty: zdania nad stopką (blokada, skutek wyjścia), stopka albo wiersz stanu, zdanie błędu.
  @ViewBuilder
  private func closing(_ draft: QuestionDraft) -> some View {
    if let locked = card.lockedReason { note(locked) }
    if card.exitLabel != nil { note(UICopy.questionExitNote) }
    footer(draft)
    if let error = card.error {
      Text(error)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.err))
        .lineLimit(dockedLines)
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("question.error")
    }
  }

  // MARK: - Układ zwarty w doku

  /// Karta pod sufitem doku (warunek 3 właściciela: wysoka karta nie zjada ekranu iPhone'a). Nagłówek u góry
  /// i zamknięcie u dołu stoją zawsze w ramce, sekcje (pytania, opcje, „Własna odpowiedź”, notatka) przewijają się
  /// między nimi; karta niższa od sufitu ma naturalną wysokość (`DockedCardLayout`). Sufit obejmuje odstęp nad i pod
  /// kartą.
  ///
  /// Struktura nie zależy od tego, czy treść się mieści: pole „Własna odpowiedź” zachowuje tożsamość, więc fokus
  /// (`@FocusState`) przetrwa kolejne rendery, a tekst i tak żyje w `QuestionDraftBook`. Pole z fokusem karta
  /// przewija do widoku, gdy fokus do niego wchodzi i gdy zmienia się jego tekst (pole rośnie do 6 linii).
  private func docked(_ draft: QuestionDraft, ceiling: CGFloat) -> some View {
    ScrollViewReader { proxy in
      DockedCardLayout(ceiling: max(0, ceiling - 2 * Self.outerPadding)) {
        header
          .dockPinned()
        ScrollView(.vertical) {
          VStack(alignment: .leading, spacing: 0) { sections(draft) }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { sectionsHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        // Przewinięcie karty nie zdejmuje klawiatury z pola, w którym człowiek pisze.
        .scrollDismissesKeyboard(.never)
        // Przed pomiarem środek bierze całe miejsce pod sufitem, po pomiarze najwyżej wysokość sekcji (jak
        // `CardDockColumn`): przewijany pojemnik nie podaje wysokości treści wiarygodnie.
        .frame(maxHeight: sectionsHeight == 0 ? .infinity : sectionsHeight)
        VStack(alignment: .leading, spacing: 0) { closing(draft) }
          .dockPinned()
      }
      .onChange(of: field) { _, focused in reveal(focused, proxy) }
      .onChange(of: typed(draft)) { reveal(field, proxy) }
    }
  }

  /// Tekst pola z fokusem (pusty bez fokusu): zmiana znaczy, że pole mogło urosnąć o linię.
  private func typed(_ draft: QuestionDraft) -> String {
    switch field {
    case let .custom(section)?: draft.customText(in: section)
    case let .note(section)?: draft.noteText(in: section)
    case nil: ""
    }
  }

  /// Przewija środek karty o tyle, ile trzeba, żeby pole stało całe w widoku. Po zmianie układu (nowe pole, nowa
  /// linia), więc w następnym obiegu.
  private func reveal(_ focused: Field?, _ proxy: ScrollViewProxy) {
    guard let focused else { return }
    Task { @MainActor in proxy.scrollTo(focused, anchor: nil) }
  }

  // MARK: - Nagłówek

  /// Jedna linia etykiety: „pytanie · nagłówek CLI" przy jednym pytaniu, „pytanie" przy formularzu. Długa
  /// etykieta ZAWIJA SIĘ w swojej kolumnie, a zegar stoi obok w stałej szerokości, więc nie ściska tekstu do
  /// wielokropka i na niego nie nachodzi; przy piśmie dostępności zegar schodzi pod etykietę (stos, jak karta
  /// zgody).
  private var header: some View {
    let layout = typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    return layout {
      Text(card.eyebrow)
        .eyebrow(Palette.wait)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let since = card.createdAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text(RelativeTime.short(since: since, now: context.date))
            .appFont(.footnote.monospaced())
            .monospacedDigit()
            .foregroundStyle(Color(uiColor: Palette.muted2))
        }
        .fixedSize()
        .layoutPriority(1)
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(card.spokenHeader)
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier("question.header")
  }

  // MARK: - Pytanie

  private func sectionView(_ section: QuestionCardModel.Section, draft: QuestionDraft) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      // Linia sekcji tylko w formularzu („pytanie 2/3 · nagłówek"); przy jednym pytaniu nagłówek stoi w etykiecie.
      if !section.head.isEmpty {
        Text(section.head)
          .appFont(.footnote.monospaced().weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.wait))
          .padding(.horizontal, 12)
          .padding(.bottom, 4)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
      }
      if let review = section.review {
        reviewList(review, section: section.index)
      } else {
        // Zdanie pytania zachowuje podziały wierszy — `Text` ich nie skleja.
        Text(section.question)
          .appFont(.body)
          .foregroundStyle(Color(uiColor: Palette.text))
          .padding(.horizontal, 12)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("question.text.\(section.index)")
      }
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(section.options.enumerated()), id: \.offset) { index, option in
          hairline
          optionRow(option, index: index, in: section, draft: draft)
        }
        if section.customAnswer {
          hairline
          customRow(section, draft: draft)
        }
      }
      .padding(.top, 8)
      if let option = previewOption(section, draft: draft), let preview = option.preview {
        OptionPreviewBlock(
          label: option.label, preview: preview,
          maxLines: CardBlockCeiling.lines(readable: true, regular: sizeClass == .regular),
          identifier: "question.preview.\(section.index)")
          .padding(.horizontal, 12)
          .padding(.top, 10)
      }
      if section.notes { noteField(section) }
      if card.instant, card.interactive {
        Text(UICopy.questionInstantHint)
          .appFont(.caption)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .padding(.horizontal, 12)
          .padding(.top, 6)
          .padding(.bottom, 4)
          .accessibilityHidden(true)
      }
    }
  }

  /// Opcja, której podgląd stoi pod opcjami (reguła w modelu): przy wyborze szkic, po odpowiedzi to,
  /// co poszło — karta nie zmienia wysokości w chwili tapnięcia „Odpowiedz".
  private func previewOption(_ section: QuestionCardModel.Section, draft: QuestionDraft) -> QuestionCardModel.Option? {
    guard section.hasPreview else { return nil }
    return section.previewOption(
      picked: chosen(section.index, draft: draft) ?? [],
      customActive: card.phase == .choose && draft.customActive(in: section.index))
  }

  // MARK: - Przegląd formularza

  /// Zdanie zamiast surowego ekranu przeglądu, pod nim pary pytanie → odpowiedzi. Każda odpowiedź
  /// w OSOBNEJ linii: etykieta z przecinkiem nie zlewa się z sąsiednią, a długa łamie się we
  /// własnym wierszu. Para jest jednym elementem dla czytnika („pytanie: odpowiedź, odpowiedź").
  private func reviewList(_ pairs: [ReviewPair], section: Int) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(UICopy.questionReviewTitle)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("question.text.\(section)")
      ForEach(Array(pairs.enumerated()), id: \.offset) { index, pair in
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: pair.question)
            .appFont(.footnote)
            .foregroundStyle(Color(uiColor: Palette.muted))
          if pair.answers.isEmpty {
            Text(UICopy.questionReviewNoAnswer)
              .appFont(.subheadline)
              .foregroundStyle(Color(uiColor: Palette.muted))
          }
          ForEach(Array(pair.answers.enumerated()), id: \.offset) { _, answer in
            Text(verbatim: answer)
              .appFont(.subheadline.weight(.semibold))
              .foregroundStyle(Color(uiColor: Palette.text))
          }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(UICopy.questionReviewSpoken(question: pair.question, answers: pair.answers))
        .accessibilityIdentifier("question.review.\(section).\(index)")
      }
    }
    .padding(.horizontal, 12)
  }

  /// Wartości, które karta pokazuje jako wybrane: szkic przy wyborze, wysłane po odpowiedzi.
  private func chosen(_ section: Int, draft: QuestionDraft) -> [String]? {
    switch card.phase {
    case .choose:
      return draft.picks.indices.contains(section) ? draft.picks[section] : []
    case let .sending(answered), let .sent(answered):
      return answered.answers.indices.contains(section) ? answered.answers[section] : nil
    }
  }

  private func optionRow(
    _ option: QuestionCardModel.Option, index: Int, in section: QuestionCardModel.Section, draft: QuestionDraft
  ) -> some View {
    let picked = chosen(section.index, draft: draft)?.contains(option.label) == true
    let tappable = card.interactive && option.selectable
    // Po odpowiedzi niewybrane wiersze gasną — przez chwilę to jedyne „to poszło" (`docs/design.md`, „States").
    let faded = card.phase != .choose && !picked && chosen(section.index, draft: draft) != nil
    return Button {
      actions.pick(card, section.index, option.label)
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        keyGlyph(option, picked: picked, multi: section.multiSelect)
        VStack(alignment: .leading, spacing: 2) {
          Text(option.label)
            .appFont(.subheadline.weight(.semibold))
            .foregroundStyle(Color(uiColor: option.selectable ? Palette.text : Palette.muted))
          if let description = option.description {
            Text(description)
              .appFont(.footnote)
              .foregroundStyle(Color(uiColor: Palette.muted))
          }
          if !option.selectable {
            Text(UICopy.questionTerminalOnly)
              .appFont(.footnote)
              .foregroundStyle(Color(uiColor: Palette.muted2))
          }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        if option.recommended {
          Text(UICopy.questionRecommended)
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: Palette.wait))
            .fixedSize()
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      // Tło zaznaczenia w jawnym prostokącie: tło bez kształtu wypełnia kształt kontenera, a karta
      // (`.background(_, in: .block)`) ustawia go na zaokrąglony — zaznaczenie miałoby rogi.
      .background(picked ? Color(uiColor: Palette.text).opacity(0.10) : .clear, in: Rectangle())
      .contentShape(Rectangle())
    }
    .buttonStyle(OptionRowStyle(enabled: tappable))
    .disabled(!tappable)
    .opacity(faded ? 0.4 : 1)
    .accessibilityLabel(option.label)
    .accessibilityValue(optionValue(option))
    .accessibilityHint(card.instant && tappable ? UICopy.questionInstantHint : "")
    // Stan zaznaczenia niesie cecha „wybrane"; cechy przełącznika nie ma, bo jego stan czytnik bierze
    // z wartości, a ta niesie opis opcji.
    .accessibilityAddTraits(picked ? .isSelected : [])
    .accessibilityFocused($spoken, equals: "s\(section.index)o\(index)")
    .accessibilityIdentifier("question.option.\(section.index).\(index)")
  }

  private func optionValue(_ option: QuestionCardModel.Option) -> String {
    UICopy.list(
      [option.description, option.recommended ? UICopy.questionRecommended : nil,
       option.selectable ? nil : UICopy.questionTerminalOnly].compactMap { $0 },
      .comma)
  }

  /// Kolumna klucza: cyfra, `❯` przy zaznaczeniu jednokrotnego wyboru, `[ ]`/`[x]` przy
  /// wielokrotnym, `–` przy opcji, której nie da się wybrać.
  private func keyGlyph(_ option: QuestionCardModel.Option, picked: Bool, multi: Bool) -> some View {
    let glyph: String
    if !option.selectable {
      glyph = option.key
    } else if multi {
      glyph = picked ? "[x]" : "[ ]"
    } else if picked, !card.instant || card.phase != .choose {
      glyph = "❯"
    } else {
      glyph = option.key
    }
    return Text(glyph)
      .appFont(.footnote.monospaced().weight(picked ? .semibold : .regular))
      .monospacedDigit()
      .foregroundStyle(Color(uiColor: picked ? Palette.wait : Palette.muted2))
      .frame(minWidth: 24, alignment: .leading)
      .fixedSize()
      .accessibilityHidden(true)
  }

  // MARK: - Własna odpowiedź

  @ViewBuilder
  private func customRow(_ section: QuestionCardModel.Section, draft: QuestionDraft) -> some View {
    let active = draft.customActive(in: section.index)
    Button {
      actions.openCustom(card, section.index)
      // Pole powstaje w tej samej zmianie — fokus dostaje w następnym obiegu.
      Task { @MainActor in field = .custom(section.index) }
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        // Klucz „…": wiersz niczego nie wysyła, rozwija pole; cyfry należą do opcji autora.
        Text(active ? "❯" : "…")
          .appFont(.footnote.monospaced().weight(active ? .semibold : .regular))
          .foregroundStyle(Color(uiColor: active ? Palette.wait : Palette.muted2))
          .frame(minWidth: 24, alignment: .leading)
          .accessibilityHidden(true)
        Text(UICopy.questionCustomLabel)
          .appFont(.subheadline.weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.muted))
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .background(active ? Color(uiColor: Palette.text).opacity(0.10) : .clear, in: Rectangle())
      .contentShape(Rectangle())
    }
    .buttonStyle(OptionRowStyle(enabled: card.interactive))
    .disabled(!card.interactive)
    .accessibilityAddTraits(active ? .isSelected : [])
    .accessibilityIdentifier("question.own.\(section.index)")
    if draft.isCustomOpen(in: section.index) || active {
      TextField(
        UICopy.questionCustomPlaceholder,
        text: Binding(
          get: { drafts.draft(card.qId, sections: card.sections.count).customText(in: section.index) },
          set: { actions.setCustom(card, section.index, $0) }
        ),
        axis: .vertical
      )
      .lineLimit(1...6)
      .appFont(.body)
      .focused($field, equals: .custom(section.index))
      // Cel przewinięcia karty w doku (`reveal`).
      .id(Field.custom(section.index))
      .disabled(!card.interactive)
      .padding(8)
      .background(Color(uiColor: Palette.codeBackground), in: .inner)
      // Wcięcie do kolumny treści: pole należy do swojego wiersza, nie do całej karty.
      .padding(.leading, 42)
      .padding(.trailing, 12)
      .padding(.vertical, 8)
      .accessibilityLabel(UICopy.questionCustomLabel)
      .accessibilityIdentifier("question.custom.\(section.index)")
    }
  }

  // MARK: - Notatka

  /// Pole notatki do wybranej opcji, pod podglądem. Etykieta „Notatka" stoi NAD polem (podpowiedź
  /// znika przy pisaniu, a pole bez etykiety nie mówi, czego dotyczy). Notatka nie jest odpowiedzią:
  /// nie zaznacza i nie odznacza opcji. Pole stoi zablokowane poza wyborem (wysyłka, karta
  /// zablokowana, potwierdzenie), a cyfry w nim to tekst — skróty karty milkną, gdy pole tekstowe
  /// ma klawiaturę (`typingInTextField`).
  private func noteField(_ section: QuestionCardModel.Section) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(UICopy.questionNoteLabel)
        .appFont(.footnote.weight(.semibold))
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityHidden(true)
      TextField(
        UICopy.questionNotePlaceholder,
        text: Binding(
          get: { drafts.draft(card.qId, sections: card.sections.count).noteText(in: section.index) },
          set: { actions.setNote(card, section.index, $0) }
        ),
        axis: .vertical
      )
      .lineLimit(2...8)
      .appFont(.body)
      .focused($field, equals: .note(section.index))
      .id(Field.note(section.index))
      .disabled(!card.interactive)
      .padding(8)
      .background(Color(uiColor: Palette.codeBackground), in: .inner)
      .accessibilityLabel(UICopy.questionNoteLabel)
      .accessibilityFocused($spoken, equals: "s\(section.index)note")
      .accessibilityIdentifier("question.note.\(section.index)")
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
  }

  // MARK: - Stopka i stan

  @ViewBuilder
  private func footer(_ draft: QuestionDraft) -> some View {
    switch card.phase {
    case let .sending(answered):
      statusRow(UICopy.questionSending(answered.summary))
    case let .sent(answered):
      statusRow(UICopy.questionSent(answered.summary))
    case .choose:
      if card.interactive, card.hasSubmit || card.exitLabel != nil {
        hairline
        HStack(spacing: 8) {
          if let exit = card.exitLabel {
            // Wyjście po LEWEJ, z DOSŁOWNĄ etykietą opcji; skutek mówi zdanie nad stopką.
            // Wyjście nie niesie notatek: notatka dotyczy wybranej opcji, a wyjście nią nie jest.
            Button(exit) { actions.send(card, [[exit]], nil) }
              .buttonStyle(QuietButtonStyle())
              .accessibilityHint(UICopy.questionExitNote)
              .accessibilityIdentifier("question.exit")
          }
          Spacer(minLength: 0)
          if card.hasSubmit {
            Button(UICopy.questionSubmit) { submit(draft) }
              .buttonStyle(FilledButtonStyle(
                fill: Color(uiColor: Palette.text), text: Color(uiColor: Palette.background), hover: .inkFill))
              .accessibilityIdentifier("question.submit")
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
      } else {
        // Karta bez stopki (tapnięcie wysyła) albo zablokowana — bez pustego paska.
        Spacer().frame(height: 10)
      }
    }
  }

  private func submit(_ draft: QuestionDraft) {
    switch card.submission(draft) {
    case let .send(answers, notes):
      actions.send(card, answers, notes)
    case let .missing(section, message):
      actions.missing(card, message)
      // Brakująca odpowiedź przenosi fokus czytnika na pierwszą opcję tego pytania.
      spoken = "s\(section)o0"
    case let .noteRejected(section, message):
      actions.missing(card, message)
      // Notatka, której nie da się wysłać: fokus czytnika na jej pole — tam albo w opcjach jest naprawa.
      spoken = "s\(section)note"
    case nil:
      break
    }
  }

  /// Wiersz stanu ZASTĘPUJE stopkę i ma jej wysokość — transkrypt nie skacze w chwili tapnięcia. W doku najwyżej
  /// trzy linie, ucięte w środku: długa „Własna odpowiedź” w zdaniu „Wysłano „…” → czekam na ekran” nie rozpycha
  /// karty ponad sufit, a początek i koniec zdania zostają; całość słyszy czytnik.
  private func statusRow(_ text: String) -> some View {
    VStack(spacing: 0) {
      hairline
      Text(text)
        .appFont(.footnote.monospaced())
        .foregroundStyle(Color(uiColor: Palette.muted))
        .lineLimit(dockedLines)
        .truncationMode(.middle)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .accessibilityIdentifier("question.status")
    }
  }

  private func note(_ text: String) -> some View {
    Text(text)
      .appFont(.footnote)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .lineLimit(dockedLines)
      .padding(.horizontal, 12)
      .padding(.top, 10)
      .padding(.bottom, 2)
      .fixedSize(horizontal: false, vertical: true)
  }

  /// Zdania zamknięcia w doku (stan, błąd, blokada): najwyżej trzy linie; w transkrypcie bez limitu.
  private var dockedLines: Int? { dockCeiling == nil ? nil : 3 }

  private var hairline: some View {
    Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1)
  }

  /// Pole tekstowe karty z fokusem klawiatury: „Własna odpowiedź" albo „Notatka" danego pytania.
  private enum Field: Hashable {
    case custom(Int)
    case note(Int)
  }

  /// Podpis odpowiedzi przyjętej przez serwer — wyzwala haptykę jeden raz.
  private var sentSummary: String? {
    if case let .sent(answered) = card.phase { answered.summary } else { nil }
  }
}

/// Układ zwarty karty pytania w doku: nagłówek, środek, zamknięcie. Nagłówek i zamknięcie mają naturalną wysokość;
/// środek (przewijany) dostaje swoją naturalną, ale najwyżej to, co z sufitu zostaje po nich. Sufit to `ceiling` albo
/// mniejsza wysokość od rodzica. Treść niższa od sufitu = karta naturalnej wysokości, bez pustego pasa. Części
/// przypięte razem wyższe od sufitu dzielą to, co zostaje po minimum środka (`DecisionDock.compactHeights`),
/// i przewijają się w swoim przydziale (`dockPinned`): karta nigdy nie wychodzi ponad sufit, a opcje, „Własna
/// odpowiedź” i przyciski zostają osiągalne.
private struct DockedCardLayout: Layout {
  let ceiling: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
    return CGSize(width: width, height: heights(subviews, width: proposal.width, limit: proposal.height).reduce(0, +))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for (subview, height) in zip(subviews, heights(subviews, width: bounds.width, limit: bounds.height)) {
      subview.place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: bounds.width, height: height))
      y += height
    }
  }

  private func heights(_ subviews: Subviews, width: CGFloat?, limit: CGFloat?) -> [CGFloat] {
    let ceiling = min(ceiling, limit ?? .infinity)
    var natural = subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)).height }
    // Środek: wysokość sekcji zmierzona w karcie (przed pomiarem cały sufit), nie wysokość pojemnika przy `nil`.
    if subviews.count == 3 {
      natural[1] = subviews[1].sizeThatFits(ProposedViewSize(width: width, height: ceiling)).height
    }
    // Przypięte części razem ponad sufitem (duże pismo, niski sufit): środek trzyma minimum, przypięte dzielą resztę.
    return DecisionDock.compactHeights(natural, ceiling: ceiling)
  }
}

/// Podgląd opcji pytania: podpis „Podgląd: „etykieta"", pod nim treść pismem stałej
/// szerokości BEZ zawijania (makieta i kod łamane przez kartę kłamią o układzie) — przewijana w obu
/// osiach, z sufitem w liniach jak plan na karcie zgody i wierszem „⌄ widzisz N z M linii", gdy
/// sufit faktycznie ucina. Dla czytnika blok jest jednym elementem z etykietą opcji.
private struct OptionPreviewBlock: View {
  let label: String
  let preview: String
  let maxLines: Int
  let identifier: String
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var height: CGFloat = 0

  var body: some View {
    // Linia z pisma w BIEŻĄCYM rozmiarze Dynamic Type — sufit rośnie razem z pismem.
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
    let size = Fonts.text(.footnote, traits: traits, category: TextSizeCategory(typeSize)).pointSize
    let font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    let ceiling = font.lineHeight * CGFloat(maxLines) + 16
    let total = preview.replacing(/\n$/, with: "").split(separator: "\n", omittingEmptySubsequences: false).count
    VStack(alignment: .leading, spacing: 6) {
      Text(UICopy.questionPreviewCaption(label))
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityHidden(true)
      ScrollView([.vertical, .horizontal]) {
        Text(verbatim: preview)
          .appFont(.footnote.monospaced())
          .foregroundStyle(Color(uiColor: Palette.text))
          .textSelection(.enabled)
          .fixedSize()
          .padding(8)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
      }
      // Inna opcja = blok od początku (przewinięcie poprzedniego podglądu nic tu nie znaczy).
      .id(label)
      .scrollIndicators(.visible)
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(height: height == 0 ? nil : min(height, ceiling))
      .commandBlock()
      .accessibilityLabel(UICopy.questionPreviewSpoken(label: label, preview: preview))
      .accessibilityIdentifier(identifier)
      if height > ceiling {
        Text(UICopy.commandClipped(shown: maxLines, total: max(total, maxLines)))
          .appFont(.caption.monospaced())
          .foregroundStyle(Color(uiColor: Palette.muted))
      }
    }
  }
}

/// Wiersz opcji: reakcją na dotyk jest tło (nigdy skala); wiersz bez gestu nie reaguje wcale.
///
/// Every row background (touch, selection, pointer) is a rectangle over the whole row, like the selection in the
/// PWA: a picked answer has no rounded corners. A background without a shape would take the container's rounded
/// shape from the card. Guarded by `QuestionUITests.testPickedOptionHasSquareCorners`.
///
/// The pointer draws the row's OWN background (`.onHover`), without the system `.hoverEffect`: on iPad the cursor
/// over an option highlights the card's header instead of the row (likely cause: the effect in a subtree with
/// `clipShape` in a `UIHostingConfiguration` cell takes its position from the card's start). The own background
/// does not depend on that cause.
private struct OptionRowStyle: ButtonStyle {
  let enabled: Bool

  func makeBody(configuration: Configuration) -> some View {
    OptionRowBody(configuration: configuration, enabled: enabled)
  }
}

/// Treść stylu wiersza opcji ze stanem wskaźnika (`RarogHoverReader`, wspólny dla wszystkiego, co się klika).
private struct OptionRowBody: View {
  let configuration: ButtonStyleConfiguration
  let enabled: Bool

  var body: some View {
    RarogHoverReader(enabled: enabled) { hovering in
      let lit = enabled && (configuration.isPressed || hovering)
      configuration.label
        .background(lit ? Color(uiColor: Palette.text).opacity(HoverTokens.wash) : .clear, in: Rectangle())
    }
  }
}

/// Przycisk tekstowy stopki: ucieczka od decyzji, nigdy akcja główna. Pod wskaźnikiem i palcem jak `.btn--text:hover`
/// w PWA: pełny tekst i delikatne wypełnienie.
private struct QuietButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    RarogHoverReader { hovered in
      let lit = configuration.isPressed || hovered
      configuration.label
        .appFont(.subheadline.weight(.medium))
        .foregroundStyle(Color(uiColor: lit ? Palette.text : Palette.muted))
        .multilineTextAlignment(.leading)
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .background(lit ? Color(uiColor: Palette.text).opacity(HoverTokens.wash) : .clear, in: .capsule)
        .contentShape(.rect)
    }
  }
}
#endif
