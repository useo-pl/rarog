#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Start section of the "New Session" sheet: mode switch, model and effort menus, the mode
// sentence and the ultracode switch, with the bindings that keep effort in step with the model; folded to the
// settings summary while the directory browser is open. Owner: session control.

extension NewSessionSheet {
  // MARK: - Start

  /// Przełącznik i oba menu w jednej linii: szeroki arkusz (iPad) i pismo do xLarge. Wybór jawny, nie
  /// `ViewThatFits`: przełączanie układu w trakcie audytu dostępności przesuwało wszystko pod nim.
  static let oneLineStartWidth: CGFloat = 520

  private var oneLineStart: Bool {
    sheetSize.width >= Self.oneLineStartWidth && typeSize <= .xLarge
  }

  var startSection: some View {
    Section {
      if browser.browsing {
        foldedStart
      } else {
        // One form row: the controls and the mode sentence with no separator between them.
        VStack(alignment: .leading, spacing: 10) {
          if typeSize.isAccessibilitySize {
            // Segments do not fit at accessibility sizes: the mode is a menu. Short names, because the system menu
            // cut long ones in the middle ("Auto: bez…omyślnie)", AX5 frame); the mode description stands below.
            Picker(UICopy.modeLabel, selection: $settings.mode) {
              ForEach(StartMode.segmentOrder) { mode in Text(UICopy.startModeShort(mode)).tag(mode) }
            }
            .accessibilityIdentifier("newSession.mode")
            menus
          } else if oneLineStart {
            HStack(spacing: 8) {
              modePicker.fixedSize()
              Spacer(minLength: 8)
              modelMenu
              effortMenu
            }
          } else {
            modePicker
            menus
          }
          Text(UICopy.startModeHint(settings.mode))
            .appFont(.footnote)
            .foregroundStyle(Color(uiColor: settings.mode == .auto ? Palette.wait : Palette.muted))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("newSession.modeHint")
        }
        if StartModel.ultracodeAvailable(options, model: settings.model) { ultracodeRow }
      }
    } header: {
      Text(UICopy.startLabel).foregroundStyle(Color(uiColor: Palette.muted))
    }
  }

  /// While the browser is open, Start folds to the summary (mockup A): the directory list stays above the fold, and
  /// the auto mode word stands in amber as in the footer.
  private var foldedStart: some View {
    let mode = UICopy.startModeShort(settings.mode)
    let rest = settings.summary.dropFirst(mode.count)
    return HStack(alignment: .firstTextBaseline, spacing: 12) {
      (Text(mode).foregroundStyle(Color(uiColor: settings.mode == .auto ? Palette.wait : Palette.muted))
        + Text(String(rest)).foregroundStyle(Color(uiColor: Palette.muted)))
        .appFont(.subheadline)
        .accessibilityLabel(settings.summary)
      Spacer(minLength: 8)
      Text(UICopy.startAfterChoice)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("newSession.startFolded")
  }

  /// Ultracode w osobnym wierszu POD trybem, modelem i effortem: układ jednoliniowy rzędu zostaje, a zdanie
  /// o koszcie stoi przy przełączniku. Wiersza nie ma przy modelu bez tej możliwości (model konta, Haiku, serwer,
  /// który jej nie ogłasza). Zdanie tylko przy włączonym: trzy linie przy
  /// wyłączonym spychały na iPadzie „Rozmowy” pod zgięcie arkusza. Bez animacji, jak reszta formularza.
  private var ultracodeRow: some View {
    VStack(alignment: .leading, spacing: 6) {
      Toggle(UICopy.ultracodeLabel, isOn: ultracodeBinding)
        .accessibilityIdentifier("newSession.ultracode")
      if settings.ultracode {
        Text(UICopy.ultracodeStartNote)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("newSession.ultracodeNote")
      }
    }
  }

  private var menus: some View {
    HStack(spacing: 8) {
      modelMenu
      effortMenu
      Spacer(minLength: 0)
    }
  }

  private var modePicker: some View {
    Picker(UICopy.modeLabel, selection: $settings.mode) {
      ForEach(StartMode.segmentOrder) { mode in Text(UICopy.startModeShort(mode)).tag(mode) }
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .accessibilityLabel(UICopy.modeLabel)
    .accessibilityIdentifier("newSession.mode")
  }

  private var modelMenu: some View {
    Menu {
      Picker(UICopy.modelLabel, selection: modelBinding) {
        ForEach(options, id: \.value) { choice in Text(choice.label).tag(choice.value) }
      }
    } label: {
      MenuPill(text: settings.model == StartModel.accountDefault ? UICopy.modelAccountShort : settings.modelLabel)
    }
    .accessibilityLabel("\(UICopy.modelLabel): \(settings.model == StartModel.accountDefault ? UICopy.modelAccountDefault : settings.modelLabel)")
    .accessibilityIdentifier("newSession.model")
  }

  /// Przy włączonym ultracode menu stoi na xhigh i jest wygaszone: flaga startu ustawia ten poziom.
  private var effortMenu: some View {
    let levels = StartModel.effortLevels(options, model: settings.model)
    let current = settings.launchEffort?.rawValue ?? UICopy.effortAutoShort
    return Menu {
      Picker(UICopy.effortLabel, selection: effortBinding) {
        Text(UICopy.effortAuto).tag(EffortLevel?.none)
        ForEach(levels, id: \.self) { level in Text(level.rawValue).tag(EffortLevel?.some(level)) }
      }
    } label: {
      MenuPill(text: current)
    }
    .disabled(levels.isEmpty || settings.ultracode)
    .accessibilityLabel("\(UICopy.effortLabel): \(settings.launchEffort?.rawValue ?? UICopy.effortAuto)")
    .accessibilityIdentifier("newSession.effort")
  }

  var options: [ModelChoice] { StartModel.options(choices) }

  private var modelBinding: Binding<String> {
    Binding(
      get: { settings.model },
      set: { model in
        chosenModel = model
        settings.model = model
        settings.modelLabel = options.first { $0.value == model }?.label ?? model
        syncEffort()
      })
  }

  private var effortBinding: Binding<EffortLevel?> {
    Binding(
      get: { settings.launchEffort },
      set: { effort in
        settings.effort = effort
        chosenEffort = .some(effort)
      })
  }

  /// Przełącznik ultracode: stan nie trafia do pamięci urządzenia, więc każde otwarcie okna startuje wyłączony.
  private var ultracodeBinding: Binding<Bool> {
    Binding(
      get: { settings.ultracode },
      set: { on in settings.setUltracode(on, choices: options) })
  }

  /// Effort idzie za modelem według ``StartModel/resolveEffort(_:saved:chosen:)``. Ultracode znika razem
  /// z wyborem, gdy nowy model (albo odświeżona lista) go nie ma.
  func syncEffort() {
    let levels = StartModel.effortLevels(options, model: settings.model)
    settings.effort = StartModel.resolveEffort(levels, saved: savedDefaults, chosen: chosenEffort)
    settings.syncUltracode(choices: options)
  }
}
#endif
