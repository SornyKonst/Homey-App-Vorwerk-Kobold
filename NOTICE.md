# Protocol references

This app contains an independent implementation of the unofficial Vorwerk Kobold cloud protocol. It does not bundle node-kobold, pybotvac, or Home Assistant source code.

Protocol and behavior were checked against:

- nicoh88/node-kobold — MIT license.
- stianaske/pybotvac — MIT license.
- bndtblds/homeassistant-vorwerk — Apache License 2.0.
- Athom Homey Apps SDK and documentation.

## Graphic assets

`assets/icon.svg` uses the official Vorwerk mark extracted from the inline header SVG of Vorwerk's public website on 2026-10-18:

https://www.vorwerk.com/de/de/c/home/landingpages/kobold/mykobold-app/vr300-vr200-saugroboter

The original viewBox is `0 0 113.4 43.3`. Its path and polygon geometry is unchanged; the mark is rendered in black, scaled proportionally, and centered on a transparent 960 × 960 canvas. No third-party logo repository or invented logo was used. The mark belongs to Vorwerk and is not licensed under this project's MIT license. This notice records its source and does not grant trademark rights or imply endorsement.

The VR300 driver icon is independently drawn vector linework. The current PNG app/driver images were generated with OpenAI image generation on 2026-10-18, using public official VR300 photographs as product-shape references. They replace the earlier Magnific images. They are new synthetic product representations, not photographs of the user's robot and not official Vorwerk marketing assets. The image sources, generation prompts, review limitations and delivery dimensions are recorded in ASSETS.txt. Official reference photographs themselves are not bundled in this app.

Vorwerk, Kobold, Homey and other product names belong to their respective owners. This community app is not affiliated with or endorsed by Vorwerk or Athom.
