#if DEBUG
import GameController
import UIKit

// Sonda testów UI — WYŁĄCZNIE build Debug i zmienna `RAROG_UI_TEST_PROBE=1`
// (`WindowsUITests`). Symulator nie podaje apce klawisza Esc, a XCUITest nie widzi, kto trzyma klawiaturę,
// więc reguł zamykania prezentacji nie dało się sprawdzić poza iPadem. Sonda stawia nad apką przezroczyste okno
// z trzema przyciskami i etykietą stanu:
//   `probe.inspect` — zapisuje do `probe.state`, kto jest pierwszym respondentem, jaki ma łańcuch, co stoi
//     nad korzeniem (prezentacje) i czy system zgłasza klawiaturę sprzętową (`kb`);
//   `probe.escape`  — szuka w łańcuchu pierwszego respondenta polecenia klawisza Esc bez modyfikatorów
//     (`UIKeyCommand`) i wykonuje je tak, jak zrobiłaby to klawiatura; bez pierwszego respondenta zaczyna od
//     najwyżej prezentowanego kontrolera (`start=top`);
//   `probe.corners` — mierzy promień rogu górnej prezentacji z API systemu (`effectiveRadius(corner:)`);
//   `probe.axescape` / `probe.axescapebar` — gest „wstecz” czytnika (VoiceOver) bez VoiceOver: od pierwszego
//     elementu dostępności z etykietą w treści (albo w pasku nawigacji) górnej prezentacji w górę — kontenery
//     dostępności, potem łańcuch respondentów (widok → kontroler → widok nad nim) — aż ktoś go weźmie.
// Do stanu trafiają wyłącznie nazwy klas i liczby układu — żadnej treści ekranu. Okno sondy nie zostaje oknem
// kluczowym i przepuszcza dotyk poza swoimi przyciskami.

@MainActor
enum UITestProbe {
  static let environmentKey = "RAROG_UI_TEST_PROBE"
  private static var window: ProbeWindow?
  private static var observer: NSObjectProtocol?

  static func installIfAsked(environment: [String: String] = ProcessInfo.processInfo.environment) {
    guard environment[environmentKey] == "1", observer == nil else { return }
    observer = NotificationCenter.default.addObserver(
      forName: UIScene.didActivateNotification, object: nil, queue: .main
    ) { note in
      let scene = note.object as? UIWindowScene
      MainActor.assumeIsolated { attach(scene) }
    }
  }

  private static func attach(_ scene: UIWindowScene?) {
    guard let scene, window == nil else { return }
    let probe = ProbeWindow(windowScene: scene)
    probe.windowLevel = .alert + 1
    probe.backgroundColor = .clear
    probe.rootViewController = ProbeController()
    probe.isHidden = false
    window = probe
  }

  // MARK: - Pomiary

  /// Okno apki (nie sondy) tej sceny.
  static func appWindow() -> UIWindow? {
    window?.windowScene?.windows.first { !($0 is ProbeWindow) && !$0.isHidden }
  }

  /// Pierwszy respondent okna kluczowego; `nil`, gdy akcja doszła do okna albo apki (nikt jej nie wziął).
  static func firstResponder() -> UIResponder? {
    UIResponder.probeCaptured = nil
    UIApplication.shared.sendAction(#selector(UIResponder.rarogProbeCapture(_:)), to: nil, from: nil, for: nil)
    guard let captured = UIResponder.probeCaptured, !(captured is UIWindow), !(captured is UIApplication),
      !(captured is UIWindowScene)
    else { return nil }
    return captured
  }

  /// Kontrolery prezentowane nad korzeniem, od dołu do góry.
  static func presented() -> [UIViewController] {
    var list: [UIViewController] = []
    var top = appWindow()?.rootViewController?.presentedViewController
    while let controller = top {
      list.append(controller)
      top = controller.presentedViewController
    }
    return list
  }

  static func name(_ object: AnyObject) -> String {
    // Typy generyczne SwiftUI mają bardzo długie nazwy: do pierwszego nawiasu wystarczy.
    String(String(describing: type(of: object)).prefix { $0 != "<" })
  }

  static func inspect() -> String {
    let first = firstResponder()
    var chain: [String] = []
    var responder = first
    while let current = responder, chain.count < 14 {
      chain.append(name(current))
      responder = current.next
    }
    let stack = presented().map { controller in
      let style = controller.modalPresentationStyle == .popover ? "popover" : "sheet"
      return "\(name(controller)):\(style)\(controller.isBeingDismissed ? ":schodzi" : "")"
    }
    // `kb`: czy system zgłasza klawiaturę sprzętową. Symulator zgłasza ją raz tak, raz nie,
    // a od niej zależy, czy pole wiadomości bierze klawiaturę samo po wejściu na ekran.
    let keyboard = GCKeyboard.coalesced != nil
    return "fr=\(first.map(name) ?? "nil"); chain=\(chain.joined(separator: ">")); "
      + "presented=[\(stack.joined(separator: ","))]; kb=\(keyboard)"
  }

  /// Najgłębszy kontroler pod `controller`: wierzch stosu nawigacji albo ostatnie dziecko. Przybliża prywatną
  /// regułę UIKit dla klawiszy bez pierwszego respondenta (start od najgłębszego prezentowanego kontrolera).
  static func deepest(_ controller: UIViewController) -> UIViewController {
    if let navigation = controller as? UINavigationController, let top = navigation.topViewController {
      return deepest(top)
    }
    if let child = controller.children.last { return deepest(child) }
    return controller
  }

  /// Wykonuje polecenie Esc z łańcucha respondentów; wynik mówi, kto je miał i kto jeszcze ma je wyżej.
  static func escape() -> String {
    var start = "fr"
    var responder: UIResponder? = firstResponder()
    if responder == nil, let top = presented().last ?? appWindow()?.rootViewController {
      let controller = deepest(top)
      start = "top:\(name(controller))"
      responder = controller
    }
    // Wszystkie polecenia Esc w łańcuchu, w kolejności od startu. Polecenie wygaszone (`canPerformAction` mówi
    // „nie", więc `target(forAction:)` oddaje `nil`) nie kończy szukania: klawiatura wzięłaby następne.
    var holders: [(responder: UIResponder, command: UIKeyCommand)] = []
    var steps = 0
    while let current = responder, steps < 60 {
      for command in current.keyCommands ?? []
      where command.input == UIKeyCommand.inputEscape && command.modifierFlags.isEmpty && command.action != nil {
        holders.append((current, command))
      }
      responder = current.next
      steps += 1
    }
    let names = holders.map { name($0.responder) }.joined(separator: ",")
    guard !holders.isEmpty else { return "esc=none; start=\(start)" }
    for holder in holders {
      // Polecenie bywa wystawione przez respondenta, który sam akcji nie obsługuje: cel szuka łańcuch, jak w UIKit.
      guard let action = holder.command.action,
        let target = holder.responder.target(forAction: action, withSender: holder.command) as? NSObject,
        target.responds(to: action)
      else { continue }
      let sent = UIApplication.shared.sendAction(action, to: target, from: holder.command, for: nil)
      return "esc=\(name(holder.responder)); cel=\(name(target)); start=\(start); holders=[\(names)]; sent=\(sent)"
    }
    return "esc=bez-celu; start=\(start); holders=[\(names)]"
  }

  /// Gest „wstecz” czytnika od elementu górnej prezentacji: w treści (`inBar == false`) albo w pasku nawigacji.
  /// Przybliża drogę UIKit: element, jego kontenery dostępności, widoki i kontrolery nad nim. Wynik mówi, kto
  /// gest wziął i którędy szedł.
  static func accessibilityEscape(inBar: Bool) -> String {
    guard let top = presented().last, let root = top.view else { return "axesc=brak-prezentacji" }
    var leaf: NSObject?
    var queue: [(node: NSObject, bar: Bool)] = [(root, false)]
    var visited = 0
    while !queue.isEmpty, leaf == nil, visited < 4000 {
      let (node, underBar) = queue.removeFirst()
      visited += 1
      let bar = underBar || node is UINavigationBar
      if node !== root, bar == inBar, node.isAccessibilityElement, !(node.accessibilityLabel ?? "").isEmpty {
        leaf = node
        break
      }
      var children: [NSObject] = []
      if let elements = node.accessibilityElements {
        children += elements.compactMap { $0 as? NSObject }
      } else {
        let count = node.accessibilityElementCount()
        if count > 0, count != NSNotFound {
          children += (0..<count).compactMap { node.accessibilityElement(at: $0) as? NSObject }
        }
      }
      if let view = node as? UIView { children += view.subviews.filter { !$0.isHidden } }
      queue += children.map { ($0, bar) }
    }
    guard let leaf else { return "axesc=brak-elementu; bar=\(inBar)" }
    var chain: [String] = []
    var current: NSObject? = leaf
    while let node = current, !(node is UIWindow), chain.count < 80 {
      chain.append(name(node))
      if node.accessibilityPerformEscape() {
        return "axesc=\(name(node)); bar=\(inBar); kroki=\(chain.count); start=\(name(leaf))"
      }
      current = accessibilityParent(node)
    }
    return "axesc=nikt; bar=\(inBar); start=\(name(leaf)); chain=[\(chain.suffix(12).joined(separator: ">"))]"
  }

  /// Rodzic w drodze gestu: kontener dostępności elementu, a dla widoku i kontrolera — następny respondent.
  private static func accessibilityParent(_ node: NSObject) -> NSObject? {
    if let responder = node as? UIResponder { return responder.next }
    let selector = NSSelectorFromString("accessibilityContainer")
    guard node.responds(to: selector) else { return nil }
    return node.perform(selector)?.takeUnretainedValue() as? NSObject
  }

  /// Promień rogu górnej prezentacji (albo korzenia) z API iOS 26 oraz promienie warstw nad jej widokiem.
  static func corners() -> String {
    guard let window = appWindow(), let host = (presented().last ?? window.rootViewController)?.view else {
      return "corners=brak"
    }
    let probe = UIView(frame: host.bounds)
    probe.isUserInteractionEnabled = false
    probe.cornerConfiguration = .corners(radius: .containerConcentric())
    host.addSubview(probe)
    host.layoutIfNeeded()
    let top = probe.effectiveRadius(corner: .topLeft)
    let bottom = probe.effectiveRadius(corner: .bottomLeft)
    probe.removeFromSuperview()
    var layers: [String] = []
    var view: UIView? = host
    while let current = view, layers.count < 4 {
      if current.layer.cornerRadius > 0 { layers.append("\(name(current))=\(current.layer.cornerRadius)") }
      view = current.superview
    }
    let frame = host.convert(host.bounds, to: window)
    return "api-top=\(top); api-bottom=\(bottom); layers=[\(layers.joined(separator: ","))]; "
      + "frame=\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width)),\(Int(frame.height)); "
      + "window=\(Int(window.bounds.width))x\(Int(window.bounds.height))"
  }
}

extension UIResponder {
  fileprivate static weak var probeCaptured: UIResponder?

  @objc fileprivate func rarogProbeCapture(_ sender: Any?) {
    UIResponder.probeCaptured = self
  }
}

/// Okno sondy: nigdy kluczowe, dotyk tylko w przyciski.
private final class ProbeWindow: UIWindow {
  override var canBecomeKey: Bool { false }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    return hit is UIControl ? hit : nil
  }
}

private final class ProbeController: UIViewController {
  private enum Action: String, CaseIterable {
    case inspect, escape, corners, axescape, axescapebar

    @MainActor
    func run() -> String {
      switch self {
      case .inspect: UITestProbe.inspect()
      case .escape: UITestProbe.escape()
      case .corners: UITestProbe.corners()
      case .axescape: UITestProbe.accessibilityEscape(inBar: false)
      case .axescapebar: UITestProbe.accessibilityEscape(inBar: true)
      }
    }
  }

  private let state = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 2
    row.translatesAutoresizingMaskIntoConstraints = false
    for action in Action.allCases {
      let button = UIButton(type: .custom)
      button.backgroundColor = UIColor.gray.withAlphaComponent(0.25)
      button.accessibilityIdentifier = "probe.\(action.rawValue)"
      button.accessibilityLabel = "probe.\(action.rawValue)"
      button.addAction(UIAction { [weak self] _ in self?.show(action.run()) }, for: .primaryActionTriggered)
      button.widthAnchor.constraint(equalToConstant: 30).isActive = true
      button.heightAnchor.constraint(equalToConstant: 16).isActive = true
      row.addArrangedSubview(button)
    }
    state.font = .systemFont(ofSize: 4)
    state.textColor = .clear
    state.isAccessibilityElement = true
    state.accessibilityIdentifier = "probe.state"
    state.accessibilityLabel = "probe.state"
    state.accessibilityValue = ""
    state.widthAnchor.constraint(equalToConstant: 8).isActive = true
    row.addArrangedSubview(state)
    view.addSubview(row)
    // Górny środek tuż pod paskiem stanu: środek paska nawigacji ekranu i arkusza, gdzie nie ma przycisków apki.
    // Samego paska stanu i pasa wskaźnika ekranu głównego system nie oddaje apce (dotyk tam do okna nie dochodzi).
    NSLayoutConstraint.activate([
      row.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 2),
      row.centerXAnchor.constraint(equalTo: view.centerXAnchor),
    ])
  }

  private func show(_ text: String) {
    state.accessibilityValue = text
  }
}
#endif
