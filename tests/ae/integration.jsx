// After Effects integration test. Runs inside AE:
//   "C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe" -r <repo>\tests\ae\integration.jsx
// Needs build/EDL_AE_lib.jsx (node scripts/build.mjs) and build/ae_media (tests/ae/make_media.sh).
// Everything it adds to the open project is removed again at the end.
// Results: build/ae_out/results.txt

(function () {
    var ROOT = new File($.fileName).parent.parent.parent.fsName;
    var MEDIA = ROOT + "/build/ae_media";
    var OUTDIR = new Folder(ROOT + "/build/ae_out");
    OUTDIR.create();
    var lines = [], fails = 0;
    function check(cond, msg) { lines.push((cond ? "ok   " : "FAIL ") + msg); if (!cond) { fails++; } }
    function near(a, b, tol, msg) { check(Math.abs(a - b) <= tol, msg + " (got " + a + ", expected " + b + ")"); }

    var before = {};
    for (var b = 1; b <= app.project.numItems; b++) { before[app.project.item(b).id] = true; }

    function cleanup() {
        var made = [], i;
        for (i = 1; i <= app.project.numItems; i++) {
            if (!before[app.project.item(i).id]) { made.push(app.project.item(i)); }
        }
        var order = [CompItem, FootageItem, FolderItem];
        for (var o = 0; o < order.length; o++) {
            for (i = 0; i < made.length; i++) {
                try { if (made[i] instanceof order[o]) { made[i].remove(); } } catch (e) {}
            }
        }
    }

    function writeResults() {
        var f = new File(OUTDIR.fsName + "/results.txt");
        f.encoding = "UTF-8";
        f.open("w");
        f.write(lines.join("\n") + "\n" + (fails ? fails + " FAILED" : "ALL PASSED") + "\n");
        f.close();
    }

    function importFile(path, seq) {
        var io = new ImportOptions(new File(path));
        if (seq) { io.sequence = true; io.forceAlphabetical = false; }
        var it = app.project.importFile(io);
        if (seq) { it.mainSource.conformFrameRate = 24; }
        return it;
    }

    // what a layer shows: [source name, in frame, out frame, source frame at in, stretch]
    function sig(layer, fps) {
        var src = layer.source, sfps = src.frameRate || fps;
        var st = layer.timeRemapEnabled ? layer.property("ADBE Time Remapping").valueAtTime(layer.inPoint, false)
            : (layer.inPoint - layer.startTime) * 100 / layer.stretch;
        return [src.name, Math.round(layer.inPoint * fps), Math.round(layer.outPoint * fps), Math.round(st * sfps), Math.round(layer.stretch)].join(" ");
    }

    function sigs(comp, filter) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (!L.hasVideo || !L.enabled) { continue; }
            if (filter && !filter(L)) { continue; }
            out.push(sig(L, comp.frameRate));
        }
        return out.sort();
    }

    app.beginUndoGroup("EDL AE integration test");
    try {
        $.evalFile(new File(ROOT + "/build/EDL_AE_lib.jsx"));
        var E = $.global.EDLAE_LIB;
        check(!!E && !!E.ae.exporter, "library loaded (" + (E ? E.version : "-") + ")");

        // ---- build a comp --------------------------------------------------
        var a = importFile(MEDIA + "/A001.mov"), bm = importFile(MEDIA + "/B002.mov");
        var plate = importFile(MEDIA + "/plate/plate.1001.png", true), music = importFile(MEDIA + "/music.wav");
        check(a.duration > 9.9 && a.hasAudio, "A001.mov imported with audio");
        check(Math.abs(plate.duration - 100 / 24) < 0.01, "plate imported as 100-frame sequence");

        var nest = app.project.items.addComp("T_Nest", 320, 180, 1, 4, 24);
        nest.layers.add(a);
        var comp = app.project.items.addComp("T_Main", 320, 180, 1, 10, 24);
        comp.displayStartTime = 3600;

        comp.layers.add(music);                                       // A1 0-10s
        var La = comp.layers.add(a); La.startTime = -2; La.inPoint = 0; La.outPoint = 2;   // src 2s
        var Lb = comp.layers.add(bm); Lb.stretch = 50; Lb.startTime = 3; Lb.inPoint = 3; Lb.outPoint = 5; // 200%
        var Lp = comp.layers.add(plate); Lp.startTime = 1; Lp.inPoint = 1; Lp.outPoint = 3;
        var Ln = comp.layers.add(nest); Ln.startTime = 5; Ln.inPoint = 6; Ln.outPoint = 8;  // nest at 1s
        var Lr = comp.layers.add(a); Lr.stretch = -100; Lr.startTime = 10; Lr.inPoint = 8; Lr.outPoint = 9; // reverse from 2s
        Lr.name = "rev";
        comp.markerProperty.setValueAtTime(1, new MarkerValue("hello"));
        La.property("ADBE Marker").setValueAtTime(0.5, new MarkerValue("layer note"));

        // ---- export ----------------------------------------------------------
        var tl = E.ae.exporter.compToTimeline(comp, {}, {});
        var TC = E.tc;
        check(tl.start === 86400 && tl.duration === 240, "timeline start/duration " + tl.start + "/" + tl.duration);
        var v1 = tl.video[0].clips, v2 = tl.video[1] ? tl.video[1].clips : [];
        check(v1.length === 4 && v2.length === 1, "packing: V1 " + v1.length + " clips, V2 " + v2.length);
        check(v1[0].srcIn === 86448, "A001 source TC from movie timecode: " + TC.toTC(v1[0].srcIn, TC.make(24)));
        check(v1[1].speed === 2 && v1[1].srcIn === 172800 && v1[1].recIn === 72, "B002 200% at 02:00:00:00 (" + v1[1].speed + ", " + v1[1].srcIn + ")");
        check(v1[2].nested && v1[2].srcIn === 24 && v1[2].recIn === 144, "precomp as nested, 1 s in");
        check(v1[3].speed === -1 && v1[3].srcIn === 86448, "reversed layer speed " + v1[3].speed + " src " + v1[3].srcIn);
        check(v2[0].media.sequence && v2[0].srcIn === 1001 && v2[0].recIn === 24, "plate on V2 from frame 1001");
        check(tl.audio.length === 2, "audio tracks: " + tl.audio.length);
        check(tl.markers.length === 1 && tl.markers[0].frame === 24, "comp marker");
        check(v1[0].markers.length === 1 && v1[0].markers[0].frame === 12, "layer marker relative to clip");

        // a layer only time-reversed (AE then reports inPoint > outPoint)
        var revComp = app.project.items.addComp("T_Rev", 320, 180, 1, 10, 24);
        var Lx = revComp.layers.add(a);
        Lx.stretch = -100;
        Lx.startTime = 10;
        var rt = E.ae.exporter.compToTimeline(revComp, {}, {});
        var rc = rt.video.length ? rt.video[0].clips[0] : null;
        check(rc && rc.recIn === 0 && rc.recOut === 240 && rc.speed === -1 && rc.srcIn === 86400 + 240,
            "swapped in/out of a reversed layer exported (" + (rc ? [rc.recIn, rc.recOut, rc.speed, rc.srcIn].join(",") : "none") + ")");

        var written = {};
        var fmts = [["xmeml", "xml"], ["fcpxml", "fcpxml"], ["otio", "otio"], ["edl", "edl"], ["csv", "csv"]];
        for (var f = 0; f < fmts.length; f++) {
            var files = E.formats.write(fmts[f][0], [tl], {});
            for (var k = 0; k < files.length; k++) {
                var p = OUTDIR.fsName + "/" + files[k].name + "." + fmts[f][1];
                E.ae.util.writeText(p, files[k].text);
                written[fmts[f][0] + k] = p;
            }
        }
        check(new File(written.edl0).exists && new File(written.edl1).exists, "EDL written per video track");

        // ---- import back -----------------------------------------------------
        var orig = sigs(comp);
        var cases = [["xmeml0", null], ["fcpxml0", null], ["otio0", null]];
        for (var c = 0; c < cases.length; c++) {
            var path = written[cases[c][0]];
            var parsed = E.formats.read(path, E.ae.util.readText(path), {});
            var res = E.ae.importer.run([parsed.timelines[0]], { audio: true });
            var got = sigs(res.comps[0]);
            check(got.join("|") === orig.join("|"), cases[c][0] + " round trip layers\n       got:  " + got.join(" | ") + "\n       want: " + orig.join(" | "));
            near(res.comps[0].displayStartTime, 3600, 0.001, cases[c][0] + " start TC");
            // FCPXML has no sequence markers: the V1 layer marker comes back as a comp marker too
            var wantMk = cases[c][0] === "fcpxml0" ? 2 : 1;
            check(res.comps[0].markerProperty.numKeys === wantMk, cases[c][0] + " comp markers: " + res.comps[0].markerProperty.numKeys);
            check(res.stats.missing === 0, cases[c][0] + " no missing media (" + res.notes.join("; ") + ")");
        }

        // EDL: source TC must be mapped through the movie's embedded timecode
        var edl = E.formats.read(written.edl0, E.ae.util.readText(written.edl0), { rate: TC.make(24) });
        var er = E.ae.importer.run([edl.timelines[0]], { missing: "placeholder" });
        var footageOnly = function (L) { return L.source instanceof FootageItem && L.source.file; };
        var want = sigs(comp, function (L) { return footageOnly(L) && L.source !== plate; });
        var gotE = sigs(er.comps[0], footageOnly);
        check(gotE.join("|") === want.join("|"), "EDL V1 round trip via source timecode\n       got:  " + gotE.join(" | ") + "\n       want: " + want.join(" | "));

        // fixtures with missing media -> placeholders, nothing thrown
        var fx = ["premiere.xml", "resolve.fcpxml", "sample.otio", "sample.edl"];
        for (var x = 0; x < fx.length; x++) {
            var fp = ROOT + "/tests/fixtures/" + fx[x];
            var pr = E.formats.read(fp, E.ae.util.readText(fp), { rate: TC.make(24) });
            var r2 = E.ae.importer.run([pr.timelines[0]], { searchFolder: MEDIA });
            check(r2.comps[0].numLayers > 0, fx[x] + " imported: " + r2.stats.layers + " layers, " + r2.stats.missing + " missing");
        }

        // ---- UI builds -------------------------------------------------------
        var w = new Window("palette", "EDL AE test");
        var api = E.ui.build(w, "import");
        api.select("export");
        w.layout.layout(true);
        check(w.children.length > 0, "panel UI builds");
        w.close();
    } catch (e) {
        check(false, "exception: " + e.toString() + " (line " + e.line + ")");
    } finally {
        app.endUndoGroup();
        cleanup();
        writeResults();
    }
}());
