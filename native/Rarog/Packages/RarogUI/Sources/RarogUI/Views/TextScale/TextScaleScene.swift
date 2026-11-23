#if os(iOS)
import UIKit

// Puts the app's text size (`TextScale`) on the scene: `UIWindowScene.traitOverrides.preferredContentSizeCategory`
// reaches SwiftUI, sheets, popovers and every UIKit font that adjusts to the content size category, and moves
// `UITraitCollection.current` too. Under the override the scene's traits no longer show a change of the SYSTEM size,
// so the system's category is read from the screen and followed through `UIContentSizeCategory.didChangeNotification`.
// Where every text style has one size (the iPad app on a Mac) the override moves no font: the views take their size
// from the model through the text scaling contract (`Theme/TextStyle/`, `TextScaleHost`), and the override only
// carries the same category to the views' traits. Owner: text size.

/// Keeps one scene (or, in tests without a scene, one window) on the effective text size.
@MainActor
public final class TextScaleSceneBinding {
  /// What carries the override.
  public enum Target {
    case scene(UIWindowScene)
    /// The UIKit test host has no scene; a window gives its views the same traits.
    case window(UIWindow)
  }

  private let scale: TextScale
  private let target: Target
  private let systemCategory: () -> UIContentSizeCategory
  private let center: NotificationCenter
  private var observer: NSObjectProtocol?

  /// Reads the system's size, applies the stored step at once and follows both from now on.
  public init(
    scale: TextScale, target: Target, systemCategory: @escaping () -> UIContentSizeCategory,
    center: NotificationCenter = .default
  ) {
    self.scale = scale
    self.target = target
    self.systemCategory = systemCategory
    self.center = center
    scale.systemChanged(TextSizeCategory(systemCategory()))
    scale.onOverrideChange = { [weak self] override in self?.apply(override) }
    apply(scale.override)
    observer = center.addObserver(
      forName: UIContentSizeCategory.didChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.systemDidChange() }
    }
  }

  isolated deinit {
    if let observer { center.removeObserver(observer) }
  }

  private func systemDidChange() {
    scale.systemChanged(TextSizeCategory(systemCategory()))
  }

  private func apply(_ override: TextSizeCategory?) {
    switch target {
    case let .scene(scene):
      if let override {
        scene.traitOverrides.preferredContentSizeCategory = override.contentSizeCategory
      } else {
        scene.traitOverrides.remove(UITraitPreferredContentSizeCategory.self)
      }
    case let .window(window):
      if let override {
        window.traitOverrides.preferredContentSizeCategory = override.contentSizeCategory
      } else {
        window.traitOverrides.remove(UITraitPreferredContentSizeCategory.self)
      }
    }
  }
}

/// The app's scene binding: the stored step goes on the scene as it connects, before its first frame.
@MainActor
public enum TextScaleScenes {
  private static var binding: TextScaleSceneBinding?
  private static var observer: NSObjectProtocol?

  /// Call once at launch, before the scene connects (the app's `init`). The app has one scene.
  public static func start(_ scale: TextScale = .shared) {
    guard observer == nil else { return }
    observer = NotificationCenter.default.addObserver(
      forName: UIScene.willConnectNotification, object: nil, queue: .main
    ) { note in
      let scene = note.object as? UIWindowScene
      MainActor.assumeIsolated {
        guard let scene else { return }
        binding = TextScaleSceneBinding(scale: scale, target: .scene(scene)) { [weak scene] in
          scene?.screen.traitCollection.preferredContentSizeCategory
            ?? UIApplication.shared.preferredContentSizeCategory
        }
      }
    }
  }
}

extension TextSizeCategory {
  /// A system category; an unknown one (`.unspecified`) reads as Large, the system's default.
  public init(_ category: UIContentSizeCategory) {
    self = Self.allCases.first { $0.contentSizeCategory == category } ?? .large
  }

  public var contentSizeCategory: UIContentSizeCategory {
    switch self {
    case .extraSmall: .extraSmall
    case .small: .small
    case .medium: .medium
    case .large: .large
    case .extraLarge: .extraLarge
    case .extraExtraLarge: .extraExtraLarge
    case .extraExtraExtraLarge: .extraExtraExtraLarge
    case .accessibilityMedium: .accessibilityMedium
    case .accessibilityLarge: .accessibilityLarge
    case .accessibilityExtraLarge: .accessibilityExtraLarge
    case .accessibilityExtraExtraLarge: .accessibilityExtraExtraLarge
    case .accessibilityExtraExtraExtraLarge: .accessibilityExtraExtraExtraLarge
    }
  }
}
#endif
