import CoreGraphics
import Foundation

// Pasek klawiszy terminala: klawisze, których klawiatura ekranowa nie ma,
// a bez których nie wyjdzie się z vima. Pad
// przy prawym skraju, Historia na nim; pasek stoi WYŁĄCZNIE bez klawiatury sprzętowej (z Magic Keyboard
// Kopiuj/Wklej/Historia są pod Cmd+C/V/Y i w menu „⋯" paska nawigacji). Modyfikatory są jednorazowe: tap uzbraja,
// drugi rozbraja, a pierwszy wysłany fragment rozbraja oba. Część bez UIKit (skład, bajty, modyfikatory,
// metryka) testuje się na macOS (`TerminalKeyBarTests`). Właściciel: terminal.
//
// Treść terminala nie trafia tu nigdzie poza wywołującym: pasek nie loguje i nie zapisuje.

/// Klawisz paska. Kolejność jest stała i celowa: wyjścia z lewej, schowek w środku, pad strzałek przy prawym skraju
/// (pod kciukiem; w PWA stoi przed schowkiem), Historia na samym końcu — palec uczy się POZYCJI,
/// nie rysunku.
public enum TerminalBarKey: String, CaseIterable, Sendable {
  case esc, tab, ctrl, cmd, copy, paste, pad, history

  /// Bajty klawisza, który sam coś wysyła; `nil` = modyfikator albo akcja.
  public var bytes: String? {
    switch self {
    case .esc: "\u{1B}"
    case .tab: "\t"
    case .ctrl, .cmd, .pad, .copy, .paste, .history: nil
    }
  }

  /// Ctrl i Cmd nic nie wysyłają — uzbrajają następny klawisz.
  public var isModifier: Bool { self == .ctrl || self == .cmd }

  /// Etykieta dla czytnika ekranu (ikona na pasku nie mówi nic).
  public var label: String {
    switch self {
    case .esc: UICopy.terminalKeyEsc
    case .tab: UICopy.terminalKeyTab
    case .ctrl: UICopy.terminalKeyCtrl
    case .cmd: UICopy.terminalKeyCmd
    case .pad: UICopy.terminalKeyPad
    case .copy: UICopy.terminalCopy
    case .paste: UICopy.terminalPaste
    case .history: UICopy.terminalSelectOutput
    }
  }

  public var hint: String? {
    switch self {
    case .esc, .tab: nil
    case .ctrl: UICopy.terminalKeyCtrlHint
    case .cmd: UICopy.terminalKeyCmdHint
    case .pad: UICopy.terminalKeyPadHint
    case .copy: UICopy.terminalCopyHint
    case .paste: UICopy.terminalPasteHint
    case .history: UICopy.terminalHistoryHint
    }
  }

  /// Ikona SF Symbols (glify z klawiatury Apple).
  public var symbol: String {
    switch self {
    case .esc: "escape"
    case .tab: "arrow.right.to.line"
    case .ctrl: "control"
    case .cmd: "command"
    case .pad: "dpad"
    case .copy: "doc.on.doc"
    case .paste: "doc.on.clipboard"
    case .history: "selection.pin.in.out"
    }
  }
}

/// Bajty modyfikatorów paska — lustro `ctrlChunk` i `metaChunk` z PWA (wektory w `TerminalKeyBarTests`).
public enum TerminalControlBytes {
  /// Znak po Ctrl → znak sterujący (`c` → 0x03): klasyczne C0 dla liter i `@[\]^_`, spacja → NUL, `?` → DEL.
  /// Kombinacja, której nie ma (strzałka, wklejka, litera narodowa), wraca BEZ ZMIAN — udawany bajt sterujący
  /// zrobiłby w vimie coś, o co nikt nie prosił.
  public static func control(_ chunk: String) -> String {
    let scalars = chunk.unicodeScalars
    guard scalars.count == 1, let scalar = scalars.first else { return chunk }
    let value = scalar.value
    switch value {
    case 0x61...0x7A: return String(UnicodeScalar(UInt8(value - 0x60)))  // a–z
    case 0x40...0x5F: return String(UnicodeScalar(UInt8(value - 0x40)))  // @, A–Z, [ \ ] ^ _
    case 0x20: return "\u{00}"  // Ctrl+Spacja = NUL
    case 0x3F: return "\u{7F}"  // Ctrl+? = DEL
    default: return chunk
    }
  }

  /// Znak po Cmd → prefiks Meta (ESC + znak), konwencja „Option as Meta"; działa też na bajcie z Ctrl
  /// (ESC+C-x = M-C-x). Wejście dłuższe niż jeden znak (wklejka, dyktowanie) wraca bez zmian.
  public static func meta(_ chunk: String) -> String {
    chunk.unicodeScalars.count == 1 ? "\u{1B}" + chunk : chunk
  }
}

/// Uzbrojone modyfikatory paska: jednorazowe, bez blokady i bez przytrzymania (PWA `sendInput`).
public struct TerminalModifiers: Sendable, Equatable {
  public private(set) var ctrl = false
  public private(set) var cmd = false

  public init() {}

  public var isArmed: Bool { ctrl || cmd }

  /// Tap w Ctrl albo Cmd: uzbraja, drugi tap rozbraja. Zwraca stan po zmianie.
  @discardableResult
  public mutating func toggle(_ key: TerminalBarKey) -> Bool {
    switch key {
    case .ctrl:
      ctrl.toggle()
      return ctrl
    case .cmd:
      cmd.toggle()
      return cmd
    default:
      return false
    }
  }

  /// Fragment wejścia z uzbrojonymi modyfikatorami: najpierw C0 z Ctrl, potem ESC-prefiks z Cmd (odwrotnie
  /// Ctrl zjadłby ESC). Pierwszy fragment rozbraja oba — także taki, na który modyfikator nie działa.
  public mutating func apply(_ chunk: String) -> String {
    guard isArmed else { return chunk }
    var data = ctrl ? TerminalControlBytes.control(chunk) : chunk
    if cmd { data = TerminalControlBytes.meta(data) }
    disarm()
    return data
  }

  /// Wklejka to nie klawisz: gasi modyfikatory, zanim poleci (jednoznakowy schowek nie stanie się bajtem
  /// sterującym).
  public mutating func disarm() {
    ctrl = false
    cmd = false
  }
}

/// Metryka paska: osiem celów po co najmniej 44 pt w jednym rzędzie, BEZ przewijania — także na najwęższym
/// iPhonie. Klawisz RYSUJE się mniejszy niż jego
/// cel dotyku: tło wcięte o `keyInsetY` i `keyInsetX`, cel 44 pt.
public enum TerminalKeyBarMetrics {
  public static let target: CGFloat = 44
  public static let spacing: CGFloat = 2
  public static let inset: CGFloat = 2
  /// Wcięcie tła klawisza w jego celu dotyku (góra i dół, boki): widoczny klawisz ma 36 pt wysokości.
  public static let keyInsetY: CGFloat = 4
  public static let keyInsetX: CGFloat = 2
  /// Najwęższy telefon z iOS 26 (iPhone SE 2./3. generacji) — 375 pt.
  public static let narrowestPhone: CGFloat = 375

  /// Szerokość, której pasek potrzebuje minimalnie.
  public static var minimumWidth: CGFloat {
    let count = CGFloat(TerminalBarKey.allCases.count)
    return count * target + (count - 1) * spacing + 2 * inset
  }
}

#if os(iOS)
import UIKit

/// Pasek klawiszy na dole ekranu terminala (nad klawiaturą ekranową przez `keyboardLayoutGuide` — to robi
/// ekran). Klawisze wysyłające i akcje idą do `onKey`, pad do `onArrow`; „Wklej" to `UIPasteControl`
/// (wklejka bez systemowego pytania o zgodę, zmierzone), którego celem jest powierzchnia terminala.
/// Tło paska = tło terminala: pasek czyta się jako część ekranu, nie osobna belka.
/// „Wklej" to wyjątek od celu 44 pt: `UIPasteControl` rysuje tło na całej swojej powierzchni
/// i przyjmuje dotyk tylko na niej, więc jej cel to widoczny klawisz (``TerminalPasteKeyCell``).
final class TerminalKeyBar: UIView {
  var onKey: ((TerminalBarKey) -> Void)?
  var onArrow: ((PadDirection) -> Void)? {
    get { pad.onArrow }
    set { pad.onArrow = newValue }
  }

  private let stack = UIStackView()
  private var buttons: [TerminalBarKey: UIButton] = [:]
  /// Podpowiedź „Historia (⌘Y)” po najechaniu kursorem: ten sam skrót działa z klawiatury sprzętowej.
  private var historyTip: ShortcutTipTracker?
  let pad = TerminalArrowPadView()
  let pasteControl: UIPasteControl

  /// - Parameter pasteTarget: odbiorca wklejki z `UIPasteControl` (powierzchnia terminala).
  init(pasteTarget: (any UIPasteConfigurationSupporting)?) {
    let configuration = UIPasteControl.Configuration()
    configuration.displayMode = .iconOnly
    configuration.roundCorners(Radius.inner)
    // Tło nieprzezroczyste jak u klawiszy: przezroczystego system nie przyjmuje i rysuje czarne (na iPhonie
    // czarny kwadrat na całym celu 44 pt, przy pustym schowku przygaszony).
    configuration.baseBackgroundColor = Palette.surface2
    configuration.baseForegroundColor = Palette.text
    pasteControl = UIPasteControl(configuration: configuration)
    pasteControl.target = pasteTarget
    super.init(frame: .zero)
    build()
    // A step on the flat path, where no trait change comes: the key glyphs take the new size.
    Fonts.follow(self) { [weak self] in
      guard let self else { return }
      for button in self.buttons.values {
        button.configuration?.preferredSymbolConfigurationForImage = TerminalKeyBar.symbolConfiguration
      }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

  private func build() {
    backgroundColor = Palette.background
    accessibilityIdentifier = "terminal.keyBar"
    isAccessibilityElement = false
    accessibilityLabel = UICopy.terminalKeyBar
    stack.axis = .horizontal
    stack.distribution = .fillEqually
    stack.spacing = TerminalKeyBarMetrics.spacing
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: topAnchor, constant: TerminalKeyBarMetrics.inset),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -TerminalKeyBarMetrics.inset),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: TerminalKeyBarMetrics.inset),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -TerminalKeyBarMetrics.inset),
      stack.heightAnchor.constraint(greaterThanOrEqualToConstant: TerminalKeyBarMetrics.target),
    ])
    for key in TerminalBarKey.allCases {
      let item: UIView
      switch key {
      case .pad:
        pad.accessibilityIdentifier = "terminal.key.pad"
        item = pad
      case .paste:
        pasteControl.accessibilityIdentifier = "terminal.key.paste"
        pasteControl.accessibilityLabel = key.label
        pasteControl.accessibilityHint = key.hint
        item = TerminalPasteKeyCell(control: pasteControl, insets: Self.keyInsets)
      default:
        let button = makeButton(key)
        buttons[key] = button
        if key == .history {
          historyTip = ShortcutTipTracker(view: button, line: ShortcutTipLine(UICopy.terminalSelectOutput, .terminalHistory))
        }
        item = button
      }
      item.widthAnchor.constraint(greaterThanOrEqualToConstant: TerminalKeyBarMetrics.target).isActive = true
      stack.addArrangedSubview(item)
    }
  }

  private func makeButton(_ key: TerminalBarKey) -> UIButton {
    var configuration = UIButton.Configuration.filled()
    configuration.image = UIImage(systemName: key.symbol)
    configuration.preferredSymbolConfigurationForImage = TerminalKeyBar.symbolConfiguration
    configuration.baseBackgroundColor = Palette.surface2
    configuration.baseForegroundColor = Palette.text
    configuration.cornerStyle = .fixed
    configuration.background.roundCorners(Radius.inner)
    configuration.background.backgroundInsets = TerminalKeyBar.keyInsets
    let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
      self?.onKey?(key)
    })
    button.accessibilityIdentifier = "terminal.key.\(key.rawValue)"
    button.accessibilityLabel = key.label
    button.accessibilityHint = key.hint
    return button
  }

  /// Stan modyfikatorów: odwrócone kolory (PWA `aria-pressed`) i „uzbrojony" dla czytnika.
  func show(_ modifiers: TerminalModifiers) {
    for (key, armed) in [(TerminalBarKey.ctrl, modifiers.ctrl), (.cmd, modifiers.cmd)] {
      guard let button = buttons[key] else { continue }
      var configuration = button.configuration
      configuration?.baseBackgroundColor = armed ? Palette.text : Palette.surface2
      configuration?.baseForegroundColor = armed ? Palette.background : Palette.text
      button.configuration = configuration
      button.isSelected = armed
      button.accessibilityTraits = armed ? [.button, .selected] : .button
      button.accessibilityValue = armed ? UICopy.terminalKeyArmed : nil
    }
  }

  /// Historia bez punktu wpięcia (ekran bez `onHistory`) jest wygaszona — nigdy martwy przycisk.
  func setHistoryEnabled(_ enabled: Bool) {
    buttons[.history]?.isEnabled = enabled
  }

  func button(_ key: TerminalBarKey) -> UIButton? { buttons[key] }

  /// Glif klawisza: o stopień mniejszy niż tekst (`subheadline`), jak ikony paska nawigacji. On the flat path the
  /// style's font at the model's size, read again after a step.
  static var symbolConfiguration: UIImage.SymbolConfiguration {
    TextStyleScaling.isFlat
      ? UIImage.SymbolConfiguration(font: Fonts.text(.subheadline))
      : UIImage.SymbolConfiguration(textStyle: .subheadline)
  }

  static let keyInsets = NSDirectionalEdgeInsets(
    top: TerminalKeyBarMetrics.keyInsetY, leading: TerminalKeyBarMetrics.keyInsetX,
    bottom: TerminalKeyBarMetrics.keyInsetY, trailing: TerminalKeyBarMetrics.keyInsetX)
}

/// Komórka paska z „Wklej" wielkości widocznego klawisza (wcięcie jak u przycisków). Kontrolka na całej komórce
/// z przezroczystym tłem rysuje się na czarno (system podmienia przezroczyste tło na iPhonie),
/// a tapu z marginesu przekazanego przez `hitTest` system nie przyjmuje (zmierzone w XCUITest). Dlatego
/// wygląd jak inne klawisze, cel „Wklej" = klawisz 36 pt zamiast 44 pt.
final class TerminalPasteKeyCell: UIView {
  let control: UIView

  init(control: UIView, insets: NSDirectionalEdgeInsets) {
    self.control = control
    super.init(frame: .zero)
    control.translatesAutoresizingMaskIntoConstraints = false
    addSubview(control)
    NSLayoutConstraint.activate([
      control.topAnchor.constraint(equalTo: topAnchor, constant: insets.top),
      control.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -insets.bottom),
      control.leadingAnchor.constraint(equalTo: leadingAnchor, constant: insets.leading),
      control.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -insets.trailing),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }
}
#endif
