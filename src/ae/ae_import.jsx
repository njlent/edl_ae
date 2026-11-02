// Timeline model -> compositions.
//
// Options:
//   targetComp     existing CompItem to build the first timeline into (else new comps)
//   usePaths       import media from paths in the file (default true)
//   searchFolder   folder path searched (recursively) for media by file/clip/reel name
//   reuseProject   reuse footage already in the project (default true)
//   missing        "placeholder" (default) | "solid" | "skip"
//   readTC         read media start timecode from XMP when the file doesn't say (default true)
//   seqFrameTC     image sequence frame numbers as timecode (default true)
//   audio          create audio layers / keep linked audio (default true)
//   markers        comp and layer markers (default true)
//   fades          dissolves as opacity keyframes (default true)
//   disabled       import disabled clips as disabled layers (default true)
//   generators     generators/titles as grey solids (default true)

EDLAE.ae.importer = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model, A = EDLAE.ae.util;
    var I = {};

    var LABEL_INDEX = { RED: 1, YELLOW: 2, CYAN: 14, PINK: 4, PURPLE: 10, ORANGE: 11, GREEN: 9, BLUE: 8,
        MAGENTA: 13, FUCHSIA: 13, LAVENDER: 5, CREAM: 15, SKY: 3, MINT: 7, SAND: 15, WHITE: 0, BLACK: 0 };

    function opt(o, k, d) { return o && o.hasOwnProperty(k) && o[k] !== undefined ? o[k] : d; }

    function frames(f, from, to) {
        if (!from || !to || from.base === to.base) { return f; }
        return f / from.fps * to.fps;
    }

    // ---- context ------------------------------------------------------------

    function newCtx(opts) {
        var ctx = {
            opts: opts || {}, notes: [], made: {}, footage: {}, usage: {},
            byPath: {}, byName: {}, search: null, searchSeq: null,
            folder: null, mediaFolder: null,
            stats: { comps: 0, layers: 0, imported: 0, reused: 0, missing: 0, clamped: 0 }
        };
        var items = app.project.items;
        for (var i = 1; i <= items.length; i++) {
            var it = items[i];
            if (!(it instanceof FootageItem)) { continue; }
            var f = null;
            try { f = it.file; } catch (e) { f = null; }
            if (f) { ctx.byPath[f.fsName.toLowerCase()] = it; }
            if (!(it.mainSource instanceof SolidSource)) {
                var n = it.name.toLowerCase();
                if (!ctx.byName[n]) { ctx.byName[n] = it; }
                if (!ctx.byName["~" + U.stripExt(n)]) { ctx.byName["~" + U.stripExt(n)] = it; }
            }
        }
        if (ctx.opts.searchFolder) { indexFolder(ctx, ctx.opts.searchFolder); }
        return ctx;
    }

    function indexFolder(ctx, path) {
        ctx.search = {};
        ctx.searchSeq = {};
        var count = 0, root = new Folder(path);
        if (!root.exists) { ctx.notes.push("Search folder not found: " + path); return; }
        function walk(folder, depth) {
            if (depth > 12 || count > 40000) { return; }
            var entries = folder.getFiles();
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (e instanceof Folder) {
                    if (e.name.charAt(0) !== ".") { walk(e, depth + 1); }
                    continue;
                }
                count++;
                var nm = File.decode(e.name).toLowerCase();
                if (!ctx.search[nm]) { ctx.search[nm] = e.fsName; }
                var stem = "~" + U.stripExt(nm);
                if (!ctx.search[stem]) { ctx.search[stem] = e.fsName; }
                var sq = U.isImageExt(U.ext(nm)) ? U.parseFrameFile(nm) : null;
                if (sq) {
                    var pk = sq.prefix.replace(/[._\-]+$/, "");
                    if (!ctx.searchSeq[pk] || sq.frame < ctx.searchSeq[pk].frame) { ctx.searchSeq[pk] = { frame: sq.frame, path: e.fsName }; }
                }
            }
        }
        walk(root, 0);
        if (count > 40000) { ctx.notes.push("Search folder scan stopped after 40000 files."); }
    }

    function getFolder(ctx, tl) {
        if (!ctx.folder) {
            ctx.folder = app.project.items.addFolder("EDL AE - " + tl.name);
        }
        return ctx.folder;
    }

    function getMediaFolder(ctx, tl) {
        if (!ctx.mediaFolder) {
            ctx.mediaFolder = app.project.items.addFolder("Media");
            ctx.mediaFolder.parentFolder = getFolder(ctx, tl);
        }
        return ctx.mediaFolder;
    }

    // Source frame range each media is used over (for placeholders of unknown start).
    function collectUsage(tl, ctx, seen) {
        seen = seen || {};
        if (seen[tl.id]) { return; }
        seen[tl.id] = true;
        var tracks = M.allTracks(tl);
        for (var t = 0; t < tracks.length; t++) {
            for (var c = 0; c < tracks[t].clips.length; c++) {
                var clip = tracks[t].clips[c];
                if (clip.nested) { collectUsage(clip.nested, ctx, seen); continue; }
                if (!clip.media) { continue; }
                var key = M.mediaKey(clip.media);
                var mr = clip.media.rate || tl.rate, sr = M.srcRate(clip, tl);
                var a = frames(Math.min(clip.srcIn, clip.srcOut), sr, mr), b = frames(Math.max(clip.srcIn, clip.srcOut), sr, mr);
                var u = ctx.usage[key];
                if (!u) { ctx.usage[key] = { min: a, max: b }; }
                else { u.min = Math.min(u.min, a); u.max = Math.max(u.max, b); }
            }
        }
    }

    // ---- media ----------------------------------------------------------------

    function siblingFrameExists(fsName, sq) {
        var dir = U.dirname(fsName);
        return new File(dir + "/" + sq.prefix + U.padLeft(sq.frame + 1, sq.pad, "0") + sq.suffix).exists;
    }

    function importFootage(fsName, media, tl, ctx) {
        var f = new File(fsName);
        var io = new ImportOptions(f), asSeq = false;
        if (U.isImageExt(U.ext(f.fsName))) {
            var sq = U.parseFrameFile(U.basename(f.fsName));
            asSeq = !!sq && (!!media.sequence || siblingFrameExists(f.fsName, sq));
        }
        if (asSeq) {
            try { io.sequence = true; io.forceAlphabetical = false; } catch (e) { asSeq = false; }
        }
        var item = app.project.importFile(io);
        if (asSeq) {
            try { item.mainSource.conformFrameRate = (media.rate || tl.rate).fps; } catch (e2) {}
        }
        item.parentFolder = getMediaFolder(ctx, tl);
        ctx.byPath[f.fsName.toLowerCase()] = item;
        ctx.stats.imported++;
        return item;
    }

    function existingOrImport(fsName, media, tl, ctx) {
        var hit = ctx.byPath[new File(fsName).fsName.toLowerCase()];
        if (hit) { ctx.stats.reused++; return hit; }
        return importFootage(fsName, media, tl, ctx);
    }

    function candidates(media, clip) {
        var out = [], seen = {};
        var list = [media.path ? U.basename(media.path) : "", media.name, clip.name, media.reel];
        for (var i = 0; i < list.length; i++) {
            var s = U.trim(list[i]);
            if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = true; out.push(s); }
        }
        return out;
    }

    function findMedia(media, clip, tl, ctx) {
        var opts = ctx.opts, i, c, p;
        if (media.path && opt(opts, "usePaths", true)) {
            var f = new File(media.path);
            if (f.exists) { return existingOrImport(f.fsName, media, tl, ctx); }
        }
        var names = candidates(media, clip);
        if (ctx.search) {
            for (i = 0; i < names.length; i++) {
                c = names[i].toLowerCase();
                p = ctx.search[c] || ctx.search["~" + U.stripExt(c)] || ctx.search["~" + c];
                if (!p) {
                    var sq = ctx.searchSeq[c] || ctx.searchSeq[U.stripExt(c).replace(/[._\-]?\d+$/, "")];
                    if (sq) { p = sq.path; }
                }
                if (p) { return existingOrImport(p, media, tl, ctx); }
            }
        }
        if (opt(opts, "reuseProject", true)) {
            for (i = 0; i < names.length; i++) {
                c = names[i].toLowerCase();
                var hit = ctx.byName[c] || ctx.byName["~" + U.stripExt(c)] || ctx.byName["~" + c];
                if (hit) { ctx.stats.reused++; return hit; }
            }
        }
        return null;
    }

    // -> {item, startFrames, startRate, itemRate, still} | {solid:true} | null
    function footageFor(clip, tl, ctx) {
        var media = clip.media, key = M.mediaKey(media);
        if (ctx.footage.hasOwnProperty(key)) { return ctx.footage[key]; }
        var opts = ctx.opts, rec = null;
        var item = findMedia(media, clip, tl, ctx);
        if (item) {
            var still = !!item.mainSource.isStill;
            var itemRate = TC.fromFps(!still && item.frameRate > 0 ? item.frameRate : tl.rate.fps, false);
            var startFrames = 0, startRate = itemRate;
            if (media.startKnown) {
                startFrames = media.start;
                startRate = media.rate || itemRate;
            } else {
                var file = null;
                try { file = item.file; } catch (e) { file = null; }
                var st = file ? A.mediaStartFrames(file.fsName, itemRate, opt(opts, "readTC", true), opt(opts, "seqFrameTC", true)) : null;
                if (st && st.frames !== null) { startFrames = st.frames; }
                else if (!still) {
                    var u = ctx.usage[key];
                    if (u && u.min > Math.max(1, item.duration * itemRate.fps)) {
                        ctx.notes.push(media.name + ": source timecode unknown and beyond the media length; assumed it starts at " +
                            TC.toTC(TC.hourFloor(u.min, media.rate || tl.rate), media.rate || tl.rate) + ".");
                        startFrames = TC.hourFloor(u.min, media.rate || tl.rate);
                        startRate = media.rate || tl.rate;
                    }
                }
            }
            rec = { item: item, startFrames: startFrames, startRate: startRate, itemRate: itemRate, still: still };
        } else {
            var mode = opt(opts, "missing", "placeholder");
            ctx.stats.missing++;
            if (mode === "skip") {
                ctx.notes.push("Missing media skipped: " + (media.path || media.name));
            } else if (mode === "solid") {
                ctx.notes.push("Missing media as solid: " + (media.path || media.name));
                rec = { solid: true };
            } else {
                var mr = media.rate || tl.rate;
                var us = ctx.usage[key] || { min: 0, max: 1 };
                var start = media.startKnown ? media.start : Math.floor(us.min);
                var dur = Math.max(media.duration || 0, Math.ceil(us.max - start) + 1, 1);
                var durSec = Math.min(dur / mr.fps, 10800);
                var ph = app.project.importPlaceholder(media.name || clip.name || "Missing",
                    Math.max(4, Math.min(30000, media.width || tl.width)), Math.max(4, Math.min(30000, media.height || tl.height)),
                    mr.fps, Math.max(durSec, 1 / mr.fps));
                ph.parentFolder = getMediaFolder(ctx, tl);
                ctx.notes.push("Missing media, placeholder created: " + (media.path || media.name));
                rec = { item: ph, startFrames: start, startRate: mr, itemRate: mr, still: false, placeholder: true };
            }
        }
        ctx.footage[key] = rec;
        return rec;
    }

    // -> {item | solid, still, toSec(srcFrame)} or null
    function sourceFor(clip, tl, ctx) {
        var sr = M.srcRate(clip, tl);
        if (clip.nested) {
            var comp = buildComp(clip.nested, ctx, null);
            var ns = frames(clip.nested.start, clip.nested.rate, sr);
            return { item: comp, still: false, toSec: function (f) { return (f - ns) / sr.fps; } };
        }
        if (!clip.media) {
            return opt(ctx.opts, "generators", true) ? { solid: true, still: true } : null;
        }
        var rec = footageFor(clip, tl, ctx);
        if (!rec) { return null; }
        if (rec.solid) { return { solid: true, still: true }; }
        var start = frames(rec.startFrames, rec.startRate, sr);
        var perSec = sr.base === rec.itemRate.base ? rec.itemRate.fps : sr.fps;
        return { item: rec.item, still: rec.still, toSec: function (f) { return (f - start) / perSec; } };
    }

    // ---- layers ---------------------------------------------------------------

    function setInOut(layer, tIn, tOut) {
        if (tIn >= layer.outPoint) { layer.outPoint = tOut; layer.inPoint = tIn; }
        else { layer.inPoint = tIn; layer.outPoint = tOut; }
    }

    function markerValue(mk, fps) {
        var mv = new MarkerValue(mk.comment || mk.name || "");
        if (mk.name && mk.comment && mk.comment !== mk.name) { mv.comment = mk.name + "\n" + mk.comment; }
        if (mk.duration > 0) { try { mv.duration = mk.duration / fps; } catch (e) {} }
        var idx = LABEL_INDEX[String(mk.color || "").toUpperCase()];
        if (idx !== undefined) { try { mv.label = idx; } catch (e2) {} }
        return mv;
    }

    function placeLayer(comp, tl, clip, kind, ctx) {
        var src = sourceFor(clip, tl, ctx);
        if (!src) { return null; }
        var fps = tl.rate.fps, opts = ctx.opts;
        var tIn = clip.recIn / fps, tOut = clip.recOut / fps, layer;
        if (src.solid) {
            layer = comp.layers.addSolid([0.2, 0.2, 0.2], clip.name || "Generator", comp.width, comp.height, comp.pixelAspect, comp.duration);
        } else {
            layer = comp.layers.add(src.item);
        }
        ctx.stats.layers++;
        if (clip.name && layer.name !== clip.name) { try { layer.name = clip.name; } catch (e) {} }

        if (src.still) {
            setInOut(layer, tIn, tOut);
        } else if (clip.speed === 0) {
            layer.timeRemapEnabled = true;
            var tr = layer.property("ADBE Time Remapping"), s = src.toSec(clip.srcIn);
            while (tr.numKeys > 0) { tr.removeKey(1); }
            tr.setValue(s);
            layer.startTime = 0;
            setInOut(layer, tIn, tOut);
        } else {
            var s0 = src.toSec(clip.srcIn);
            if (clip.speed !== 1) { layer.stretch = 100 / clip.speed; }
            layer.startTime = tIn - s0 / clip.speed;
            setInOut(layer, tIn, tOut);
            var half = 0.5 / fps;
            if (Math.abs(layer.inPoint - tIn) > half || Math.abs(layer.outPoint - tOut) > half) {
                ctx.stats.clamped++;
                ctx.notes.push(tl.name + " / " + clip.name + " @ " + TC.toTC(tl.start + clip.recIn, tl.rate) +
                    ": media too short for the edit (source range outside the footage), layer trimmed.");
            }
        }

        if (kind === "audio") {
            try { if (layer.hasVideo) { layer.enabled = false; } } catch (e3) {}
            try { layer.audioEnabled = true; } catch (e4) {}
        } else {
            layer.enabled = !!clip.enabled;
            if (opt(opts, "fades", true) && (clip.transitionIn > 0 || clip.transitionOut > 0)) {
                var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
                if (clip.transitionIn > 0) {
                    op.setValueAtTime(tIn, 0);
                    op.setValueAtTime(Math.min(tOut, tIn + clip.transitionIn / fps), 100);
                }
                if (clip.transitionOut > 0) {
                    op.setValueAtTime(Math.max(tIn, tOut - clip.transitionOut / fps), 100);
                    op.setValueAtTime(tOut, 0);
                }
            }
        }
        if (opt(opts, "markers", true) && clip.markers.length) {
            var lm = layer.property("ADBE Marker");
            for (var k = 0; k < clip.markers.length; k++) {
                lm.setValueAtTime(tIn + clip.markers[k].frame / fps, markerValue(clip.markers[k], fps));
            }
        }
        return layer;
    }

    function linkKey(c) {
        return (c.media ? M.mediaKey(c.media) : (c.nested ? "tl:" + c.nested.id : "gen:" + c.name)) + "|" + c.recIn + "|" + c.recOut;
    }

    function buildComp(tl, ctx, target) {
        if (ctx.made[tl.id]) { return ctx.made[tl.id]; }
        var opts = ctx.opts, fps = tl.rate.fps, i, j;
        collectUsage(tl, ctx);
        var durFrames = Math.max(tl.duration, M.computeDuration(tl), 1);
        var durSec = durFrames / fps;
        if (durSec > 10800) {
            ctx.notes.push(tl.name + ": longer than 3 hours, composition truncated.");
            durSec = 10800;
        }
        var comp = target;
        if (comp) {
            if (Math.abs(comp.frameRate - fps) > 0.001) {
                ctx.notes.push(tl.name + " is " + TC.label(tl.rate) + " fps but '" + comp.name + "' is " +
                    U.fmtNum(comp.frameRate, 3) + " fps; edits placed by time.");
            }
            if (comp.duration < durSec) { comp.duration = durSec; }
        } else {
            comp = app.project.items.addComp(tl.name,
                Math.max(4, Math.min(30000, Math.round(tl.width || 1920))),
                Math.max(4, Math.min(30000, Math.round(tl.height || 1080))),
                tl.pixelAspect > 0.01 && tl.pixelAspect < 100 ? tl.pixelAspect : 1, durSec, fps);
            try { comp.dropFrame = !!tl.rate.drop; } catch (e) {}
            try { comp.displayStartTime = tl.start / fps; } catch (e2) {
                ctx.notes.push(tl.name + ": start timecode " + TC.toTC(tl.start, tl.rate) + " could not be set.");
            }
            comp.parentFolder = getFolder(ctx, tl);
            ctx.stats.comps++;
        }
        ctx.made[tl.id] = comp;

        var withDisabled = opt(opts, "disabled", true);
        var wantAudio = opt(opts, "audio", true);
        var videoKeys = {}, audioMatched = {};
        for (i = 0; i < tl.video.length; i++) {
            for (j = 0; j < tl.video[i].clips.length; j++) { videoKeys[linkKey(tl.video[i].clips[j])] = true; }
        }

        // audio-only layers first so they end up below the picture
        if (wantAudio) {
            var done = {};
            for (i = tl.audio.length - 1; i >= 0; i--) {
                if (!tl.audio[i].enabled && !withDisabled) { continue; }
                for (j = tl.audio[i].clips.length - 1; j >= 0; j--) {
                    var ac = tl.audio[i].clips[j], k = linkKey(ac);
                    if (videoKeys[k]) { audioMatched[k] = true; continue; }
                    if (done[k] || (!ac.enabled && !withDisabled)) { continue; }
                    done[k] = true;
                    placeLayer(comp, tl, ac, "audio", ctx);
                }
            }
        }
        // picture, V1 first so higher tracks end up on top
        for (i = 0; i < tl.video.length; i++) {
            var trk = tl.video[i];
            if (!trk.enabled && !withDisabled) { continue; }
            for (j = 0; j < trk.clips.length; j++) {
                var vc = trk.clips[j];
                if (!vc.enabled && !withDisabled) { continue; }
                var layer = placeLayer(comp, tl, vc, "video", ctx);
                if (!layer) { continue; }
                if (!trk.enabled) { layer.enabled = false; }
                if (layer.hasAudio) {
                    try { layer.audioEnabled = wantAudio && (vc.audioLinked || !!audioMatched[linkKey(vc)]); } catch (e3) {}
                }
            }
        }
        if (opt(opts, "markers", true)) {
            for (i = 0; i < tl.markers.length; i++) {
                var mk = tl.markers[i];
                try { comp.markerProperty.setValueAtTime(mk.frame / fps, markerValue(mk, fps)); } catch (e4) {}
            }
        }
        return comp;
    }

    // -> {comps, notes, stats}
    I.run = function (tls, opts) {
        var ctx = newCtx(opts), comps = [];
        for (var i = 0; i < tls.length; i++) {
            comps.push(buildComp(tls[i], ctx, i === 0 && opts && opts.targetComp ? opts.targetComp : null));
        }
        return { comps: comps, notes: ctx.notes, stats: ctx.stats };
    };

    return I;
}());
