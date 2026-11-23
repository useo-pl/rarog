#if os(iOS)
import RarogCore
import SwiftUI

/// The Dictation screen: the options with their description (which carries the consent), a choose button for each,
/// and the link to the dictation part of the privacy policy. Ta sama na arkuszu z mikrofonu pola wiadomości (`DictationSheet`), na stronie w notatce i w Ustawieniach
/// (`SettingsSheet`); tytuł daje prezentacja. Treść czyta stan serwera przy każdym rysowaniu
/// (`DictationChoiceModel.screen`), więc sonda wersji przy otwartym ekranie zmienia opcję Soniox na żywo.
/// The Settings page alone ends with the dictation keyboard shortcut section (`DictationPresentation.showsShortcut`).
/// Soniox unavailable: the neutral state line, then the setup steps and the Soniox console link
/// (`ServerSetupStepsView`).
struct DictationChoiceView: View {
  let model: DictationChoiceModel
  let presentation: DictationPresentation
  /// Po zapisie wyboru: arkusz się zamyka, strona w notatce wraca do notatki. W Ustawieniach `nil`: strona zostaje
  /// i pokazuje nowy wybór. Nagrywania wybór nie zaczyna nigdzie.
  var onChosen: ((DictationChoice) -> Void)?

  var body: some View {
    let screen = model.screen()
    Form {
      if presentation.showsLead {
        Section {
          Text(screen.lead)
            .appFont(.callout)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("dictation.lead")
        }
      }
      ForEach(screen.options) { option in
        optionSection(option)
      }
      Section {
        Link(destination: screen.privacyURL) {
          HStack {
            Text(screen.privacyLabel).foregroundStyle(Color(uiColor: Palette.text))
            Spacer(minLength: 8)
            Image(systemName: "arrow.up.right")
              .appFont(.footnote)
              .foregroundStyle(Color(uiColor: Palette.muted))
              .accessibilityHidden(true)
          }
          .contentShape(Rectangle())
        }
        .accessibilityIdentifier("dictation.privacy")
      }
      if presentation.showsShortcut {
        ShortcutPageSection(shortcut: .dictation)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
    .accessibilityIdentifier(presentation.identifier)
  }

  private func optionSection(_ option: DictationOptionContent) -> some View {
    let id = option.choice.rawValue
    return Section {
      VStack(alignment: .leading, spacing: 6) {
        Text(option.title)
          .appFont(.headline)
          .foregroundStyle(Color(uiColor: Palette.text))
          .accessibilityAddTraits(.isHeader)
        Text(option.summary)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
      }
      .fixedSize(horizontal: false, vertical: true)
      .padding(.vertical, 4)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("dictation.option.\(id)")
      if let state = option.state {
        HStack(spacing: 8) {
          if option.choice == .soniox, model.sonioxOption == .checking { ProgressView() }
          Text(state).foregroundStyle(Color(uiColor: Palette.wait))
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("dictation.\(id).state")
      }
      if let setup = option.setup {
        ServerSetupStepsView(setup: setup, identifier: "dictation.\(id).setup")
      }
      Button {
        if model.choose(option.choice) { onChosen?(option.choice) }
      } label: {
        HStack(spacing: 8) {
          if option.selected {
            Image(systemName: "checkmark").accessibilityHidden(true)
          }
          Text(option.button)
        }
      }
      .disabled(!option.enabled)
      .accessibilityAddTraits(option.selected ? .isSelected : [])
      .accessibilityIdentifier("dictation.choose.\(id)")
    }
  }
}
#endif
