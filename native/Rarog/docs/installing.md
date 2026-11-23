# Installing on the iPad

Part of the app description: [native/Rarog/README.md](../README.md).

By cable or on the same local network:

```
bash scripts/ios-build.sh && bash scripts/ios-install.sh
```

A Debug build with automatic signing for the team in the project (`DEVELOPMENT_TEAM` in `project.pbxproj`; another
team: `RAROG_IOS_TEAM`). The build number is the HEAD commit count from `ios_build_number` (`scripts/ios-lib.sh`): it
only grows. The server's `RAROG_MIN_CLIENT_BUILD` goes to the app in `hello` as `minClientBuild`, and a build below
it gets the `tooOld` compatibility state, in which `MutationGate` refuses its mutations ("Client gates in one place"
above). A build from Xcode alone has number 1. `RAROG_BUILD_NUMBER=<N>` gives a build of an older commit a number
higher than the installed one. A shallow clone, or an `N` that is not a number or does not exceed the HEAD commit
count, is refused before the build. The output goes to `native/Rarog/build/` (outside git). `devicectl` installs it
on a paired, unlocked device: without `RAROG_IOS_DEVICE` the first connected iPad, with it the named device (udid or
CoreDevice identifier). The iOS scripts run outside the Claude Code sandbox, because xcodebuild, devicectl and swift
write caches to the system temporary directory.

**New device** (an iPhone, say): connect it by cable once and run `bash scripts/ios-build.sh` with the API key (below;
`RAROG_IOS_DEVICE` names the iPhone). A build for a connected device registers it with the account
(`-allowProvisioningDeviceRegistration`). Without a connected device the build targets "any iOS device", which is
enough when the profile already knows the device from another build.

**App Store Connect API key.** `RAROG_ASC_KEY_ID`, `RAROG_ASC_ISSUER_ID` and `RAROG_ASC_KEY_PATH` come only from the
process environment (a secrets manager, for example); `ios_asc_auth` in `scripts/ios-lib.sh` reads nothing else.
Without the key, command-line xcodebuild does not see the account: it signs only with existing profiles, does not
register devices and does not renew profiles. The `.p8` file must have mode 600 or 400, and `xcodebuild` gets a clean
environment (`ios_xcodebuild` in `scripts/ios-lib.sh`), so environment variables do not leak into build settings and
the log. A key with the Developer role is enough for a build. A script with uncommitted changes in the scripts that
touch the key does not use it (the `IOS_KEY_SCRIPTS` list and the `ios_scripts_clean` guard in `scripts/ios-lib.sh`):
a change that could print the key has to stay in history.

**Push (APNs):** the app has `aps-environment = development`, so the profile needs the Push Notifications capability.
`ios-build.sh` with the API key (`-allowProvisioningUpdates`) refreshes the profile; when a Developer-role key cannot
enable the capability, xcodebuild fails with an error about `aps-environment` missing from the profile. Then the
Account Holder or an Admin enables it in the portal (Certificates, Identifiers & Profiles → Identifiers →
`ai.rarog.app` → Push Notifications) and the build runs again. Checking the signed product: `codesign -d
--entitlements - native/Rarog/build/Build/Products/Debug-iphoneos/Rarog.app` (look for `aps-environment`).

**Associated Domains:** the app has `com.apple.developer.associated-domains` = `applinks:rarog.ai` (the universal
pairing link, `native/Rarog/docs/app-target.md`), so a signed build needs the Associated Domains capability on
`ai.rarog.app`. When signing fails because the profile does not include that entitlement, the Account Holder or an
Admin enables it in the portal (Certificates, Identifiers & Profiles → Identifiers → `ai.rarog.app` → Associated
Domains) and the build runs again. An unsigned build (`CODE_SIGNING_ALLOWED=NO`) does not need it. The same
`codesign -d --entitlements -` on the signed app shows the entry.

The app reads its push environment from the profile in the app package (`embedded.mobileprovision`) with the pure
function `ProvisioningProfile.pushEnvironment` (`PushRouting.swift` in `RarogCore`): a profile with
`aps-environment` → that value, a profile without it → `development`, no profile on a device → `production`, none on
the simulator → `development`. A build from `ios-build.sh` and a development export (`debugging`) have a profile with
`development` (the APNs sandbox). An App Store package has no profile (TN3125), and neither does a TestFlight one
(measured); a build without a profile reports `production` and gets pushes only through the relay
(`docs/server-config.md`). At every new token and environment pair `client.log` gets a line with the `push:` prefix
naming the environment and the profile state (with `aps-environment`, without it, or none), without the token.

**Live Activity:** the `ai.rarog.app.widgets` extension is a separate App ID with its own profile. Automatic signing
with the API key (`-allowProvisioningUpdates`) creates it when the key's role allows; when it does not (an error about
a missing profile or App ID for `ai.rarog.app.widgets`), the Account Holder or an Admin creates the App ID
`ai.rarog.app.widgets` in the portal (Certificates, Identifiers & Profiles → Identifiers → "+" → App IDs, no
capability) and the build runs again. The extension has no entitlements; Live Activity updates go with the activity
token through the app's topic (`ai.rarog.app.push-type.liveactivity`; the server skips a device entry without a `topic`
field when reading `apns-devices.json`), with the same APNs key.

**Notification service extension:** `ai.rarog.app.notification-service` is a separate App ID with its own profile,
like the widget: no capability, created by the Account Holder or an Admin in the portal (Certificates, Identifiers &
Profiles → Identifiers → "+" → App IDs) BEFORE the first signed build. The simulator and an unsigned build do not need
it. The extension's only entitlement is the Keychain group `ai.rarog.app.shared` (no `aps-environment`: the app
receives pushes, the extension only changes their content). Checking the signed product: `RarogNotificationService.appex`
in `Rarog.app/PlugIns/` and `codesign -d --entitlements -` on it (one group: `<Team ID>.ai.rarog.app.shared`). The app
has no notification format flag: `RAROG_PUSH_E2E=0` turns off banner content on the server side
(`docs/server-config.md`), and the app with the extension stays as it is.

## Building your own copy

The project signs the app as `ai.rarog.app` for USEO's Apple team. A copy for your own use needs your team and your
own bundle id, and three services work differently for it:

- **Team and bundle id.** Set your team with `RAROG_IOS_TEAM=<Team ID>` for `scripts/ios-build.sh`, or in Xcode
  (`DEVELOPMENT_TEAM` in `project.pbxproj`). Replace the prefix `ai.rarog.app` with your own in every
  `PRODUCT_BUNDLE_IDENTIFIER` of `project.pbxproj` (the widget and the notification extension keep their
  `.widgets` and `.notification-service` suffixes), in `CFBundleURLName` and the Keychain groups of `Info.plist`, in
  the Keychain groups of `Rarog.entitlements`, `RarogNotificationService.entitlements` and
  `RarogNotificationService/Info.plist`, and in `IOS_BUNDLE_ID` (`scripts/ios-identity.sh`). Create the App IDs as
  described above for `ai.rarog.app`. These edits are for your copy only: `server/test/product-identity-guard.test.ts`
  ties the bundle id to the push relay topic and the pairing link host, so it fails on them.
- **Build number at or above the server's threshold.** A server installed from npm accepts changes only from app
  builds at or above `RAROG_MIN_CLIENT_BUILD` (default 5614 for a package install; `rarog doctor` shows the value in
  force); an older build stays read-only. Xcode alone sets build 1 and `scripts/ios-build.sh` uses the commit count
  of your clone, so build with `RAROG_BUILD_NUMBER=<at least the threshold>`, or set `RAROG_MIN_CLIENT_BUILD` in `env`
  of `~/.config/rarog/config.json` to your build number and run `rarog restart`.
- **No pushes through `push.rarog.ai`.** The push relay accepts only the topic `ai.rarog.app` (`relay/README.md`),
  so it refuses your copy. Create an APNs key in your team and give the server the whole `RAROG_APNS_*` set, with
  `RAROG_APNS_TEAM_ID` set to your team and `RAROG_APNS_TOPIC` to your bundle id, and `"RAROG_PUSH_RELAY_URL": ""`
  in `env` (`docs/server-config.md`, "Push notifications"). A build from `ios-build.sh` uses the APNs sandbox, which
  is what that key reaches.
- **No universal link.** `https://rarog.ai/pair#…` opens only the apps that `rarog.ai` names, so a tap on it does
  not open your copy. Remove the `applinks:rarog.ai` entry of `com.apple.developer.associated-domains` from
  `Rarog.entitlements` (your App ID then needs no Associated Domains capability) and pair in the app with Scan QR Code
  or I Have a Link.
- **No `relay.rarog.ai`.** The iroh relay admits apps through its registry (`relay-auth/README.md`), which checks
  each app with Apple against USEO's team, so your copy cannot register and the relay may refuse it. For a new
  `config.json`, run `rarog setup --iroh-relay https://host/` with your own iroh relay, or
  `rarog setup --tailscale-only`. An existing install keeps its relay on both: set `RAROG_IROH_RELAY` in `env` of
  `~/.config/rarog/config.json` (`docs/server-config.md`, "iroh listener") or follow "Tailscale only" in the same
  document, then run `rarog restart`.
