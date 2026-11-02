"""Cross-validation against OpenTimelineIO's adapters (independent implementations).

  python tests/xval/otio_check.py build/xval

1. Reads our files (ours.*) with OTIO and prints what OTIO sees, per track.
2. Writes an OTIO-authored timeline with each adapter (theirs.*) plus the
   expected clip list (theirs_expected.json) for tests/xval/compare.mjs.

Needs: pip install opentimelineio otio-cmx3600-adapter otio-fcp-adapter otio-fcpx-xml-adapter
"""
import json
import os
import sys

import opentimelineio as otio

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "build/xval")
RT = otio.opentime.RationalTime
TR = otio.opentime.TimeRange


def speed_of(item):
    for e in item.effects:
        if isinstance(e, otio.schema.LinearTimeWarp):
            return round(e.time_scalar, 3)
    return 1


def url_of(item):
    ref = getattr(item, "media_reference", None)
    return getattr(ref, "target_url", "") if ref is not None else ""


def summarize(tl):
    rate = tl.global_start_time.rate if tl.global_start_time else 24
    out = {"start": tl.global_start_time.value if tl.global_start_time else 0, "rate": rate, "tracks": {}}
    counts = {"Video": 0, "Audio": 0}
    for track in tl.tracks:
        counts[track.kind] = counts.get(track.kind, 0) + 1
        key = ("V" if track.kind == "Video" else "A") + str(counts[track.kind])
        rows = []
        for item in track:
            if isinstance(item, (otio.schema.Gap, otio.schema.Transition)):
                continue
            r = item.range_in_parent()
            src = item.trimmed_range().start_time
            rows.append({
                "name": item.name,
                "rec": [round(r.start_time.rescaled_to(rate).value), round(r.end_time_exclusive().rescaled_to(rate).value)],
                "src": round(src.value),
                "speed": speed_of(item),
                "url": url_of(item),
                "type": type(item).__name__,
            })
        if rows:
            out["tracks"][key] = rows
    out["markers"] = [[m.name, round(m.marked_range.start_time.rescaled_to(rate).value)] for m in tl.tracks.markers]
    return out


def read_ours():
    result = {}
    for name in sorted(os.listdir(OUT)):
        if not name.startswith("ours") or name.endswith(".json"):
            continue
        path = os.path.join(OUT, name)
        try:
            kw = {"rate": 24} if name.endswith(".edl") else {}
            tl = otio.adapters.read_from_file(path, **kw)
            if isinstance(tl, otio.schema.SerializableCollection):
                tl = next(iter(tl.find_children(descended_from_type=otio.schema.Timeline) or tl))
            result[name] = summarize(tl)
        except Exception as e:  # report and continue
            result[name] = {"error": "%s: %s" % (type(e).__name__, e)}
    with open(os.path.join(OUT, "ours_read_by_otio.json"), "w") as f:
        json.dump(result, f, indent=1)
    return result


def ext_ref(path, start, dur, rate):
    return otio.schema.ExternalReference(
        target_url="file:///" + path.replace("\\", "/").replace(" ", "%20"),
        available_range=TR(RT(start, rate), RT(dur, rate)),
    )


def clip(name, path, src, dur, rate, avail_start, avail_dur):
    return otio.schema.Clip(
        name=name,
        media_reference=ext_ref(path, avail_start, avail_dur, rate),
        source_range=TR(RT(src, rate), RT(dur, rate)),
    )


def write_theirs():
    rate = 24000 / 1001
    tl = otio.schema.Timeline(name="Theirs", global_start_time=RT(86400, rate))
    v1 = otio.schema.Track(name="V1", kind=otio.schema.TrackKind.Video)
    v1.append(clip("a", "C:/media/a.mov", 86410, 48, rate, 86400, 2400))
    v1.append(otio.schema.Gap(source_range=TR(RT(0, rate), RT(12, rate))))
    v1.append(clip("b", "C:/media/b clip.mov", 100, 60, rate, 0, 1000))
    v2 = otio.schema.Track(name="V2", kind=otio.schema.TrackKind.Video)
    v2.append(otio.schema.Gap(source_range=TR(RT(0, rate), RT(30, rate))))
    v2.append(clip("c", "C:/media/c.mov", 1010, 40, rate, 1000, 100))
    tl.tracks.append(v1)
    tl.tracks.append(v2)
    tl.tracks.markers.append(otio.schema.Marker(name="m1", marked_range=TR(RT(24, rate), RT(0, rate))))

    expected = {"start": 86400, "V1": [["a", 0, 48, 86410], ["b", 60, 120, 100]], "V2": [["c", 30, 70, 1010]]}
    errors = {}
    for adapter, ext in [("otio_json", "otio"), ("fcp_xml", "xml"), ("fcpx_xml", "fcpxml"), ("cmx_3600", "edl")]:
        try:
            src = tl
            if adapter == "cmx_3600":
                src = otio.schema.Timeline(name="Theirs", global_start_time=RT(86400, rate))
                src.tracks.append(v1.deepcopy())  # CMX holds one picture track
            otio.adapters.write_to_file(src, os.path.join(OUT, "theirs." + ext), adapter_name=adapter)
        except Exception as e:
            errors[adapter] = "%s: %s" % (type(e).__name__, e)
    with open(os.path.join(OUT, "theirs_expected.json"), "w") as f:
        json.dump({"expected": expected, "write_errors": errors}, f, indent=1)
    return errors


if __name__ == "__main__":
    ours = read_ours()
    print(json.dumps(ours, indent=1))
    errs = write_theirs()
    print("theirs write errors:", errs or "none")
