import Foundation

/// Pages of the outside services whose keys the person who runs the server creates: the Settings pages of dictation
/// and the voice agent link to them next to the setup steps. Addresses are not copy, so they have no language
/// variants. They stay apart from `ProductLinks`, which holds only addresses in the product's own domain.
public enum ProviderLinks {
  /// The Soniox console, where a project in the EU region gives the dictation key.
  public static let sonioxConsole = URL(string: "https://console.soniox.com")!
  /// The OpenAI page that creates API keys for the voice agent.
  public static let openAIKeys = URL(string: "https://platform.openai.com/api-keys")!
}
