// Composition -> timeline model.
//
// Options (all optional):
//   workArea          export only the work area
//   trackMode         "pack" (default) or "layers"
//   audio             include audio tracks (default true)
//   markers           comp + layer markers (default true)
//   includeDisabled   layers with video and audio switched off
//   generators        solids/text/shapes as offline clips
//   nested            precomps as nested sequences (default true)
//   readTC            read source timecode from media XMP (default true)
//   seqFrameTC        image sequence frame numbers as source timecode (default true)

EDLAE.ae.exporter = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model, A = EDLAE.ae.util;
    var E = {};

    var LABEL_COLORS = ["", "RED", "YELLOW", "CYAN", "PINK", "PURPLE", "ORANGE", "GREEN", "BLUE", "GREEN",
        "PURPLE", "ORANGE", "ORANGE", "MAGENTA", "CYAN", "YELLOW", "GREEN"];

    function opt(o, k, d) { return o && o.hasOwnProperty(k) ? o[k] : d; }

    function mediaForFootage(item, compRate, opts, ctx) {
        var key = "id" + item.id;
        if (ctx.media[key]) { return ctx.media[key]; }
        var src = item.mainSource, file = null;
        try { file = item.file; } catch (e) { file = null; }
        var isStill = !!src.isStill;
        var fps = !isStill && item.frameRate > 0 ? item.frameRate : compRate.fps;
        var rate = TC.fromFps(fps, false);
        var media = M.media({
            name: item.name,
            path: file ? A.modelPath(file) : "",
            rate: rate,
            width: item.width, height: item.height,
            hasVideo: item.hasVideo, hasAudio: item.hasAudio, isStill: isStill,
            duration: isStill ? 0 : Math.round(item.duration * fps),
            start: 0, startKnown: true
        });
        if (file && !isStill && U.isImageExt(U.ext(file.fsName))) {
            media.sequence = U.parseFrameFile(U.basename(file.fsName));
        }
        if (file && !isStill) {
            var st = A.mediaStartFrames(file.fsName, rate, opt(opts, "readTC", true), opt(opts, "seqFrameTC", true));
            if (st) {
                if (st.frames !== null) { media.start = st.frames; }
                if (st.reel) { media.reel = st.reel; }
                if (st.drop) { media.rate = TC.make(rate.base, rate.ntsc, true); }
            }
        }
        ctx.media[key] = media;
        return media;
    }

    function srcTimeAt(layer, t) {
        if (layer.timeRemapEnabled) {
            return layer.property("ADBE Time Remapping").valueAtTime(t, false);
        }
        return (t - layer.startTime) * 100 / layer.stretch;
    }

    function markerList(prop, fps, offsetFrames) {
        var out = [];
        if (!prop) { return out; }
        for (var k = 1; k <= prop.numKeys; k++) {
            var mv = prop.keyValue(k), label = 0;
            try { label = mv.label; } catch (e) { label = 0; }
            var comment = String(mv.comment || "");
            var firstLine = comment.split(/\r\n|\r|\n/)[0];
            out.push(M.marker({
                name: firstLine || mv.chapter || "",
                comment: comment,
                frame: Math.round(prop.keyTime(k) * fps) - offsetFrames,
                duration: Math.round((mv.duration || 0) * fps),
                color: LABEL_COLORS[label] || ""
            }));
        }
        return out;
    }

    function overlaps(a, b) { return a.recIn < b.recOut && b.recIn < a.recOut; }

    E.compToTimeline = function (comp, opts, ctx) {
        ctx = ctx || {};
        ctx.media = ctx.media || {};
        ctx.comps = ctx.comps || {};
        ctx.notes = ctx.notes || [];
        if (ctx.comps[comp.id]) { return ctx.comps[comp.id]; }

        var rate = A.compRate(comp), fps = rate.fps;
        var tl = M.timeline(comp.name, rate);
        tl.width = comp.width;
        tl.height = comp.height;
        tl.pixelAspect = comp.pixelAspect;
        ctx.comps[comp.id] = tl;

        var r0 = 0, r1 = comp.duration;
        if (opt(opts, "workArea", false) && !ctx.inNested) {
            r0 = comp.workAreaStart;
            r1 = comp.workAreaStart + comp.workAreaDuration;
        }
        var rangeIn = Math.round(r0 * fps), rangeOut = Math.round(r1 * fps);
        tl.start = Math.round(comp.displayStartTime * fps) + rangeIn;
        tl.duration = rangeOut - rangeIn;

        var wantAudio = opt(opts, "audio", true), wantMarkers = opt(opts, "markers", true);
        var includeDisabled = opt(opts, "includeDisabled", false), generators = opt(opts, "generators", false);
        var entries = [], i;

        for (i = comp.numLayers; i >= 1; i--) {
            var L = comp.layer(i);
            if (!(L instanceof AVLayer)) { continue; } // cameras, lights
            if (L.nullLayer || L.adjustmentLayer) { continue; }
            if (L.guideLayer && !includeDisabled) { continue; }
            var src = L.source;
            var vid = L.hasVideo && (L.enabled || includeDisabled);
            var aud = wantAudio && L.hasAudio && (L.audioEnabled || includeDisabled);
            if (!vid && !aud) { continue; }

            var media = null, nested = null, kind = "clip", srcRate = rate, mediaStart = 0, still = false;
            if (src instanceof CompItem) {
                if (opt(opts, "nested", true)) {
                    var wasNested = ctx.inNested;
                    ctx.inNested = true;
                    nested = E.compToTimeline(src, opts, ctx);
                    ctx.inNested = wasNested;
                    srcRate = nested.rate;
                    mediaStart = nested.start;
                } else {
                    srcRate = A.compRate(src);
                    media = M.media({
                        name: src.name, rate: srcRate, width: src.width, height: src.height,
                        hasVideo: src.hasVideo, hasAudio: src.hasAudio,
                        start: Math.round(src.displayStartTime * srcRate.fps), startKnown: true,
                        duration: Math.round(src.duration * srcRate.fps)
                    });
                    mediaStart = media.start;
                }
            } else if (src instanceof FootageItem) {
                var ms = src.mainSource;
                if (ms instanceof SolidSource) {
                    if (!generators) { continue; }
                    kind = "generator";
                    still = true;
                } else if (ms instanceof PlaceholderSource) {
                    media = M.media({
                        name: src.name, rate: TC.fromFps(src.frameRate || fps, false), width: src.width, height: src.height,
                        hasVideo: src.hasVideo, hasAudio: src.hasAudio, duration: Math.round(src.duration * (src.frameRate || fps))
                    });
                    srcRate = media.rate;
                } else {
                    media = mediaForFootage(src, rate, opts, ctx);
                    srcRate = media.rate;
                    mediaStart = media.start;
                    still = media.isStill;
                }
            } else {
                if (!generators) { continue; } // text, shape
                kind = "generator";
                still = true;
            }

            var t0 = Math.max(L.inPoint, r0), t1 = Math.min(L.outPoint, r1);
            var recIn = Math.round(t0 * fps) - rangeIn, recOut = Math.round(t1 * fps) - rangeIn;
            if (recOut <= recIn) { continue; }

            var speed = 1, srcIn = mediaStart;
            if (!still) {
                var s0 = srcTimeAt(L, recIn / fps + r0), s1 = srcTimeAt(L, recOut / fps + r0);
                speed = (s1 - s0) / ((recOut - recIn) / fps);
                speed = Math.round(speed * 10000) / 10000;
                if (Math.abs(speed - 1) < 0.0005) { speed = 1; }
                if (L.timeRemapEnabled && L.property("ADBE Time Remapping").numKeys > 2) {
                    ctx.notes.push(comp.name + " / " + L.name + ": time remap has more than two keyframes, exported as constant " +
                        U.fmtNum(speed * 100, 2) + "%.");
                }
                srcIn = mediaStart + Math.round(s0 * srcRate.fps * 1000) / 1000;
                srcIn = Math.abs(srcIn - Math.round(srcIn)) < 0.01 ? Math.round(srcIn) : srcIn;
            }
            var clip = M.clip({
                name: L.name, kind: kind, media: media, nested: nested,
                recIn: recIn, recOut: recOut, srcIn: srcIn, srcRate: srcRate, speed: speed,
                enabled: L.enabled || !L.hasVideo, audioLinked: aud
            });
            clip.srcOut = still ? srcIn + (recOut - recIn) : M.srcOutFor(clip, tl);
            if (wantMarkers) {
                var lm = markerList(L.property("ADBE Marker"), fps, recIn + rangeIn);
                for (var k = 0; k < lm.length; k++) {
                    if (lm[k].frame >= 0 && lm[k].frame < recOut - recIn) { clip.markers.push(lm[k]); }
                }
            }
            entries.push({ clip: clip, vid: vid, aud: aud, layer: i });
        }

        // video tracks, bottom layer first
        var placed = [], perLayer = 0;
        for (i = 0; i < entries.length; i++) {
            if (!entries[i].vid) { continue; }
            var c = entries[i].clip, t = 0, p;
            if (opt(opts, "trackMode", "pack") === "layers") { t = perLayer++; }
            else {
                for (p = 0; p < placed.length; p++) {
                    if (overlaps(placed[p].clip, c) && placed[p].track + 1 > t) { t = placed[p].track + 1; }
                }
            }
            placed.push({ clip: c, track: t });
            M.ensureTrack(tl, "video", t).clips.push(c);
        }
        // audio tracks, first fit
        var audTracks = [];
        for (i = 0; i < entries.length; i++) {
            if (!entries[i].aud) { continue; }
            var ac = M.clip(U.extend({}, entries[i].clip));
            ac.markers = [];
            ac.enabled = true;
            ac.channel = 1;
            var at = 0;
            for (; at < audTracks.length; at++) {
                var free = true;
                for (var q = 0; q < audTracks[at].length; q++) { if (overlaps(audTracks[at][q], ac)) { free = false; break; } }
                if (free) { break; }
            }
            if (!audTracks[at]) { audTracks[at] = []; }
            audTracks[at].push(ac);
            M.ensureTrack(tl, "audio", at).clips.push(ac);
        }

        if (wantMarkers) {
            var cm = null;
            try { cm = comp.markerProperty; } catch (e) { cm = null; }
            var mk = markerList(cm, fps, rangeIn);
            for (i = 0; i < mk.length; i++) {
                if (mk[i].frame >= 0 && mk[i].frame < tl.duration) { tl.markers.push(mk[i]); }
            }
        }

        M.finalize(tl);
        tl.duration = rangeOut - rangeIn;
        return tl;
    };

    return E;
}());
