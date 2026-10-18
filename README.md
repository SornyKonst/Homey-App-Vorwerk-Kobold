# Vorwerk Kobold VR200/VR300

Independent Homey SDK 3 community app developed by Lindner IT Solutions. Uses the unofficial MyKobold cloud interface; not affiliated with Vorwerk or Athom.

## Requirements

- Vorwerk Kobold VR200 or VR300 connected to a working MyKobold account.
- Homey Self-Hosted or Homey Pro, Homey 12.9.0 or newer. Platform: `local`; device connectivity: `cloud`.
- Internet access to `mykobold.eu.auth0.com`, `beehive.ksecosys.com` and `nucleo.ksecosys.com` (HTTPS; the robot endpoint can use port 4443).
- Live tests have used one VR300 on Homey Self-Hosted 13.5.1. Homey Pro and additional robots remain beta-test targets.
- VR200 support is tested with simulated protocol responses; a real VR200 has not yet been tested.

## Features

- Email-code sign-in and Repair of an existing device without recreating its Flows.
- Five native device buttons: Start, Pause, Resume, Stop and Return to station, with a separate read-only robot activity display; subject to the robot's command availability.
- Battery, dock/charging flags, errors and notices; reported modes, firmware, technical model, charge counter and device/battery information.
- On VR300: saved cleaning areas with a native **Area** list and separate **Start area cleaning** button, plus app-settings selection/start and Flow autocomplete. Selecting an area never starts cleaning. Maps and areas are created in MyKobold.
- Read the existing robot schedule without activating or editing it.
- On VR300: up to 50 history entries and saved maps; up to 20 recent cleanings in app settings. The selected saved map loads automatically when you open **History and maps**; a cleaning image loads when its entry is expanded.
- Latest cleaned area, elapsed duration and date on the device. Duration includes pauses and charging interruptions, not just active vacuum time.
- The existing 29 app Flow cards remain, with six deprecated compatibility cards for the former system controls: 14 actions, 12 conditions and 9 triggers in total. New VR200 devices use 15 core capabilities and five buttons; VR300 devices retain 23 capabilities, including six buttons and the area list. Model-specific Flow cards are filtered for new devices. English and German throughout.

## Install and connect

Use Node.js 24 or newer and the official Homey CLI. The Homey runtime requires Node.js 22 or newer. There are no third-party npm runtime dependencies.

```powershell
npm install -g homey@4.6.0
homey login
homey select
homey app install
```

Add **Vorwerk Kobold VR200/VR300** from Homey's device picker. Enter the email used by MyKobold and the newest one-time email code. No password is required. Use the existing device's **Repair / Reparieren** option to renew its connection. Do not use `--clean` to update an existing installation.

In **App settings → Configure / Konfigurieren**, view device information, history and maps, or read and save an area selection. Reading information, opening a map and saving a selection do not start cleaning. Cleaning starts only through an explicit control or Flow action.

The **History and maps** section is open by default. Its selected saved map is requested automatically, and changing the map selects the image to display. Expanding an individual cleaning requests that cleaning's image if available. The app does not preload images for all 20 history entries in the background.

## Controls and Flow behaviour

The app detects VR200 and VR300, including the VR300 firmware model name VR220. The VR200/basic-1 profile uses cleaning category 2 with only mode and modifier; it never sends persistent-map or navigation options. It skips the saved-map import during pairing. For VR200, areas, saved maps, map images, cleaning history and navigation controls are hidden and their endpoints reject requests. Additional device information is read only when that robot explicitly advertises the service. Core status, battery, charging, dock flags, reported cleaning mode, firmware/model and the existing robot schedule remain available when reported. A mixed account can contain both models.

The application ID and driver ID remain unchanged to preserve existing devices and Flow references. Existing capabilities are never removed; previously present unsupported capabilities are hidden instead. New VR200 pairings start with the smaller capability list. Existing unsupported Flow calls fail explicitly rather than starting a different cleaning or asking for an unnecessary new sign-in.

The native device view separates its control and sensor tabs. Five buttons provide **Start**, **Pause**, **Resume**, **Stop** and **Return to station**; the separate **Robot status** sensor is read-only. Start can resume an existing paused job, as before. Resume only continues a paused job and never starts a new one. Pause keeps a job available for resuming; Stop ends it. Reading a status value does not send a command.

Choose a room in the native **Area** list, then press the separate **Start area cleaning** button in the controls tab to begin that area's cleaning. The list and app settings share the same saved selection. No area is chosen automatically when no valid selection exists. The button validates the selected area and station status again before sending a command. Area jobs require the robot to be docked with no running or paused job.

The former combined status/control picker is hidden. Its `vacuumcleaner_state` capability and original enum IDs remain for compatibility. The six former system Flow cards are explicitly retained with matching IDs, arguments and listeners and marked deprecated, so existing Flows can keep them while new Flows use the app's clearer controls. The SDK automatically fires the legacy state-change trigger; the app does not fire it a second time. After the update on Self-Hosted 13.5.1, all 14 saved Flow-card references resolved successfully. Those checks read the card definitions without running movement actions.

The robot determines which commands are allowed. Returning may only become available after it detects its station during a job. If firmware requires pausing first, the app pauses once and checks availability again; it never starts an extra recovery drive. New area jobs require docking and no running or paused job. A missing or rejected area never falls back to cleaning the entire floor.

Commands are not repeated after an unclear response. Check MyKobold before issuing the command again. Status is normally polled every 60 seconds, with immediate and five-second follow-up reads after commands; failures back off up to ten minutes. Device information and saved schedule are read every 15 minutes or on request. History is read every 15 minutes, on request and after an observed cleaning completion.

First observations after adding, repairing or restarting a device do not replay historical Flow events. The new-history trigger also suppresses removed, restored and older cloud records. A record without a known start time does not trigger a new-history event. The "cleaning finished at the station" trigger means an active cleaning was observed followed by docking/charging; an early requested return can also cause it. Use the history-result condition to check the cloud-reported result.

Unknown data stays unknown. A docked robot can report that it is not actively charging; the app preserves these separate flags. Charge counter means the reported `totalCharges`, not guaranteed full battery cycles. A VR300 can report `VR220` as its technical model.

## Data and privacy

See [PRIVACY.md](PRIVACY.md) for English and German details. Connection credentials are stored privately with the Homey device, including the account ID token and an optional refresh token for history/maps. Email and one-time codes are not persisted. A returned refresh token enables automatic renewal; otherwise Repair is needed after expiry. No account password or separate analytics service is used.

Map images can show your floor plan and load automatically for the visible selected map or an expanded cleaning entry. The settings page temporarily caches at most one saved-map image and one cleaning image per robot; it does not preload the full history. Signed image URLs stay private in app memory for at most 15 minutes. Images are fetched through authenticated Homey app routes from an exact HTTPS host allowlist, without redirects, with type checks and a 5 MB limit. Images are not saved in the device store. Support diagnostics are off by default and exclude credentials, serials, coordinates and raw map/boundary identifiers. Do not share Homey backups containing device credentials.

## Validation and remaining beta tests

```powershell
npm test
homey app build
homey app validate --level publish
```

Tests use simulated cloud responses and a simulated Homey SDK; they do not email users or move robots. Live tests have confirmed sign-in, Repair, controls, automated start/pause/return, a complete area-only cleaning with autonomous return, read-only device/schedule/history/image access and read-only Flow actions/conditions. Actual trigger use in end-user Flows, long-term real token rotation, live outages, Homey mobile use, more robots and Homey Pro remain beta-test targets. Technical `publish` validation is not Store certification.

Technical publish validation has passed, but Store preparation still requires replacing the current drawn PNG app/device images: they are temporary review assets with the generic-illustration/clip-art issue described in [App Store Guideline 1.4](https://apps.developer.homey.app/app-store/guidelines). Athom certification remains pending. Real VR200 hardware testing is a recommended beta target; current VR200 evidence comes from simulated responses.

Version 0.1.7 passed 169 app tests, 12 offline automatic-map UI checks and official publish validation. Its update preserved the existing device, capabilities, area selection, Flows and account connection. Automatic saved-map display and loading an individual cleaning image on expansion were also confirmed in the real Homey browser without moving the robot. Narrow English/German and dark-CSS previews remain simulations, not real smartphone or Homey theme-switch tests.

Version 0.1.8 passed 182 app tests, including 97 integration tests, and official publish validation without warnings. Installation preserved all 16 previous capabilities and added five stateless buttons, for 21 capabilities. The device, area selection, account connection, three regular Flows and one Advanced Flow were preserved; their saved definitions were unchanged, all 14 card references resolved and 20 history entries remained readable. The five named native buttons, hidden old picker and separate read-only status view were checked in the real Homey browser. No movement actions were executed during these checks; the new button handlers and legacy action handlers were tested with simulated commands.

Version 0.1.9 passed 189 app tests, including 104 integration tests, and official publish validation. The update preserved all 21 previous capabilities and added the native area list and its separate start button, for 23 capabilities. The saved area, account connection, three regular Flows and one Advanced Flow remained; their saved definitions were unchanged and all 14 card references still resolved. The native list with six cleaning areas and separate button were checked in the real Homey browser. Changing and restoring the selection saved the expected area while the robot remained docked and charging. No real cleaning-start commands were sent; the new start handler was checked only with simulated responses.

This is not a complete implementation of every cloud endpoint. Local-only operation and editing maps, areas or the robot schedule are not included. The unofficial cloud can change independently.

Version 0.2.1 adds the VR200 profile, with 212 app tests and 16 offline settings tests. VR200 pairing, mixed accounts, the basic-1 command payload, capability visibility, unsupported endpoint guards and repair/recovery are simulated. The initial 0.2.0 live update exposed a VR300 startup error when reading options for the existing stateless area button; 0.2.1 fixes that exact failure and adds a stricter SDK regression test. The corrected update restored the real VR300's availability and preserved its 23 capabilities, saved selection, account, three regular Flows and one Advanced Flow. All 14 saved card references still resolve, and 20 history entries remain readable. A real VR200 test remains required before claiming hardware-confirmed compatibility.

Version 0.2.2 passed 214 app tests, 16 settings checks, 14 pairing/Repair checks and 84 complete protocol comparisons against 0.1.9. It preserves confirmed model identity across partial status responses without unnecessary extra queries and rechecks area support before command dispatch. On the real VR300, all four read-only Flow actions, 23 condition cases, six area suggestions, device/schedule reads, 20 history entries and both map-image types passed. Native values matched the settings data, area drafts did not save prematurely, and settings/native selection synchronized without movement. The saved selection, account, 23 capabilities and four existing Flow definitions remained, with all 14 references resolvable. Movement commands and event transitions remain simulated in this regression pass; no physical controls or saved Flows were run.

## GitHub Actions

The app files, including `app.json`, `.homeycompose` and `package.json`, must be at the repository root. Enable Actions and commit the workflows to the default branch. These workflows use the pinned official Homey CLI 4.6.0.

- **Checks** ([ci.yml](.github/workflows/ci.yml)) runs on pushes, pull requests or manually: offline tests on Node.js 22/24, Homey publish validation and package-content checks. No Homey token is needed.
- **Update app version** ([version.yml](.github/workflows/version.yml)) runs manually on the default branch. Under **Actions → Update app version → Run workflow**, choose `version`: `patch` (default), `minor` or `major`. Enter required English release notes in `changelog_en` (4–10,000 characters), and optionally German notes in `changelog_de`. After tests and validation, it commits the version files and `.homeychangelog.json` directly to that branch. Repository permissions and branch rules must allow that commit. It creates no tag, release or upload.
- **Upload Homey draft** ([publish-draft.yml](.github/workflows/publish-draft.yml)) also runs only manually on the default branch. Enter the exact committed `version`, such as `0.2.3`; the manifests must match and `.homeychangelog.json` must contain English notes for it. The workflow tests, validates and uploads that version as a Draft.

Before the first draft upload, the app owner must create their own Homey Personal Access Token through [Homey Developer Tools → My account](https://tools.developer.homey.app/me), as described by [Athom's publishing action](https://github.com/marketplace/actions/homey-app-publish). In the GitHub repository, open **Settings → Secrets and variables → Actions → Secrets → New repository secret**, set **Name** to `HOMEY_PAT`, paste the token into **Secret**, and select **Add secret**. Enter it only in GitHub's secret form; do not commit it or copy credentials from a local Homey CLI profile. Only the draft-upload step receives this secret.

Run **Upload Homey draft** after the version workflow succeeds, then review the uploaded Draft in [Homey Developer Tools](https://tools.developer.homey.app/). Test distribution, certification and Live publication remain separate manual steps; these workflows never release automatically. A first public release requires Athom certification; see the [official publishing instructions](https://apps.developer.homey.app/app-store/publishing).

## Support and source code

Source code: [SornyKonst/Homey-App-Vorwerk-Kobold](https://github.com/SornyKonst/Homey-App-Vorwerk-Kobold). For help or bug reports, use the project's [GitHub Issues](https://github.com/SornyKonst/Homey-App-Vorwerk-Kobold/issues). Reports are public: include the app version, Homey version, robot model and steps to reproduce, but remove credentials, serial numbers and identifying floor-plan images. The repository and issue tracker are for this community app; they are not Vorwerk support channels.

## References

- [node-kobold](https://github.com/nicoh88/node-kobold)
- [pybotvac](https://github.com/stianaske/pybotvac)
- [Home Assistant Vorwerk integration](https://github.com/bndtblds/homeassistant-vorwerk)
- [Homey SDK](https://apps.developer.homey.app/)

See [NOTICE.md](NOTICE.md) for attribution. The source uses the included MIT license. Product names are trademarks of their respective owners.
