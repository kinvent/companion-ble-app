# Kinvent Companion CLI sample — user guide

How to build, run and read the output of the sample. For what the code does and how to use the SDK in your own
program, start with the [README](./README.md).

A small Node.js command-line program. It records raw force data from one Kinvent sensor, or a sensor pair,
through the Kinvent Companion app, and writes it to a CSV file.

**This is a developer sample. It is not for clinical use.** It shows how a program uses the public
`@kinvent/companion-sdk`: find the companion, check the version, claim the session, connect a sensor, start,
read live values with units, stop, release. Do not use its files for diagnosis or treatment.

The sample never talks to Bluetooth itself. The companion owns the radio. The sample talks HTTP and WebSocket to
`127.0.0.1` only. It imports `@kinvent/companion-sdk` and nothing else from Kinvent.

---

## 1. Prerequisites

- **Node.js 22 or later.** The SDK uses the global `fetch` and `WebSocket` of Node 22. With an older Node the
  sample stops with "Node 22 or later is required" (exit 2).
- **A running Kinvent Companion app of the same version as the SDK.** The companion's version and the SDK's
  version must be equal on `major.minor.patch` (for example both `2026.9.1`). The SDK version is the one in
  `package.json` (`@kinvent/companion-sdk`). A companion of another version is refused (error E2).
- **A GitHub token from Kinvent** to install the SDK from Kinvent's private npm registry (README section 2).
- **Bluetooth permission for the companion**, not for the sample. On macOS: System Settings → Privacy & Security →
  Bluetooth, allow the Kinvent Companion (or the terminal you start it from). Without it the companion finds no
  sensor and gives no error.
- **Sensors switched on and charged**, and not connected to another app (the phone app, another computer).

You can also test without sensors: see section 10.

## 2. Install and build

In the folder of this project, with `NODE_AUTH_TOKEN` set (README section 2):

```
npm install
npm run build
node dist/cli.js --help
```

Start the installed Kinvent Companion app, if it is not running already.

The companion listens on `127.0.0.1`, port 8477. If that port is taken it uses the next free one, up to 8481.
The sample tries the five ports in order.

## 3. Two ways to run

**With questions.** Run it at a terminal without flags. It asks for the device type; then, for K-Plates,
K-Deltas and K-Deltas 3D, single sensor or pair, and jump test or normal; then the recording time in seconds.
Once the companion is connected, the floor devices also ask their sampling rate (section 6).

```
npm start
```

**With flags.** Flags answer the questions in advance. Use this for scripts.

```
npm start -- --device GRIP --seconds 10
npm start -- --device PLATES --pair --normal --seconds 30 --out ./my-recordings
```

When the input is not a terminal (a pipe, a script, CI), the sample never asks. A missing `--device` or
`--seconds` is then an error (exit 1). A pair device records the pair, a jump device records a normal test, and the
sampling rate stays as the companion has it.

`--help` lists the main flags; `--help-all` lists every flag, for scripts and special cases.

## 4. Flags

| Flag | Default | What it does | Example |
|---|---|---|---|
| `--device <TYPE>` | ask | The device type (section 5). Upper or lower case. | `--device grip` |
| `--seconds <n>` | ask | Recording time, a whole number from 1 to 3600. | `--seconds 30` |
| `--host <host>` | `127.0.0.1` | Companion host. The companion accepts loopback hosts only. | `--host localhost` |
| `--port <port>` | try 8477 to 8481 | One fixed companion port. The search is then off. | `--port 8478` |
| `--out <folder>` | `./recordings/` | Folder for the CSV file, created if missing. | `--out /tmp/rec` |
| `--connect-timeout <s>` | `60` | Seconds to wait for the sensor(s) to connect, 1 to 3600. | `--connect-timeout 120` |
| `--rate <Hz>` | the companion's setting | Sampling rate to set. Changed only if it differs. **A change disconnects every sensor.** With `--jump` on K-Deltas it is the jump rate. | `--rate 500` |
| `--include-serial` | off | Writes the device serial code into the file (the device cell of row 1). | `--include-serial` |
| `--single` | off (pair) | K-Plates, K-Deltas, K-Deltas 3D: record the **left** sensor only. | `--single` |
| `--pair` | on when not asked | K-Plates, K-Deltas, K-Deltas 3D: record the pair without asking. | `--pair` |
| `--jump` | off | K-Deltas, K-Deltas 3D, K-Plates: a jump test (section 7). | `--jump` |
| `--normal` | on when not asked | Normal test, without the jump question. Accepted for every type. | `--normal` |
| `--forget-devices` | off | K-Plates, K-Deltas, K-Deltas 3D: forget the sensors used last time (section 6) and scan afresh. | `--forget-devices` |
| `-h`, `--help` | | Prints the main flags and exits. | `--help` |
| `--help-all` | | Prints every flag and exits. | `--help-all` |

`--single` with `--pair`, or `--jump` with `--normal`, is refused (exit 1). `--single` or `--pair` with a
one-sensor type is refused. `--jump` with a one-sensor type is refused.

## 5. Supported devices

The list comes from the companion's stream descriptor: the sample records a type only when the companion
describes the name and the unit of each live value.

| Type (`--device`) | Product | Sensors | Live values |
|---|---|---|---|
| `GRIP` | K-Grip | one | `force1` … `forceN`, kg |
| `MUSCLE_TESTER` | K-Push | one | `force1` … `forceN`, kg |
| `LINK` | K-Pull | one | `force1` … `forceN`, kg |
| `BUBBLE` | K-Bubble | one | `force1`, kg (the unit the mobile app's raw CSV export gives K-Bubble) |
| `PLATES` | K-Plates | pair or one | `force1` … `force4` per plate, kg; `forceTotal` in a jump test |
| `HEXAS` | K-Deltas (classic and mini) | pair or one | `force1` … `force4` per plate, kg; `forceTotal` in a jump test |
| `DELTAS_3D` | K-Deltas 3D | pair or one | `force1`, `force2`, `force3`, `forceX1`, `forceY1`, `forceX2`, `forceY2`, `forceX3`, `forceY3` per plate, kg |

`N` is the channel count the sensor reports (one for a V3 K-Grip, for example).

**Not supported yet:** K-Myo (`EMG`), K-Power (`KPOWER`) and K-Move (`SENS`). The companion does not describe
their live values yet. `--device EMG` is refused at once.

A `HEXAS` request also accepts a K-Deltas 3D plate. The sample then says so and uses the plate's own type.

## 6. Single sensor or pair

K-Plates, K-Deltas and K-Deltas 3D come as a left and a right plate.

- **Pair (the default).** Both plates connect, and one file holds both. One start command starts both.
- **Single (`--single`).** Only the **left** plate is used. A right plate alone cannot be used.
- At a terminal, without `--single` or `--pair`, the sample asks "Use a single plate? [y/N]".
- If one plate of a pair does not connect in time, the message names the missing one. If only the right one is
  missing, it suggests `--single`.
- **The sensors used last time go first**, as the mobile app's registered devices do. After a pair is recorded, it
  is remembered per device type in `~/.kinvent-companion-sample/last-devices.json` (sensor ids and Bluetooth
  names, readable by your user only, never written into a recording) and handed to the companion as `registered`
  on the next run, so it connects them directly before any scan. A remembered sensor that does not answer is
  dropped and the next one tried; with none left the companion scans. `--forget-devices` clears the type's memory.
- **A 3D Delta may fill a K-Deltas slot**, as in the mobile app. Such a pair is recorded as it is, each device with its own channels and rate. Only sensors of the requested type are remembered.

**Sampling rate.** Once the companion is connected, the sample asks the rate for these devices, from the rates the
companion offers (the mobile app's lists: plates 75-1000 Hz, Deltas 250-1000 Hz, 3D Deltas 75-300 Hz plus 500 and
1000 Hz on a Bluetooth 5 computer), with the current one marked. Enter keeps it; `--rate` skips the question. A
K-Deltas jump test asks its **jump** rate instead (section 7).

**Calibration (zero).** The companion zeroes these devices while they connect, so the sample first says "Do not
step on the …: they are calibrated while they connect." Once they are ready it **waits until nothing moves on
them**: a short measurement watches each device's total force until it has stayed within 1 kg for one second
("Load changing on K-Plate Left. Step off the plates and keep still…" while it has not), then stops and zeroes
them again. The streamed values are relative to the zero in force, so stillness, not "0 kg", is the test; a load
that stands still is caught by the zero's own firmware check, which fails with the mobile app's words
("Calibration has failed (K-Plate Left: forces were being applied). Please step off the plates / release the
device"), after which the wait starts over, for up to 120 s in all. That check exists on firmware 2.14 or newer; the
3D Deltas never report it, so for them stillness is the only guard, and a warning
says so. Then "You can step on the plates now. The recording starts after the countdown."

Keep nothing on the devices, and nobody near them, until that line. This step runs only at a terminal, where
someone can act on it; a script (no terminal) keeps the zero the companion took at connection and is told so.

## 7. Jump test (K-Deltas, K-Deltas 3D, K-Plates)

`--jump` (or "y" to "Jump test (total force at a high rate)? [y/N]") records a jump test.

- The activity is prepared with the exercise type `JUMP_ANALYSIS`. This is the only time the sample sends an
  exercise type.
- **K-Deltas, at a terminal:** the sensors are first prepared as a normal activity and zeroed (section 6), then the
  activity is prepared again as the jump test; the companion keeps the sensors and the zero. Zero before the jump
  test starts: a zero asked for after the start fails on an empty sensor.
- **K-Deltas:** before the activity, the sample puts the companion's two ballistic rate settings (K-Deltas and
  K-Deltas XL) in the jump-protocol mode, at the jump rate you choose: at a terminal it lists the jump rates of
  both settings (500, 1000, 2000 Hz; 4000 Hz marked "K-Deltas XL only"), Enter keeping the rate only when both
  already jump at the same one; `--rate` answers it in advance; without a terminal the current rates are kept.
  Each change disconnects every sensor, so it is sent first, and only if it differs.
- When the measurement starts, the companion changes the layout. A K-Deltas then streams **one** value,
  `forceTotal` in kg, at the jump rate. The live view switches to it. The file's head is written once this layout
  is known, so its channels match the rows below.
- **K-Plates:** only `JUMP_ANALYSIS` is sent. A V3 plate keeps its four values; the file then says
  `"Mode","normal"` and `"Jump protocol","no"`.
- **K-Deltas 3D:** only `JUMP_ANALYSIS` is sent, as the mobile app does for its 3D-Deltas jumps. The plates keep their nine values and their rate; the
  sample says so.
- `--jump` is refused for one-sensor types.

## 8. What you see while it runs

1. A banner with the versions and the notice "Developer sample. Not for clinical use."
2. Connection steps: the companion found, the session claimed, "Switch on your K-Grip. Waiting for it to
   connect… (Ctrl-C to cancel, timeout 60 s)", then the sensor's states (found, connecting, initializing, ready). Other Kinvent sensors seen nearby
   are listed once.
3. The fields and their source, for example `Fields: force1 — from the companion's stream descriptor`.
4. A countdown: `Starting in 3`, `2`, `1`.
5. The live view while recording. At a terminal it is a block, redrawn about 10 times a second:

```
K-Grip (GRIP)  ·  500 Hz set (device configuration)  ·  498 Hz measured  ·  4012 samples  ·  8.0 s elapsed, 2.0 s left
  force1       12.35 kg
```

   One line per field: the name, the value with a fixed number of decimals, the unit **after** the value. A pair
   shows one block per plate. When the output is not a terminal, one plain line is printed per second instead.
   "Set" is the rate the device was configured to; "measured" is the samples of the last second.
6. At the end, the summary and the file:

```
Done. 4970 samples in 10.0 s from K-Grip (GRIP), 500.0 Hz measured; no data lost.
Saved 4970 rows to /Users/you/recordings/GRIP-20261008-101530.csv
This file contains sensor data of a person. Keep it on this computer, delete it when you no longer need it.
```

**Ctrl-C** during the recording stops cleanly: the sensor is stopped, the file gets its Summary with the end
reason `Ctrl-C`, the session is released (exit 130). A **second** Ctrl-C exits at once; the file keeps the rows
already written, without a Summary. Ctrl-C before the recording starts creates no file.

## 9. The CSV file

**Name and place.** `<DEVICE TYPE>-<yyyyMMdd-HHmmss>.csv` in local time, in `--out` (default `./recordings/`). If
the name exists, `-2`, `-3`, … is added; a file is never overwritten. No name, no serial and no device id is ever
in the file name.

**Format.** UTF-8 without BOM, `,` between cells, `\n` line ends (RFC 4180). Text cells are quoted; numbers are
not. The layout follows the Kinvent app's CSV export, so the same tools read both.

**Sections, in order** (the values below are synthetic):

```
"Kinvent Companion CLI sample 2026.9.1","Companion 2026.9.1","companion-sdk 2026.9.1","Devices:","K-Grip"
"Session Date","2026-10-08"
"Session Time","10:15:30"
"Configuration"
"Device type","GRIP"
"Recording time (sec)",2
"Sample rate set (Hz)",500
"Countdown (sec)",3
"Channels"
"Column","Field","Unit","Unit code"
"CHANNEL_1","force1","kg","KILOGRAM"

"Raw Channel Data"
"Time at time zero","10:15:33:412"
"","K-Grip"
"Time (sec)","CHANNEL_1"
0,1.250000000000000
0.002,1.500000000000000
0.004,1.750000000000000

"Summary"
"Rows",3
"Sample rate measured (Hz)",500.0
"Samples lost",0
"Gaps",0
"End reason","time end"
```

1. **Traceability row.** The sample, companion and SDK versions, and the device title(s). With
   `--include-serial`, the serial is added to the device cell.
2. **Session Date and Session Time.** Local time at the start.
3. **Configuration.** Device type, recording time, the set sample rate, the countdown. A pair with different set
   rates gets one row per plate. A pair whose right plate could not confirm its clock sync gets
   `"Time sync (<plate>)","not confirmed"`. A jump test adds `"Exercise type"`, `"Mode"` and `"Jump protocol"`.
4. **Channels.** One row per field: the column name, the field name, the unit symbol and the unit code, from the
   companion's stream descriptor. A pair adds a `"Device"` column and a `"Join"` row (see below).
5. **Raw Channel Data.** The wall-clock time of the first sample, a row with the device title(s), the header row
   `"Time (sec)","CHANNEL_1",…`, then **one row per sample**: the time in seconds from the first sample, then each
   value with 15 decimals. Values are written as the companion sends them, in the unit of the Channels section.
   No conversion, no rounding, no filtering.
6. **Summary**, written at the end:
   - `Rows`: the number of sample rows in the table.
   - `Sample rate measured (Hz)`: (rows − 1) ÷ (last time − first time), one decimal. Compare it with the set
     rate; for some V2 sensors they differ (a V2 K-Grip set to 25 Hz sends 75 Hz).
   - `Samples lost`: **counts frames, not samples.** The companion reports lost frames by their sequence numbers;
     the number of samples in a lost frame is not known.
   - `Gaps`: the number of gaps the SDK saw in the sample stream.
   - `End reason`: `time end`, `Ctrl-C`, `device lost`, `session lost`, `SIGTERM` or `error`. After a write error
     there is no Summary; the message on screen gives the reason.

**Zero columns.** The columns are the fields the descriptor lists for the channel count the sensor reports. A
V2 K-Grip reports four channels, so its file has `CHANNEL_1` to `CHANNEL_4`, and channels 2 to 4 stay at zero, as
in the app's export. A V3 K-Grip reports one.

**Pairs.** One file per pair, in the aligned version of the app's multi-device export:

```
"","K-Plate Left","","","","","K-Plate Right","","",""
"Time (sec)","CHANNEL_1","CHANNEL_2","CHANNEL_3","CHANNEL_4","","CHANNEL_1","CHANNEL_2","CHANNEL_3","CHANNEL_4"
0,1.000000000000000,…,"",1.100000000000000,…
```

- Each plate has a block of columns: a spacer (the time column for the left plate), then its `CHANNEL_1..N`.
- **Rows are joined by index, not by time stamp**, as the app's export does. Row *i* holds sample *i* of each
  plate. `Time (sec)` is the left plate's time. A shorter plate is padded with empty cells at the end.
- The Summary has `Rows` (the table) and, per plate, `Rows (<plate>)`, `Sample rate measured (Hz) (<plate>)`,
  `Samples lost (<plate>)` and `Gaps (<plate>)`, then `End reason`.

**A file cut short** (crash, second Ctrl-C, full disk) still parses up to the last complete row. It has no
Summary.

## 10. Running without sensors: the fake companion

The tests carry a fake companion (`testing/doubles/fakeCompanion.ts`). It answers the companion's routes, sends
events and synthetic sample frames, and can play failures: a refused session, a lost device, a failed zero, a
dead radio, a missing remembered sensor. It needs no Bluetooth, no sensor and no Kinvent Companion app.

```
npm test             # builds the tests, then runs them (about one minute)
```

The suite runs the whole program against the fake (one sensor, a pair, a jump test, every error case) and checks
each CSV file byte for byte. Every value is synthetic. To try the program itself on real data, you need the
Kinvent Companion app and a sensor.

## 11. Exit codes

| Code | Meaning |
|---|---|
| 0 | The recording ended at the requested time. |
| 1 | Bad flags (E10), a missing answer when the input is not a terminal, a refused `--rate`, or a refused size confirmation. |
| 2 | No companion (E1), version mismatch (E2), or Node older than 22. |
| 3 | The session is held by another app (E3, E3b). |
| 4 | The sensor could not be prepared (E4), did not connect in time (E5), or has no field layout (E11). |
| 5 | The sensor disconnected (E6) or the session was lost (E7) during the run. |
| 6 | The file could not be written (E8). |
| 70 | An unexpected error: a defect of the sample. Please report it. |
| 130 | Ctrl-C (E9), or Ctrl-D at a question. |
| 143 | SIGTERM. |

## 12. Error messages and what to do

| # | Message (start) | What to do |
|---|---|---|
| E1 | "No Kinvent Companion app found on 127.0.0.1:8477–8481." | Start the Kinvent Companion app (section 2), or pass `--port` if it runs on another port. |
| E2 | "Companion is X, this sample is built for Y. Use matching versions." | Install the Kinvent Companion app of the SDK's version (section 1), or ask Kinvent for the SDK version that matches your companion. |
| E3 | "Another app is using the sensors …" | Close the Kinvent web app tab or the other CLI, wait 5 seconds, run again. |
| E3b | (same as E3) | The previous session was still closing. Wait 5 seconds and run again. |
| E4 | "Could not prepare the <device>: <reason>." | Read the reason. Switch the sensor off and on, then run again. |
| E5 | "No <device> connected in 60 s. Is it switched on and charged? …" | Switch it on, charge it, close other apps that use it. For a pair, check the missing plate, or use `--single`. "Seen nearby" lists the Kinvent sensors the companion saw. |
| E6 | "The <device> disconnected after N s. …" | Check battery and distance. The file keeps the rows received; its End reason is `device lost`. With a pair, the other plate is stopped. |
| E7 | "Lost the companion session after N s (<reason>). …" | Another app took the sensors, or the companion stopped. The file keeps the rows received. |
| E8 | "Could not write <path>: disk full. The file is incomplete …" | Free disk space, or choose a writable `--out`. |
| E9 | "Stopped by Ctrl-C. …" | Not an error. The file has the rows up to the stop. |
| E10 | the flag error, then the usage text | Fix the flag. `--help` lists them. |
| E11 | "This Kinvent Companion version does not describe the live values of a …" or "The companion gave no field layout for this …" | Choose a supported type (section 5), or update the companion. |

A recording above 100 MB asks "Continue? [Y/n]" at a terminal. Without a terminal it is refused (exit 1); use a
shorter `--seconds`.

## 13. Data protection

A force recording of a person is **health data**, special-category personal data under GDPR. Treat every file the
sample writes as such.

- The file holds only sensor values, times, device configuration and versions. The sample never asks for a name,
  a patient or a clinician. Never add them to the file.
- The file is created with mode `0600` (only your user can read it). A new folder gets mode `0700`.
- The sample sends nothing to the internet. It talks only to the companion on `127.0.0.1`.
- `~/.kinvent-companion-sample/last-devices.json` (section 6) holds sensor ids and Bluetooth names only, with mode
  `0600`. These identify hardware, but they can become personal data once they are linked to a person or a
  session (for example "the plates used for patient X on Monday"). Treat them with care and never write them next
  to a person's details. `--forget-devices` clears a type; delete the file to clear all.
- `~/.kinvent-companion-sample/logs/cli-<date>.log` keeps a copy of each run's messages (the path is printed first),
  mode `0600`: devices, rates, calibration, errors, and the path of the recording, which includes the output
  folder — never the live values, which the log leaves out. It is what to send to support instead of a recording.
  - **The logs are not rotated or deleted by the sample.** A new file is started each day and the old ones stay.
  - **Never put a patient's name or id in a folder name** given to `--out`: the path is written into the log.
  - **To delete the logs**, delete the folder: `rm -r ~/.kinvent-companion-sample/logs` on macOS or Linux,
    `Remove-Item -Recurse "$HOME\.kinvent-companion-sample\logs"` in Windows PowerShell.
- **Keep files on this computer.** Do not attach them to tickets, chats or e-mails, and do not commit them.
  `recordings/` and `*.csv` are in this project's `.gitignore`.
- **Delete files when you no longer need them.**
- For tests, use your own hand on a test sensor, or the fake companion of the tests (section 10). Never use real
  patient recordings.
- Any use with patients needs your data-protection officer's approval first.

## 14. Troubleshooting

- **Version mismatch (E2).** The companion and the SDK must match on `major.minor.patch`. The SDK may also print
  a source-commit notice; that notice alone does not stop the run.
- **`npm install` fails with 401 or 404 for `@kinvent/companion-sdk`.** `NODE_AUTH_TOKEN` is not set, has expired,
  or has no access to the package. See README section 2, or ask Kinvent.
- **Session held (E3).** Only one client may hold the companion's session. A Kinvent web app tab counts, even in
  the background. Close it and wait 5 seconds; the companion frees a session 5 seconds after its last poll.
- **No sensor found, no error.** Almost always the macOS Bluetooth permission of the companion (section 1). Also
  check that the sensor is not connected to a phone.
- **The SDK prints a browser message on E1** ("this page's origin …"). It is the SDK's own text for browsers;
  for the sample, E1's sentence is the one that counts.
- **The measured rate differs from the set rate.** See section 9, Summary. Some firmware sends at a different rate
  than it reports.
- **A changed `--rate` disconnected my other sensors.** This is how the companion applies a rate. Use `--rate`
  only when you need another rate.

## 15. Tests

```
npm run typecheck    # the sample, the tests and the examples
npm test             # unit and integration tests against the fake companion, no sensor needed
```

On Windows, a few tests fail because they expect POSIX paths and file modes; they pass on macOS and Linux.
