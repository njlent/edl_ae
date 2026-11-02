// ScriptUI panel / palette with Export and Import tabs.

EDLAE.ui = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model, A = EDLAE.ae.util, R = EDLAE.formats;
    var UI = {};

    var RATE_CHOICES = ["23.976", "24", "25", "29.97 NDF", "29.97 DF", "30", "47.952", "48", "50", "59.94 NDF", "59.94 DF", "60"];

    function rateFromChoice(s) {
        var drop = / DF$/.test(s);
        return TC.fromFps(parseFloat(s), drop);
    }

    function cb(parent, label, key, dflt, tip) {
        var c = parent.add("checkbox", undefined, label);
        c.value = A.getBool(key, dflt);
        if (tip) { c.helpTip = tip; }
        c.onClick = function () { A.setSetting(key, c.value); };
        return c;
    }

    function dd(parent, items, key, dflt) {
        var d = parent.add("dropdownlist", undefined, items);
        var idx = U.toInt(A.getSetting(key, String(dflt)), dflt);
        d.selection = idx >= 0 && idx < items.length ? idx : dflt;
        d.onChange = function () { if (d.selection) { A.setSetting(key, d.selection.index); } };
        return d;
    }

    function row(parent) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["left", "center"];
        g.alignment = ["fill", "top"];
        g.spacing = 6;
        return g;
    }

    function col(parent) {
        var g = parent.add("group");
        g.orientation = "column";
        g.alignChildren = ["fill", "top"];
        g.spacing = 3;
        return g;
    }

    function panel(parent, title) {
        var p = parent.add("panel", undefined, title);
        p.orientation = "column";
        p.alignChildren = ["fill", "top"];
        p.alignment = ["fill", "top"];
        p.margins = [8, 12, 8, 6];
        p.spacing = 4;
        return p;
    }

    function showReport(title, lines) {
        var w = new Window("dialog", title, undefined, { resizeable: true });
        w.orientation = "column";
        w.alignChildren = ["fill", "fill"];
        var t = w.add("edittext", undefined, lines.join("\n"), { multiline: true, scrolling: true, readonly: true });
        t.preferredSize = [560, 280];
        var b = w.add("button", undefined, "OK", { name: "ok" });
        b.alignment = ["right", "bottom"];
        w.onResizing = w.onResize = function () { this.layout.resize(); };
        w.show();
    }

    function fail(e) {
        alert("EDL AE\n\n" + (e && e.message ? e.message : String(e)) + (e && e.line ? "\n(line " + e.line + ")" : ""));
    }

    // ---- export tab ---------------------------------------------------------

    function buildExport(tab, status) {
        var top = row(tab);
        top.add("statictext", undefined, "Compositions:");
        var spacer = top.add("group");
        spacer.alignment = ["fill", "center"];
        var bSel = top.add("button", undefined, "Selected");
        bSel.helpTip = "Select the comps selected in the Project panel (or the active comp).";
        var bRef = top.add("button", undefined, "Refresh");
        bSel.preferredSize.width = bRef.preferredSize.width = 70;

        var list = tab.add("listbox", undefined, [], {
            multiselect: true, numberOfColumns: 4, showHeaders: true,
            columnTitles: ["Name", "Size", "fps", "Duration"], columnWidths: [190, 80, 60, 80]
        });
        list.alignment = ["fill", "fill"];
        list.preferredSize = [420, 150];

        var fmts = R.writable();
        var fr = row(tab);
        fr.add("statictext", undefined, "Format:");
        var fmtDD = dd(fr, U.map(fmts, function (f) { return f.label; }), "exp_format", 1);
        fmtDD.alignment = ["fill", "center"];

        var po = panel(tab, "Options");
        var r1 = row(po);
        r1.add("statictext", undefined, "Range:");
        var rangeDD = dd(r1, ["Whole comp", "Work area"], "exp_range", 0);
        r1.add("statictext", undefined, "Tracks:");
        var trackDD = dd(r1, ["Pack layers", "One per layer"], "exp_tracks", 0);
        trackDD.helpTip = "Pack: non-overlapping layers share a track, stacking order is kept.\nOne per layer: every layer gets its own track.";

        var two = row(po);
        two.alignChildren = ["fill", "top"];
        var c1 = col(two), c2 = col(two);
        var oAudio = cb(c1, "Audio", "exp_audio", true);
        var oMarkers = cb(c1, "Markers", "exp_markers", true, "Comp markers and layer markers.");
        var oDisabled = cb(c1, "Disabled layers", "exp_disabled", false);
        var oGen = cb(c1, "Solids, text, shapes", "exp_generators", false, "Export layers without media as offline clips.");
        var oNested = cb(c2, "Precomps as nested sequences", "exp_nested", true,
            "On: precomps become nested sequences / compound clips.\nOff: a precomp is exported as a single clip named after the comp.");
        var oTC = cb(c2, "Source TC from media (XMP)", "exp_readtc", true, "Read the start timecode embedded in movie files.");
        var oSeqTC = cb(c2, "Frame numbers as TC (sequences)", "exp_seqtc", true, "Image sequence frame 1001 = source timecode frame 1001.");
        var oCombine = cb(c2, "One file for all selected comps", "exp_combine", false, "XML, FCPXML and OTIO only.");

        var pe = panel(tab, "EDL");
        var r2 = row(pe);
        r2.add("statictext", undefined, "Reel:");
        var reelDD = dd(r2, ["Tape name or file name", "File name", "Layer name", "AX"], "exp_reel", 0);
        var oReel8 = cb(r2, "8 chars", "exp_reel8", false, "Strict CMX 3600: reel names up to 8 characters.");
        var oSrcFile = cb(r2, "Source file comments", "exp_srcfile", true);

        var br = row(tab);
        br.alignment = ["fill", "bottom"];
        var bExport = br.add("button", undefined, "Export...");
        bExport.alignment = ["right", "center"];

        function refresh(selectIds) {
            list.removeAll();
            var comps = A.comps();
            for (var i = 0; i < comps.length; i++) {
                var lb = A.compLabel(comps[i]);
                var it = list.add("item", comps[i].name);
                it.subItems[0].text = lb.size;
                it.subItems[1].text = lb.fps;
                it.subItems[2].text = lb.duration;
                it.compId = comps[i].id;
                if (selectIds && selectIds[comps[i].id]) { it.selected = true; }
            }
        }

        function selectFromProject() {
            var ids = {}, any = false, sel = app.project.selection;
            for (var i = 0; i < sel.length; i++) { if (sel[i] instanceof CompItem) { ids[sel[i].id] = true; any = true; } }
            if (!any && app.project.activeItem instanceof CompItem) { ids[app.project.activeItem.id] = true; }
            refresh(ids);
        }

        function selectedComps() {
            var out = [], sel = list.selection || [];
            if (!(sel instanceof Array)) { sel = [sel]; }
            for (var i = 0; i < sel.length; i++) {
                var c = A.itemById(sel[i].compId);
                if (c) { out.push(c); }
            }
            return out;
        }

        function options() {
            return {
                workArea: rangeDD.selection.index === 1,
                trackMode: trackDD.selection.index === 1 ? "layers" : "pack",
                audio: oAudio.value, markers: oMarkers.value, includeDisabled: oDisabled.value,
                generators: oGen.value, nested: oNested.value, readTC: oTC.value, seqFrameTC: oSeqTC.value,
                combine: oCombine.value,
                reelMode: ["tape", "file", "name", "ax"][reelDD.selection.index], reel8: oReel8.value,
                sourceFile: oSrcFile.value, includeAudio: oAudio.value
            };
        }

        function doExport() {
            var comps = selectedComps();
            if (!comps.length) { alert("Select one or more compositions to export."); return; }
            var fmt = fmts[fmtDD.selection.index], opts = options(), ctx = {}, tls = [], i;
            status.text = "Reading " + comps.length + " comp(s)...";
            for (i = 0; i < comps.length; i++) { tls.push(EDLAE.ae.exporter.compToTimeline(comps[i], opts, ctx)); }
            opts.combinedName = comps[0].name;
            if (comps.length > 1) {
                opts.combinedName = app.project.file ? U.stripExt(File.decode(app.project.file.name)) : "EDL AE Export";
            }
            var files = R.write(fmt.id, tls, opts);
            if (!files.length) { status.text = "Nothing to export."; return; }

            var lastDir = A.getSetting("exp_dir", Folder.myDocuments.fsName), written = [];
            var filter = A.isWin ? fmt.label.replace(/\s*\(.*\)$/, "") + ":*." + fmt.ext + ",All files:*.*" : undefined;
            if (comps.length === 1 || (opts.combine && fmt.combinable)) {
                var base = U.safeFileName(files[0].name);
                var target = new File(lastDir + "/" + base + "." + fmt.ext).saveDlg("Export " + fmt.label, filter);
                if (!target) { status.text = "Cancelled."; return; }
                var path = target.fsName;
                if (U.ext(path) !== fmt.ext) { path += "." + fmt.ext; }
                var dir = U.dirname(U.normSlashes(path)), chosen = U.stripExt(path);
                A.setSetting("exp_dir", dir);
                for (i = 0; i < files.length; i++) {
                    // one comp, several EDLs (one per video track): keep the _V1/_V2 suffixes
                    var suffix = files.length > 1 ? files[i].name.substring(tls[0].name.length) : "";
                    var p = files.length === 1 ? path : dir + "/" + chosen + suffix + "." + fmt.ext;
                    written.push(A.writeText(p, files[i].text).fsName);
                }
            } else {
                var folder = new Folder(lastDir).selectDlg("Export " + comps.length + " comps as " + fmt.label + " to folder:");
                if (!folder) { status.text = "Cancelled."; return; }
                A.setSetting("exp_dir", folder.fsName);
                var existing = [];
                for (i = 0; i < files.length; i++) {
                    if (new File(folder.fsName + "/" + U.safeFileName(files[i].name) + "." + fmt.ext).exists) { existing.push(files[i].name); }
                }
                if (existing.length && !confirm(existing.length + " file(s) already exist and will be overwritten. Continue?")) {
                    status.text = "Cancelled.";
                    return;
                }
                for (i = 0; i < files.length; i++) {
                    written.push(A.writeText(folder.fsName + "/" + U.safeFileName(files[i].name) + "." + fmt.ext, files[i].text).fsName);
                }
            }
            var clips = 0;
            for (i = 0; i < tls.length; i++) { clips += M.clipCount(tls[i]); }
            status.text = "Exported " + written.length + " file(s), " + clips + " clips.";
            if (ctx.notes && ctx.notes.length) {
                showReport("EDL AE - Export", ["Written:"].concat(written).concat(["", "Notes:"]).concat(ctx.notes));
            }
        }

        bRef.onClick = function () { try { refresh(null); } catch (e) { fail(e); } };
        bSel.onClick = function () { try { selectFromProject(); } catch (e) { fail(e); } };
        bExport.onClick = function () { try { doExport(); } catch (e) { fail(e); status.text = "Export failed."; } };
        list.onDoubleClick = bExport.onClick;
        selectFromProject();
        return { refresh: function () { selectFromProject(); } };
    }

    // ---- import tab ---------------------------------------------------------

    function buildImport(tab, status) {
        var fr = row(tab);
        fr.add("statictext", undefined, "File:");
        var pathEt = fr.add("edittext", undefined, A.getSetting("imp_file", ""));
        pathEt.alignment = ["fill", "center"];
        pathEt.preferredSize.width = 260;
        var bBrowse = fr.add("button", undefined, "Browse...");

        var info = tab.add("statictext", undefined, "Choose an EDL, FCP 7 XML, FCPXML or OTIO file.", { truncate: "end" });
        info.alignment = ["fill", "top"];

        var edlRow = row(tab);
        edlRow.add("statictext", undefined, "EDL rate:");
        var rateDD = dd(edlRow, RATE_CHOICES, "imp_edlrate", 1);
        edlRow.add("statictext", undefined, "Size:");
        var wEt = edlRow.add("edittext", undefined, A.getSetting("imp_w", "1920"));
        edlRow.add("statictext", undefined, "x");
        var hEt = edlRow.add("edittext", undefined, A.getSetting("imp_h", "1080"));
        wEt.characters = hEt.characters = 5;

        tab.add("statictext", undefined, "Sequences in file:");
        var list = tab.add("listbox", undefined, [], {
            multiselect: true, numberOfColumns: 5, showHeaders: true,
            columnTitles: ["Name", "fps", "Tracks", "Clips", "Duration"], columnWidths: [180, 60, 60, 50, 80]
        });
        list.alignment = ["fill", "fill"];
        list.preferredSize = [420, 110];

        var tr = row(tab);
        tr.add("statictext", undefined, "Into:");
        var targetDD = tr.add("dropdownlist", undefined, ["New composition"]);
        targetDD.selection = 0;
        targetDD.alignment = ["fill", "center"];

        var pm = panel(tab, "Media");
        var oPaths = cb(pm, "Use file paths from the timeline", "imp_paths", true);
        var sr = row(pm);
        sr.add("statictext", undefined, "Search folder:");
        var searchEt = sr.add("edittext", undefined, A.getSetting("imp_search", ""));
        searchEt.alignment = ["fill", "center"];
        searchEt.helpTip = "Optional. Searched recursively for media by file name, clip name or reel.";
        var bSearch = sr.add("button", undefined, "...");
        bSearch.preferredSize.width = 30;
        var mr = row(pm);
        var oReuse = cb(mr, "Reuse project footage", "imp_reuse", true);
        mr.add("statictext", undefined, "Missing:");
        var missDD = dd(mr, ["Placeholder", "Solid", "Skip"], "imp_missing", 0);
        var oTC = cb(pm, "Source TC from media (XMP) when the file doesn't say", "imp_readtc", true);

        var po = panel(tab, "Options");
        var orow = row(po);
        var oAudio = cb(orow, "Audio", "imp_audio", true);
        var oMarkers = cb(orow, "Markers", "imp_markers", true);
        var oFades = cb(orow, "Dissolves as fades", "imp_fades", true);
        var oDisabled = cb(orow, "Disabled clips", "imp_disabled", true);

        var br = row(tab);
        br.alignment = ["fill", "bottom"];
        var bImport = br.add("button", undefined, "Import");
        bImport.alignment = ["right", "center"];

        var parsed = null, compIds = [];

        function refreshTargets() {
            var keep = targetDD.selection ? targetDD.selection.index : 0;
            targetDD.removeAll();
            targetDD.add("item", "New composition");
            compIds = [];
            var comps = A.comps();
            for (var i = 0; i < comps.length; i++) {
                targetDD.add("item", comps[i].name);
                compIds.push(comps[i].id);
            }
            targetDD.selection = keep < targetDD.items.length ? keep : 0;
        }

        function parseOpts() {
            return {
                rate: rateFromChoice(rateDD.selection.text),
                width: U.toInt(wEt.text, 1920), height: U.toInt(hEt.text, 1080)
            };
        }

        function load() {
            list.removeAll();
            parsed = null;
            var path = U.trim(pathEt.text);
            if (!path) { info.text = "Choose a file."; return; }
            var text = A.readText(path);
            parsed = R.read(path, text, parseOpts());
            A.setSetting("imp_file", path);
            var isEdl = parsed.format.id === "edl";
            edlRow.enabled = isEdl;
            for (var i = 0; i < parsed.timelines.length; i++) {
                var tl = parsed.timelines[i];
                var it = list.add("item", tl.name);
                it.subItems[0].text = TC.label(tl.rate);
                it.subItems[1].text = tl.video.length + "V " + tl.audio.length + "A";
                it.subItems[2].text = String(M.clipCount(tl));
                it.subItems[3].text = TC.toTC(tl.duration, TC.make(tl.rate.base, false, false));
                it.tlIndex = i;
            }
            if (list.items.length) { list.items[0].selected = true; }
            info.text = parsed.format.label + " - " + parsed.timelines.length + " sequence(s)" +
                (isEdl ? ", start " + TC.toTC(parsed.timelines[0].start, parsed.timelines[0].rate) : "");
            if (parsed.timelines.length === 1) { list.selection = 0; }
        }

        function safeLoad() {
            try { load(); status.text = ""; } catch (e) { parsed = null; info.text = "Could not read file."; fail(e); }
        }

        function doImport() {
            if (!parsed) { safeLoad(); }
            if (!parsed) { return; }
            var sel = list.selection || [];
            if (!(sel instanceof Array)) { sel = [sel]; }
            if (!sel.length) { alert("Select one or more sequences to import."); return; }
            var tls = [], i;
            for (i = 0; i < sel.length; i++) { tls.push(parsed.timelines[sel[i].tlIndex]); }
            var target = null;
            if (targetDD.selection && targetDD.selection.index > 0) {
                target = A.itemById(compIds[targetDD.selection.index - 1]);
                if (tls.length > 1) { alert("Importing into an existing comp works with one sequence at a time."); return; }
            }
            A.setSetting("imp_search", searchEt.text);
            A.setSetting("imp_w", wEt.text);
            A.setSetting("imp_h", hEt.text);
            var opts = {
                targetComp: target, usePaths: oPaths.value, searchFolder: U.trim(searchEt.text),
                reuseProject: oReuse.value, missing: ["placeholder", "solid", "skip"][missDD.selection.index],
                readTC: oTC.value, seqFrameTC: true, audio: oAudio.value, markers: oMarkers.value,
                fades: oFades.value, disabled: oDisabled.value, generators: true
            };
            status.text = "Importing...";
            app.beginUndoGroup("EDL AE Import");
            var res;
            try { res = EDLAE.ae.importer.run(tls, opts); }
            finally { app.endUndoGroup(); }
            var s = res.stats;
            status.text = "Created " + s.comps + " comp(s), " + s.layers + " layers; " + s.imported + " imported, " +
                s.reused + " reused, " + s.missing + " missing.";
            if (res.comps.length) {
                try { res.comps[0].openInViewer(); } catch (e) {}
            }
            refreshTargets();
            var notes = parsed.notes.concat(res.notes);
            if (notes.length) { showReport("EDL AE - Import", [status.text, ""].concat(notes)); }
        }

        bBrowse.onClick = function () {
            var filter = A.isWin ? "Timelines:*.edl;*.xml;*.fcpxml;*.otio,All files:*.*" : undefined;
            var start = U.trim(pathEt.text) ? new File(pathEt.text) : new File(Folder.myDocuments.fsName + "/x");
            var f = start.openDlg("Choose a timeline file", filter, false);
            if (f) { pathEt.text = f.fsName; safeLoad(); }
        };
        bSearch.onClick = function () {
            var f = new Folder(U.trim(searchEt.text) || Folder.myDocuments.fsName).selectDlg("Search folder for media");
            if (f) { searchEt.text = f.fsName; A.setSetting("imp_search", f.fsName); }
        };
        pathEt.onChange = safeLoad;
        rateDD.onChange = function () { A.setSetting("imp_edlrate", rateDD.selection.index); if (parsed && parsed.format.id === "edl") { safeLoad(); } };
        wEt.onChange = hEt.onChange = function () { if (parsed && parsed.format.id === "edl") { safeLoad(); } };
        bImport.onClick = function () { try { doImport(); } catch (e) { fail(e); status.text = "Import failed."; } };
        list.onDoubleClick = bImport.onClick;

        refreshTargets();
        edlRow.enabled = true;
        if (U.trim(pathEt.text) && new File(pathEt.text).exists) { try { load(); } catch (e2) { parsed = null; } }
        return { refresh: refreshTargets };
    }

    // ---- assembly -----------------------------------------------------------

    UI.build = function (w, initialTab) {
        w.orientation = "column";
        w.alignChildren = ["fill", "fill"];
        w.spacing = 4;
        w.margins = 6;
        var tabs = w.add("tabbedpanel");
        tabs.alignChildren = ["fill", "fill"];
        tabs.alignment = ["fill", "fill"];
        var tExp = tabs.add("tab", undefined, "Export");
        var tImp = tabs.add("tab", undefined, "Import");
        tExp.orientation = tImp.orientation = "column";
        tExp.alignChildren = tImp.alignChildren = ["fill", "top"];
        tExp.margins = tImp.margins = [8, 10, 8, 8];
        tExp.spacing = tImp.spacing = 6;
        var status = w.add("statictext", undefined, "EDL AE " + EDLAE.version, { truncate: "end" });
        status.alignment = ["fill", "bottom"];
        var exp = buildExport(tExp, status);
        var imp = buildImport(tImp, status);
        tabs.onChange = function () {
            try { if (tabs.selection === tExp) { exp.refresh(); } else { imp.refresh(); } } catch (e) {}
        };
        var api = {
            select: function (which) {
                tabs.selection = which === "import" ? tImp : tExp;
                try { if (which === "import") { imp.refresh(); } else { exp.refresh(); } } catch (e) {}
            }
        };
        api.select(initialTab || "export");
        w.onResizing = w.onResize = function () { this.layout.resize(); };
        return api;
    };

    return UI;
}());

EDLAE.main = function (thisObj) {
    var g = $.global, mode = g.__EDLAE_LAUNCH || "";
    g.__EDLAE_LAUNCH = null;
    if (thisObj instanceof Panel) {
        EDLAE.ui.build(thisObj, "export");
        thisObj.layout.layout(true);
        thisObj.layout.resize();
        return;
    }
    var existing = g.__EDLAE_WINDOW;
    if (existing && existing.win) {
        try {
            if (existing.win.visible) {
                existing.api.select(mode || "export");
                existing.win.active = true;
                return;
            }
        } catch (e) {}
    }
    var w = new Window("palette", "EDL AE", undefined, { resizeable: true });
    var api = EDLAE.ui.build(w, mode || "export");
    g.__EDLAE_WINDOW = { win: w, api: api };
    w.layout.layout(true);
    w.center();
    w.show();
};
