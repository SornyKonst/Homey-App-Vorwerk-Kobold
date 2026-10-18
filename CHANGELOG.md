# Changelog

## 0.2.2 — 2026-10-18

- Retain the last confirmed model when a valid status response omits optional model metadata. Fresh explicit model data still takes precedence. Only a change in general-info support resets the additional-data interval.
- Recheck area support immediately after each fresh status response before an area start. If support disappears during map lookup, reject before dispatching the command; retain the existing client-side parameter safeguards.
- Passed 214 app tests, 16 settings UI tests, 14 pairing/Repair UI tests and 84 full request comparisons against 0.1.9 with simulated responses.
- Installed and verified all four read-only Flow actions, 23 condition cases, six areas with filtered autocomplete, device information, saved schedule, 20 history entries and both PNG map-image types on the existing VR300. No motion commands were sent.
- Verified unsaved area drafts, settings-to-native selection synchronization and restoration of the previous selection in the real Homey browser. Preserved all 23 capabilities, the account, saved selection, unchanged definitions of three regular Flows and one Advanced Flow; all 14 saved card references resolve.

## 0.2.1 — 2026-10-18

- Fix startup when Homey rejects the options lookup for the existing stateless area-start button. Limit the fallback to that button and exact error; unrelated SDK and write errors remain errors.
- Add regression coverage for this live-discovered initialization failure. The corrected installation restores device availability without recreating devices or Flows.
- Passed 212 app tests, 16 offline settings UI tests and official publish validation. No robot motion commands were sent during release checks.

## 0.2.0 — 2026-10-18

- Add VR200/basic-1 support with category-2 cleaning and no unsupported navigation, map or boundary parameters. Keep the VR300 mapped-cleaning behavior and never retry an area request as full-floor cleaning.
- Detect VR200, VR300 and the VR300 firmware alias VR220. Skip map import for VR200; mixed-model accounts remain usable. Unknown discovery models can be checked by one read-only status probe after failed map import; confirmed VR300 failures remain strict.
- Show model-appropriate native controls and settings. New VR200 devices use 15 core capabilities; hide unsupported areas, maps, history and navigation. Read extra device information only if the service is explicitly advertised.
- Preserve application/driver IDs, device records, capabilities already present and all 35 Flow-card IDs/arguments. Filter optional cards for new devices by their capabilities and reject unsupported calls explicitly.
- Clear prior account caches and history tags before UI migration during Repair, and resume history polling if that service becomes available again.
- The first live 0.2.0 installation exposed a startup options-lookup failure on an existing VR300; use 0.2.1, which fixes it. VR200 behavior is verified with simulated responses, not a real VR200.

## 0.1.9 — 2026-10-18

- Add a native Area list and separate Start area cleaning button. Choosing an area only saves the selection; it does not move the robot.
- Synchronize the native list with the existing app-settings selection. Keep multi-map area identities distinct and never choose the first area automatically.
- Validate the selected area and docking state before an explicit area start. A missing or removed area never falls back to a full-floor cleaning.
- Retain all 21 previous capabilities and all existing Flow cards, IDs and arguments; add only the area picker and its stateless start button.
- Passed 189 app tests, including 104 integration tests, and official publish validation. Installed on Homey Self-Hosted 13.5.1 with six available areas, saved selection and account connection preserved.
- Preserved the unchanged definitions of three regular Flows and one Advanced Flow; all 14 existing card references still resolve. No real cleaning-start commands were sent during these checks.
- Checked the new native list and button in the real Homey browser. Changing and restoring the selected area updated the saved selection while the robot stayed docked and charging.

## 0.1.8 — 2026-10-18

- Replace the combined native status/control picker with five buttons: Start, Pause, Resume, Stop and Return to station. Keep robot activity read-only in the separate sensor view.
- Preserve Start's existing ability to resume a paused job. Resume only continues a paused job; Stop ends it and Pause preserves it for later continuation.
- Retain all 16 existing capabilities and add five buttons, for 21 capabilities. Keep the 29 existing app Flow cards unchanged and explicitly retain six deprecated system-card compatibility definitions and listeners: 14 actions, 12 conditions and 9 triggers in total.
- Keep the legacy capability and enum IDs. Let the SDK trigger its state-change Flow automatically, without a second explicit trigger call.
- Passed 182 app tests, including 97 integration tests, and official Homey publish validation without warnings.
- Installed on Homey Self-Hosted 13.5.1. Preserved the existing device, area selection, account connection, all 16 previous capabilities and unchanged definitions of three regular Flows and one Advanced Flow; all 14 saved card references resolved and 20 history entries remained readable.
- Verified five stateless native buttons, the hidden legacy picker and the separate read-only status display in the real Homey browser. Existing compatibility-card IDs and arguments were preserved.
- No native button or legacy movement Flow action was executed on the real robot during these checks. Command handlers were tested with stubs; real smartphone testing remains open.

## 0.1.7 — 2026-10-18

- Automatically request the selected saved-map image when the History and maps section opens; this section is open by default. Changing the saved map displays its image.
- Load an individual cleaning's image when its history entry is expanded, without preloading every history image in the background.
- Bound the temporary settings-page image cache to one saved map and one cleaning image per robot. Keep signed cloud image URLs private and retain the existing backend limits.
- Updated English/German privacy information and documentation to describe automatic image loading. No extra consent dialog or movement action is added.
- Passed 169 app tests, 12 offline automatic-map DOM checks and official Homey publish validation.
- Installed 0.1.7 and verified preservation of the device, all 16 capabilities, saved area selection, three regular Flows, one Advanced Flow and the account connection. Re-read 20 history entries, both PNG map-image types, the read-only refresh Flow and five history-condition cases.
- Checked English/German previews at 320/375 pixels with light/dark CSS, automatic saved-map loading, switching between maps and back, and individual cleaning images. No horizontal overflow or unexpected scroll/focus jump was observed.
- Confirmed automatic saved-map loading in the real Homey browser without an extra map button. Expanding an individual cleaning automatically displayed its image; keyboard focus remained on its summary.
- The native status/control picker is unchanged. No movement commands were sent during these release checks. Actual smartphone, Homey theme-switch testing and Store certification remain separate work.

## 0.1.6 — 2026-10-18

- Reorganized settings into saved areas, history and maps, and expandable device details. Feedback stays beside the relevant action; selection, expanded sections and keyboard focus are preserved during updates.
- Display map images inline with a close action and focus return. Distinguish unavailable, partially available, empty and sign-in-required states.
- Reworked pairing and Repair into explicit email and code steps with recipient confirmation, separate resend and email correction, a visible cooldown, code clearing and navigation retry without reusing an accepted code.
- Clarified English and German labels across all 29 Flow cards, 16 device capabilities and the device setting. Stop, pause, current job area, reported modes and elapsed duration now have distinct descriptions.
- Reject unknown values in Flow conditions instead of allowing Homey's inversion to turn an unknown value into a confirmed negative. Preserve known false and zero values.
- Keep an already observed cleaning run tracked when intervening command-state checks are unavailable.
- Passed 169 automated app tests, 14 offline pairing/Repair form tests and official Homey publish validation.
- Installed on Homey and verified preservation of the existing device, all 16 capabilities, selected area, three regular Flows, one Advanced Flow and the account connection. Re-read 20 history entries, both PNG map-image types, the read-only refresh Flow and five cases for three history conditions.
- Checked synthetic English/German browser previews at 320/375 pixels, light/dark CSS, offline, empty, missing-device, login-required and partial-data states.
- Verified the updated settings, native device labels, inline map images and focus return in Homey. Corrected Homey style overrides and rechecked button appearance, control size and readable labels. Added explicit pairing/Repair surface and text colors.
- Verified the initial Repair email step in Homey without entering data or requesting a code. Actual mobile-app and Homey theme-switch testing remain open.
- No movement commands were sent during these release checks. No Store submission or approval is implied.

## 0.1.5 — 2026-10-18

- Adopted the app name Vorwerk Kobold VR300 and developer Lindner IT Solutions; revised concise Store text and generic English/German messages.
- Explained data and account access in settings and added bilingual privacy information and public documentation without personal test data.
- Added an official-source brand icon with attribution and a distinct device icon.
- Prevented removed, restored or older cloud-history entries from replaying a new cleaning-history Flow.
- Passed 163 simulated tests, including persisted sign-in after restart, recovery from read failures and late image responses. No real movement commands were sent while checking this version.

## 0.1.4 — 2026-10-18

- Added cleaning history and saved maps through the account interface. Map images load only on explicit request through a protected Homey endpoint.
- Added three latest-cleaning values, a read-only Flow action, three conditions and a new-history-entry trigger. The first import remains a silent baseline.
- Identify duration as elapsed time including pauses and charging interruptions; unknown results and measurements are not represented as success or zero.
- Keep the account ID token and optional refresh token only in the private Homey device store. Support renewal or a new sign-in through Repair. Email and one-time codes remain unsaved.
- Read metadata at intervals of at least 15 minutes, after observed cleaning endings and on explicit request. Keep image URLs briefly in private memory, never expose signed URLs to the UI and do not store image files with the device.
- Passed 159 automated tests and official publish validation. Installed and read 20 history entries, one saved map and both PNG image types from one real VR300. Verified the read-only Flow action and five condition cases; the new trigger was registered and simulated. No movement commands were sent during this check.

## 0.1.3 — 2026-10-18

- Added eight device values and a view for battery and device information; existing devices receive the additional capabilities during update.
- Read existing robot schedule entries using the supported read endpoint without enabling or executing them.
- Added a read-only Flow action, five conditions and three change triggers.
- Isolated additional reads from basic status, limited their frequency and distinguished unknown values from genuine zeros and disabled states.
- Prevented missing notices from producing false clear events and suppressed initial-observation change triggers. Optional reads do not delay command-state checks before motion.
- Passed 125 automated tests. Installed and checked the new displays, refresh action, schedule entries, Flow conditions and trigger registration using read-only requests on one real VR300.

## 0.1.2 — 2026-10-18

- Imported saved MyKobold maps during pairing and Repair. This historical version did not store account tokens or map images.
- Read saved cleaning areas with their map identity, excluded no-go lines and distinguished matching area names across maps.
- Added settings for reading, selecting and explicitly starting a saved area.
- Added Clean an area and Refresh areas Flow cards.
- Rechecked the selected area and robot state before starting; never automatically replaced an active job or fell back to whole-home cleaning after an error.
- Added a limited, disabled-by-default diagnostic for failed area reads.
- Added the missing Repair sign-in view and verified map import, six saved areas and actual Homey Flow autocomplete on one real VR300.
- Optional area diagnostics compare the robot response with the requested area without storing map or boundary identifiers; missing feedback remains unknown.
- Verified a complete saved-area cleaning through Homey, including matching area feedback, autonomous return, docking and charging. Local observation confirmed that only the selected area was cleaned.

## 0.1.1 — 2026-10-18

- Explain when the VR300 has not detected its charging station and does not allow returning. No additional pause or movement is triggered in that case.
- Added a disabled-by-default support diagnostic limited to status fields without device secrets or map identifiers.
- Added three regressions for unavailable station recognition and diagnostic limits.
- Verified start, pause, resume and return through the Homey device Flow cards. After the robot allowed returning, the Homey command led to docking and reported charging.
- Verified the three live Flow conditions for cleaning, docking and charging.
- Verified a fully automatic start/pause/return sequence. The test waited for the robot's return permission before pausing.

## 0.1.0 — 2026-10-18

- Initial release with sign-in, basic controls, robot status, battery level and Flow cards.
