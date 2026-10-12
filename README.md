# Kinvent Companion samples

This repository holds samples that show how to use **`@kinvent/companion-sdk`** to read Kinvent sensors from
your own program.

The SDK talks to the **Kinvent Companion app**, a desktop app that runs on the same computer and connects to the
sensors over Bluetooth. Your program never talks to the sensors directly: it finds the Companion app, claims a
session, prepares the sensors, and receives their samples with names and units.

## Samples

| Folder | Language | What it shows |
|---|---|---|
| [`kinvent-companion-sdk-sample`](./kinvent-companion-sdk-sample) | JavaScript / TypeScript (Node.js) | A command-line program that records force data from one sensor or a pair of sensors to a CSV file and shows live values with their units. Includes short SDK snippets, a quickstart, and tests that run without sensors. |

The SDK is available for **JavaScript only** today (Node.js and browsers, with TypeScript types). Samples for
other languages will be added here when the SDK supports them.

Start with [`kinvent-companion-sdk-sample/README.md`](./kinvent-companion-sdk-sample/README.md).

## Requirements

- The **Kinvent Companion app**, installed and running, of the **same version** as the SDK the sample uses.
  The SDK refuses to work with a Companion app of another version.
- **Node.js 22** or later, for the JavaScript sample.
- **The SDK file.** `@kinvent/companion-sdk` is not on the public npm registry and is not in this repository.
  Kinvent gives you the SDK as a file, for example `kinvent-companion-sdk-2026.9.1.tgz`. Put it in the
  sample's `vendor/` folder and run `npm install`; no login or token is needed. The file is licensed to your
  organisation: never commit it or share it. The sample's `.gitignore` already keeps it out of git.

## Versions

Each Companion release has its own branch, named after the version, for example `version-2026-9-1` for
2026.9.1. Use the branch that matches the Companion app you install.

## Data protection and intended use

These are developer samples. They are **not for clinical use**, diagnosis or treatment.

Sensor recordings are data about a person, and in most uses they are **health data** under the GDPR. Keep
recordings on the computer that made them, never commit them to git, and do not attach them to tickets, chats or
e-mails. Anything you build that changes how a Kinvent device measures must be checked by your own device
software, quality and regulatory people before release.

## Licence

- The samples: [`LICENSE`](./LICENSE).
- The Kinvent Companion SDK: [`LICENSE-SDK`](./LICENSE-SDK). The same text is packed inside the SDK file. In
  short, the SDK may only be used with Kinvent devices through the Kinvent Companion app, and it must not be
  modified, reverse engineered, decompiled or redistributed on its own.
