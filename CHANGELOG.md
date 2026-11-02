# Changelog

All notable changes to EDL AE are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

Every change that users would notice goes under `[Unreleased]` in the same commit. When cutting a release, rename that section to the new version and date, bump `version` in `package.json`, and start a fresh `[Unreleased]` section. The README's "Releasing" section lists the full steps.

## [Unreleased]

## [0.1.0] - 2026-11-02

First release.

### Added

- ScriptUI panel `EDL_AE.jsx` with Export and Import tabs. It docks from the Window menu, or runs as a floating window from *File > Scripts > Run Script File*.
- Export one or more comps to CMX 3600 EDL, Final Cut Pro 7 XML, FCPXML 1.8, OpenTimelineIO or a CSV shot list. Several comps can go to one file (XML, FCPXML, OTIO) or one file each.
- Import EDL, FCP 7 XML, FCPXML 1.3 to 1.11 and OpenTimelineIO. The panel lists every sequence in the file so you pick which ones to build, as new comps or into an existing comp.
- Carried in both directions: cuts and gaps, track stacking, source timecode, constant speed and reverse, precomps as nested sequences or compound clips, comp and layer markers, disabled clips, image sequences with frame numbers as timecode.
- Dissolves import as opacity fades. Fades to and from black are included.
- Source timecode is read from the media's XMP metadata (`startTimecode`, or `altTimecode` for QuickTime timecode tracks) when the timeline file doesn't state it.
- Export options: whole comp or work area, layers packed into tracks or one track per layer, audio, disabled layers, solids/text/shapes as offline clips, reel names for EDL (tape, file, layer name or AX, optionally 8 characters).
- Import media lookup: paths from the file, a search folder (matched by file name, clip name, reel or image sequence prefix), then footage already in the project. Missing media becomes a placeholder, a solid, or is skipped. A report lists what was missing or trimmed.
- Linked video and audio clips import as one layer with audio on. Audio-only clips get their own layers under the picture.
- `EdlAE.aex`, an AEGP plugin built against the After Effects SDK. It adds *File > Import > EDL / XML / OTIO...*, *File > Export > EDL / XML / OTIO...* and *Window > EDL AE*, all running the same panel compiled into the plugin. Windows x64 only, and not yet tested inside After Effects.
- `scripts/install.ps1` installs the panel into the per-user Scripts folder (no admin), and with `-Plugin` also installs the plugin.
- Tests: ES3 parse check and scope lint for every source file, a Node suite with fixtures and write/read round trips for each format, cross-checks against OpenTimelineIO's adapters, and an integration test that runs inside After Effects.

### Known limitations

- Effects, transforms, audio levels and titles are not exported. Generators import as grey solids.
- Keyframed time remapping exports at its average speed, with a note in the export report.
- FCPXML has no sequence-level markers. Comp markers attach to the clip or gap under them, and on import all markers on the primary storyline become comp markers.
- The native plugin builds on Windows only.

[Unreleased]: https://github.com/njlent/edl_ae/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/njlent/edl_ae/releases/tag/v0.1.0
