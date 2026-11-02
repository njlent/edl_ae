# EDL AE

Import and export edit decision lists in After Effects. Pick the comps you want and write them out as an EDL, FCP 7 XML, FCPXML or OpenTimelineIO file. Or open one of those files, choose which sequences in it to bring in, and get comps with the layers cut, retimed and stacked the way the editor left them.

Windows is the tested platform (After Effects 2026). The script itself is plain ExtendScript and should run on macOS too, but the native plugin build is Windows only for now.

## Formats

| Format | Extension | Import | Export |
| --- | --- | --- | --- |
| CMX 3600 EDL | `.edl` | yes | yes, one file per video track |
| Final Cut Pro 7 XML (xmeml) | `.xml` | yes | yes |
| FCPXML (FCP X, DaVinci Resolve) | `.fcpxml` | 1.3 to 1.11 | 1.8 |
| OpenTimelineIO | `.otio` | yes | yes |
| CSV shot list | `.csv` | no | yes |

What carries across:

- cuts, gaps and track stacking
- source timecode (from the file, or read from the media's embedded timecode)
- constant speed changes and reverse (M2, Time Remap filter, timeMap, LinearTimeWarp)
- nested sequences, compound clips and precomps
- dissolves (imported as opacity fades)
- comp, sequence and clip markers
- disabled clips and tracks
- image sequences, using frame numbers as timecode

Things that don't: effects, transforms, keyframed speed ramps (exported at their average speed, with a note), titles and generators beyond a grey solid, and audio levels.

## Using it

The panel has two tabs.

**Export.** Select one or more comps in the list (or press *Selected* to take the Project panel selection), pick a format and press *Export*. One comp opens a save dialog. Several comps ask for a folder, unless *One file for all selected comps* is on, in which case XML, FCPXML and OTIO write a single file holding every sequence.

- *Pack layers* puts non-overlapping layers on a shared track and keeps the stacking order. *One per layer* gives every layer its own track.
- *Precomps as nested sequences* writes precomps as nested sequences or compound clips. Turn it off to export a precomp as a single clip named after the comp.
- *Source TC from media* reads the start timecode embedded in QuickTime, MXF and similar files (XMP `startTimecode`). Without it, sources start at 00:00:00:00.
- The EDL options pick where reel names come from and can limit them to 8 characters for strict CMX readers.

**Import.** Browse to a file. The list shows every sequence in it, so you can import one, some or all. EDLs don't store a frame rate or frame size, so set those for EDL files. *Into* builds a new comp per sequence by default, or puts a single sequence into an existing comp.

Media is found in this order:

1. the path stored in the file
2. the search folder, matched by file name, clip name, reel name or image sequence prefix
3. footage already in the project with the same name

Anything still missing becomes a placeholder (or a solid, or is skipped) that you can relink with *Replace Footage*. Imported items go into a project folder named `EDL AE - <sequence>`.

Video clips with linked audio clips become one layer with audio on. Audio-only clips get their own layers, video switched off, below the picture.

## Install

Build the script first (Node.js 18 or newer):

```
npm install
npm run build
```

Then install the panel. This copies `dist/EDL_AE.jsx` into your per-user Scripts folder, so it doesn't need admin rights:

```
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Restart After Effects and open **Window > EDL_AE.jsx**. In *Preferences > Scripting & Expressions*, turn on *Allow Scripts to Write Files and Access Network*, otherwise export can't write files.

You can also skip the installer: copy `dist/EDL_AE.jsx` to `C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\`, or run it once with *File > Scripts > Run Script File*.

### Native plugin (optional)

`EdlAE.aex` is a small AEGP plugin built against the After Effects SDK. It adds *File > Import > EDL / XML / OTIO...*, *File > Export > EDL / XML / OTIO...* and *Window > EDL AE*. Each one opens the same panel, as a floating window, on the right tab. The script is compiled into the plugin, so there is only one file to install.

You need Visual Studio 2022 (C++ workload), CMake 3.20+ and the After Effects SDK from the Adobe Developer Console:

```
cmake -S plugin -B plugin/build -DAE_SDK_ROOT=E:/projects/ae/SDK/AfterEffectsSDK_25.6_61_win
cmake --build plugin/build --config Release
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Plugin
```

The build rebundles the script when Node is on the PATH. The installer copies the plugin to `Support Files\Plug-ins\EDL AE\`, which needs admin rights. It will ask.

## How timing maps

A layer becomes a clip covering its in to out point. The source frame at the in point comes from the layer's start time and stretch, or from its Time Remap value when remapping is on. Stretch becomes speed (50% stretch is 200% speed, -100% is reverse). The comp's start timecode becomes the record start.

On import it runs the other way. Stretch is 100 / speed, the start time is set so the first source frame lands on the record in point, and in and out are set to the record range. If a clip asks for frames beyond the end of the media, After Effects trims the layer. The import report lists every clip where that happened.

Some format quirks worth knowing:

- CMX allows one picture track, so a comp with three video tracks exports `name_V1.edl`, `name_V2.edl` and `name_V3.edl`. Audio events go in the first file.
- For forward speed changes the EDL source out is the source range actually used, plus an M2 line. Some readers, OpenTimelineIO included, only look at M2 when source and record lengths differ.
- FCPXML has no sequence-level markers, so comp markers attach to whatever clip or gap sits under them. On import, every marker on the primary storyline becomes a comp marker.
- In FCPXML, a video clip carries its own audio. Audio-track clips are only written for audio-only media or audio that isn't linked to a video clip.

## Releasing

Changes are tracked in [CHANGELOG.md](CHANGELOG.md). Every user-visible change adds a line under `[Unreleased]` in the same commit. To cut a release:

1. Move the `[Unreleased]` entries into a new `## [x.y.z] - YYYY-MM-DD` section, leave an empty `[Unreleased]` above it and update the compare links at the bottom.
2. Set `version` in `package.json` to `x.y.z`. The bundle and the panel's status line read it from there.
3. `npm test`, then build the plugin (`cmake --build plugin/build --config Release`).
4. Commit, tag `vx.y.z`, push with `--follow-tags`.
5. `gh release create vx.y.z dist/EDL_AE.jsx plugin/build/Release/EdlAE.aex --title "EDL AE x.y.z" --notes-file <that version's changelog section>`

## Development

```
src/core/   formats and the shared timeline model (no After Effects calls)
src/ae/     comp <-> timeline conversion, media lookup, the ScriptUI panel
scripts/    build.mjs bundles src/ into dist/EDL_AE.jsx, install.ps1
plugin/     EdlAE.aex AEGP (C++, CMake)
tests/      Node tests, OTIO cross-checks, After Effects integration test
```

`npm test` builds the bundle and runs the Node suite. It parses every source file as ES3 and lints for implicit globals and loop counters shared across closures. It then runs the format code in a VM context with the ES5 built-ins ExtendScript lacks deleted, and checks fixtures and write/read round trips for every format.

`tests/xval/` checks the formats against OpenTimelineIO's own adapters, which share no code with this project. It needs Python:

```
python -m venv build/.venv
build/.venv/Scripts/python -m pip install opentimelineio otio-cmx3600-adapter otio-fcp-adapter otio-fcpx-xml-adapter
node tests/xval/dump.mjs build/xval
build/.venv/Scripts/python tests/xval/otio_check.py build/xval
node tests/xval/compare.mjs build/xval
```

`tests/ae/integration.jsx` runs inside After Effects. It imports generated media (`bash tests/ae/make_media.sh`, needs ffmpeg) and builds a comp with stretched, reversed, nested and image sequence layers. It exports that comp to every format, imports each file back and compares the layers. It also builds the panel UI. Everything it adds to the open project is removed at the end, and results go to `build/ae_out/results.txt`.

```
"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe" -r E:\projects\ae\edl_ae\tests\ae\integration.jsx
```
