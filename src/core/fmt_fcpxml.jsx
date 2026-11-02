// FCPXML (Final Cut Pro X, DaVinci Resolve). Writes version 1.8 (asset src=),
// reads 1.3 - 1.11 (asset src= and media-rep).
//
// Export layout: V1 is the primary storyline (gaps fill holes), higher video
// tracks become connected clips on lanes 1..n, audio-only clips lanes -1..-n.
// Nested comps become compound clips (<media> + <ref-clip>).

EDLAE.fmt = EDLAE.fmt || {};
EDLAE.fmt.fcpxml = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model, X = EDLAE.xml;
    var F = { id: "fcpxml", label: "FCPXML 1.8 (.fcpxml)", ext: "fcpxml", canRead: true, canWrite: true, combinable: true };

    F.sniff = function (text) { return /<fcpxml[\s>]/.test(String(text).substring(0, 4000)); };

    // ---- rationals ---------------------------------------------------------

    function R(n, d) {
        if (d < 0) { n = -n; d = -d; }
        var g = U.gcd(n, d);
        return { n: n / g, d: d / g };
    }
    function rAdd(a, b) { return R(a.n * b.d + b.n * a.d, a.d * b.d); }
    function rSub(a, b) { return R(a.n * b.d - b.n * a.d, a.d * b.d); }
    function rStr(r) { return r.n === 0 ? "0s" : (r.d === 1 ? r.n + "s" : r.n + "/" + r.d + "s"); }
    function rFrames(frames, rate) {
        var fd = TC.frameDuration(rate);
        return R(Math.round(frames) * fd.num, fd.den);
    }

    function parseTime(s) {
        if (!s) { return 0; }
        s = U.trim(s).replace(/s$/, "");
        var slash = s.indexOf("/");
        if (slash >= 0) { return parseFloat(s.substring(0, slash)) / parseFloat(s.substring(slash + 1)); }
        var v = parseFloat(s);
        return isNaN(v) ? 0 : v;
    }

    // ---- read --------------------------------------------------------------

    F.read = function (text, opts) {
        opts = opts || {};
        var root = X.parse(text);
        if (root.tag !== "fcpxml") { throw new Error("Not an FCPXML file (root is <" + root.tag + ">)."); }
        var res = X.child(root, "resources"), i;
        var formats = {}, assets = {}, medias = {}, effects = {};
        var kids = res ? res.kids : [];
        for (i = 0; i < kids.length; i++) {
            var r = kids[i], id = r.attrs.id;
            if (r.tag === "format") {
                var fd = parseTime(r.attrs.frameDuration);
                formats[id] = {
                    rate: fd > 0 ? TC.fromFps(1 / fd, false) : null,
                    width: U.toInt(r.attrs.width, 0), height: U.toInt(r.attrs.height, 0)
                };
            } else if (r.tag === "asset") { assets[id] = r; }
            else if (r.tag === "media") { medias[id] = r; }
            else if (r.tag === "effect") { effects[id] = r; }
        }

        var mediaCache = {}, compoundCache = {};

        function assetMedia(id, fallbackRate) {
            if (mediaCache[id]) { return mediaCache[id]; }
            var el = assets[id];
            if (!el) { return null; }
            var rep = X.child(el, "media-rep");
            var src = el.attrs.src || (rep ? rep.attrs.src : "") || "";
            var fmt = formats[el.attrs.format];
            var rate = (fmt && fmt.rate) || fallbackRate;
            var path = U.urlToPath(src);
            var media = M.media({
                name: el.attrs.name || U.basename(path),
                path: path, url: src, rate: rate,
                start: Math.round(parseTime(el.attrs.start) * rate.fps), startKnown: true,
                duration: Math.round(parseTime(el.attrs.duration) * rate.fps),
                width: fmt ? fmt.width : 0, height: fmt ? fmt.height : 0,
                hasVideo: el.attrs.hasVideo === "1", hasAudio: el.attrs.hasAudio === "1",
                isStill: el.attrs.hasVideo === "1" && parseTime(el.attrs.duration) === 0
            });
            if (!el.attrs.hasOwnProperty("hasVideo") && !el.attrs.hasOwnProperty("hasAudio")) { media.hasVideo = true; }
            mediaCache[id] = media;
            return media;
        }

        function timeMapFn(el) {
            var tm = X.child(el, "timeMap");
            if (!tm) { return null; }
            var pts = X.children(tm, "timept");
            if (pts.length < 2) { return null; }
            var t = [], v = [];
            for (var k = 0; k < pts.length; k++) { t.push(parseTime(pts[k].attrs.time)); v.push(parseTime(pts[k].attrs.value)); }
            return function (x) {
                var s = 0;
                while (s < t.length - 2 && x > t[s + 1]) { s++; }
                var dt = t[s + 1] - t[s];
                return dt === 0 ? v[s] : v[s] + (x - t[s]) * (v[s + 1] - v[s]) / dt;
            };
        }

        function parseSequence(seqEl, name) {
            var i, fmt = formats[seqEl.attrs.format] || {};
            var rate = fmt.rate || opts.rate || TC.make(24, false, false);
            rate = TC.make(rate.base, rate.ntsc, seqEl.attrs.tcFormat === "DF");
            var tl = M.timeline(name || "Sequence", rate);
            tl.width = fmt.width || 1920;
            tl.height = fmt.height || 1080;
            tl.start = Math.round(parseTime(seqEl.attrs.tcStart) * rate.fps);
            tl.duration = Math.round(parseTime(seqEl.attrs.duration) * rate.fps);
            var fps = rate.fps;
            function toRec(absSec) { return Math.round(absSec * fps) - tl.start; }
            var transitions = {};

            function addClip(kind, trackIdx, clip) {
                if (clip.recOut <= clip.recIn) { return; }
                M.ensureTrack(tl, kind, trackIdx).clips.push(clip);
            }

            function laneTrack(lane, isAudio) {
                if (isAudio) { return { kind: "audio", idx: lane < 0 ? -lane - 1 : 0 }; }
                return { kind: "video", idx: lane > 0 ? lane : 0 };
            }

            function markersOf(el, startLocal, absOfLocal, clip) {
                var mk = X.children(el, "marker").concat(X.children(el, "chapter-marker"));
                for (var k = 0; k < mk.length; k++) {
                    var mStart = parseTime(mk[k].attrs.start), mDur = parseTime(mk[k].attrs.duration);
                    var mm = M.marker({
                        name: mk[k].attrs.value || "", comment: mk[k].attrs.note || "",
                        duration: mDur * fps > 1.5 ? Math.round(mDur * fps) : 0
                    });
                    if (clip) {
                        mm.frame = Math.round((mStart - startLocal) * fps);
                        clip.markers.push(mm);
                    } else {
                        mm.frame = toRec(absOfLocal(mStart));
                        tl.markers.push(mm);
                    }
                }
            }

            // Walk one storyline item. parentAbs(local) maps the parent's local time to sequence seconds.
            // primary: element sits directly in the sequence spine; its markers are timeline markers
            // (FCPXML has no sequence-level markers).
            function item(el, parentAbs, parentLane, cursor, primary) {
                var hasOffset = el.attrs.hasOwnProperty("offset");
                var offset = hasOffset ? parseTime(el.attrs.offset) : cursor;
                var dur = parseTime(el.attrs.duration);
                var start = el.attrs.hasOwnProperty("start") ? parseTime(el.attrs.start) : (el.tag === "spine" ? offset : 0);
                var lane = parentLane + U.toInt(el.attrs.lane, 0);
                var absStart = parentAbs(offset);
                var childAbs = function (local) { return absStart + (local - start); };
                var enabled = el.attrs.enabled !== "0";
                var tag = el.tag, k, media = null, nested = null, src = start, srcEnd, tmap;

                if (tag === "transition") {
                    var key = "v" + lane;
                    (transitions[key] = transitions[key] || []).push({ start: toRec(absStart), end: toRec(absStart + dur) });
                    return offset + 0;
                }
                if (tag === "spine") {
                    var cur = offset;
                    for (k = 0; k < el.kids.length; k++) {
                        var nextEnd = item(el.kids[k], childAbs, lane, cur);
                        if (el.kids[k].tag !== "transition") { cur = nextEnd; }
                    }
                    return offset + dur;
                }
                if (tag === "gap") {
                    markersOf(el, start, childAbs, null);
                    children(el, childAbs, lane);
                    return offset + dur;
                }
                if (tag === "mc-clip") {
                    tl.notes.push("Multicam clip '" + (el.attrs.name || "") + "' skipped.");
                    return offset + dur;
                }

                var clipKind = "clip", isAudio = false, contentEl = el;
                if (tag === "asset-clip") {
                    media = assetMedia(el.attrs.ref, rate);
                    isAudio = media && !media.hasVideo && media.hasAudio;
                } else if (tag === "ref-clip") {
                    nested = compound(el.attrs.ref);
                } else if (tag === "video" || tag === "audio") {
                    if (assets[el.attrs.ref]) { media = assetMedia(el.attrs.ref, rate); }
                    else { clipKind = "generator"; }
                    isAudio = tag === "audio";
                } else if (tag === "title") {
                    clipKind = "generator";
                } else if (tag === "clip" || tag === "sync-clip") {
                    // container: content is its first lane-less video/asset child
                    for (k = 0; k < el.kids.length; k++) {
                        var ck = el.kids[k];
                        if (ck.attrs.lane) { continue; }
                        if (ck.tag === "video" || ck.tag === "asset-clip" || ck.tag === "ref-clip" || ck.tag === "audio") { contentEl = ck; break; }
                        if (ck.tag === "spine") { contentEl = ck; break; }
                    }
                    if (contentEl.tag === "spine") {
                        // sync-clip/clip with an inner storyline: walk it in the clip's time
                        item(contentEl, childAbs, lane, start);
                        children(el, childAbs, lane);
                        return offset + dur;
                    }
                    if (contentEl !== el) {
                        var cStart = contentEl.attrs.hasOwnProperty("start") ? parseTime(contentEl.attrs.start) : 0;
                        var cOff = parseTime(contentEl.attrs.offset);
                        src = cStart + (start - cOff);
                        if (contentEl.tag === "ref-clip") { nested = compound(contentEl.attrs.ref); }
                        else if (assets[contentEl.attrs.ref]) { media = assetMedia(contentEl.attrs.ref, rate); }
                        else { clipKind = "generator"; }
                        isAudio = contentEl.tag === "audio" || (media && !media.hasVideo && media.hasAudio);
                    } else {
                        clipKind = "generator";
                    }
                } else {
                    return offset + dur; // unknown element (filters, notes...)
                }

                tmap = timeMapFn(el);
                var srcRate = media ? media.rate : (nested ? nested.rate : rate);
                var a = tmap ? tmap(start) + (src - start) : src;
                srcEnd = tmap ? tmap(start + dur) + (src - start) : src + dur;
                var speed = dur > 0 ? (srcEnd - a) / dur : 1;
                if (Math.abs(speed - 1) < 1e-4) { speed = 1; }
                var clip = M.clip({
                    name: el.attrs.name || (media ? media.name : nested ? nested.name : "Clip"),
                    kind: clipKind, media: media, nested: nested,
                    recIn: toRec(absStart), recOut: toRec(absStart + dur),
                    srcIn: Math.round(a * srcRate.fps), srcRate: srcRate, speed: speed, enabled: enabled,
                    audioLinked: !!(media && media.hasVideo && media.hasAudio)
                });
                clip.srcOut = M.srcOutFor(clip, tl);
                var lt = laneTrack(lane, isAudio);
                addClip(lt.kind, lt.idx, clip);
                markersOf(el, start, childAbs, primary ? null : clip);
                children(el, childAbs, lane);
                return offset + dur;
            }

            function children(el, childAbs, lane) {
                for (var k = 0; k < el.kids.length; k++) {
                    var ch = el.kids[k];
                    if (ch.attrs.lane !== undefined || ch.tag === "spine") {
                        if (ch.tag === "audio" && el.tag === "clip") { continue; } // the clip's own audio
                        item(ch, childAbs, lane, 0);
                    }
                }
            }

            var spine = X.child(seqEl, "spine");
            if (spine) {
                var cur = 0, ident = function (x) { return x; };
                for (i = 0; i < spine.kids.length; i++) {
                    var e = item(spine.kids[i], ident, 0, cur, true);
                    if (spine.kids[i].tag !== "transition") { cur = e; }
                }
            }
            for (var key in transitions) {
                if (!transitions.hasOwnProperty(key)) { continue; }
                var trk = tl.video[U.toInt(key.substring(1), 0)];
                if (!trk) { continue; }
                M.sortTrack(trk);
                for (var t = 0; t < transitions[key].length; t++) {
                    var tr = transitions[key][t], nb = M.transitionNeighbours(trk.clips, tr.start, tr.end);
                    M.applyTransition(tl, nb.outgoing, nb.incoming, tr.start, tr.end);
                }
            }
            return M.finalize(tl);
        }

        function compound(id) {
            if (compoundCache[id]) { return compoundCache[id]; }
            var mel = medias[id];
            if (!mel) { return null; }
            var seq = X.child(mel, "sequence");
            if (!seq) { return null; }
            var tl = parseSequence(seq, mel.attrs.name || id);
            compoundCache[id] = tl;
            return tl;
        }

        var out = [], projects = X.findAll(root, "project");
        for (i = 0; i < projects.length; i++) {
            var sq = X.child(projects[i], "sequence");
            if (sq) { out.push(parseSequence(sq, projects[i].attrs.name)); }
        }
        if (!out.length) {
            for (var mid in medias) {
                if (medias.hasOwnProperty(mid) && X.child(medias[mid], "sequence")) { out.push(compound(mid)); }
            }
        }
        if (!out.length) { throw new Error("No projects or compound clips found in this FCPXML file."); }
        return out;
    };

    // ---- write -------------------------------------------------------------

    F.writeMany = function (tls, opts) {
        opts = opts || {};
        var resW = new X.Writer("    ");
        resW.depth = 2;
        var nextId = 1, formats = {}, assets = {}, compounds = {};

        function newId() { return "r" + (nextId++); }

        function formatId(w, h, rate) {
            var key = w + "x" + h + "@" + rate.fps;
            if (formats[key]) { return formats[key]; }
            var id = newId();
            formats[key] = id;
            resW.empty("format", ["id", id, "frameDuration", rStr(rFrames(1, rate)), "width", w, "height", h]);
            return id;
        }

        function assetId(media, tl) {
            var key = M.mediaKey(media);
            if (assets[key]) { return assets[key]; }
            var rate = media.rate || tl.rate;
            var fmt = media.hasVideo ? formatId(media.width || tl.width, media.height || tl.height, rate) : undefined;
            var id = newId();
            assets[key] = id;
            resW.empty("asset", [
                "id", id,
                "name", media.path ? U.stripExt(U.basename(media.path)) : media.name,
                "start", rStr(rFrames(media.start || 0, rate)),
                "duration", rStr(rFrames(media.isStill ? 0 : Math.max(1, media.duration || 0), rate)),
                "hasVideo", media.hasVideo ? "1" : "0",
                "format", fmt,
                "hasAudio", media.hasAudio ? "1" : "0",
                "audioSources", media.hasAudio ? "1" : undefined,
                "audioChannels", media.hasAudio ? "2" : undefined,
                "audioRate", media.hasAudio ? "48000" : undefined,
                "src", media.path ? U.pathToUrl(media.path, false) : undefined
            ]);
            return id;
        }

        function compoundId(tl) {
            if (compounds[tl.id]) { return compounds[tl.id]; }
            var id = newId();
            compounds[tl.id] = id;
            var w = new X.Writer("    ");
            w.depth = 2;
            w.open("media", ["id", id, "name", tl.name]);
            writeSequence(w, tl);
            w.close();
            resW.out = resW.out.concat(w.out);
            return id;
        }

        function linkedVideoFor(tl, ac) {
            if (!ac.media || !ac.media.hasVideo) { return false; }
            var key = M.mediaKey(ac.media);
            for (var v = 0; v < tl.video.length; v++) {
                for (var c = 0; c < tl.video[v].clips.length; c++) {
                    var vc = tl.video[v].clips[c];
                    if (vc.media && M.mediaKey(vc.media) === key && vc.recIn === ac.recIn && vc.recOut === ac.recOut) { return true; }
                }
            }
            return false;
        }

        function writeSequence(w, tl) {
            var i, j;
            var abs = function (f) { return rFrames(tl.start + f, tl.rate); };
            w.open("sequence", [
                "format", formatId(tl.width, tl.height, tl.rate),
                "duration", rStr(rFrames(tl.duration, tl.rate)),
                "tcStart", rStr(rFrames(tl.start, tl.rate)),
                "tcFormat", tl.rate.drop ? "DF" : "NDF",
                "audioLayout", "stereo", "audioRate", "48k"
            ]);
            w.open("spine");

            // primary storyline from V1
            var spineItems = [], cursor = 0, connected = [];
            var v1 = tl.video[0] ? tl.video[0].clips : [];
            for (i = 0; i < v1.length; i++) {
                var c = v1[i];
                if (c.recIn < cursor || (!c.media && !c.nested)) { connected.push({ clip: c, lane: 1 }); continue; }
                if (c.recIn > cursor) { spineItems.push({ gap: true, offset: cursor, dur: c.recIn - cursor, kids: [] }); }
                spineItems.push({ clip: c, offset: c.recIn, dur: c.recOut - c.recIn, kids: [] });
                cursor = c.recOut;
            }
            if (tl.duration > cursor) { spineItems.push({ gap: true, offset: cursor, dur: tl.duration - cursor, kids: [] }); }

            for (i = 1; i < tl.video.length; i++) {
                for (j = 0; j < tl.video[i].clips.length; j++) { connected.push({ clip: tl.video[i].clips[j], lane: i }); }
            }
            for (i = 0; i < tl.audio.length; i++) {
                for (j = 0; j < tl.audio[i].clips.length; j++) {
                    var ac = tl.audio[i].clips[j];
                    if (ac.media && !linkedVideoFor(tl, ac)) { connected.push({ clip: ac, lane: -(i + 1) }); }
                }
            }
            if (!spineItems.length && connected.length) {
                spineItems.push({ gap: true, offset: 0, dur: Math.max(1, tl.duration), kids: [] });
            }

            function host(frame) {
                for (var h = 0; h < spineItems.length; h++) {
                    if (frame >= spineItems[h].offset && frame < spineItems[h].offset + spineItems[h].dur) { return spineItems[h]; }
                }
                return spineItems[spineItems.length - 1];
            }
            for (i = 0; i < connected.length; i++) {
                if (!connected[i].clip.media && !connected[i].clip.nested) { continue; } // generators have no FCPXML equivalent here
                host(connected[i].clip.recIn).kids.push(connected[i]);
            }
            var markers = opts.markers === false ? [] : tl.markers;
            for (i = 0; i < markers.length; i++) {
                if (spineItems.length) { (host(markers[i].frame).markers = host(markers[i].frame).markers || []).push(markers[i]); }
            }

            for (i = 0; i < spineItems.length; i++) {
                var it = spineItems[i];
                // parent-local time of a timeline frame
                var localStart = it.gap ? abs(it.offset) : clipStart(it.clip, tl);
                var toLocal = (function (ls, off) {
                    return function (f) { return rAdd(ls, rFrames(f - off, tl.rate)); };
                }(localStart, it.offset));
                if (it.gap) {
                    w.open("gap", ["name", "Gap", "offset", rStr(abs(it.offset)), "start", rStr(localStart), "duration", rStr(rFrames(it.dur, tl.rate))]);
                    writeKids(w, it, toLocal, tl);
                    w.close();
                } else {
                    writeClip(w, it.clip, tl, abs(it.offset), 0, it, toLocal);
                }
            }
            w.close();
            w.close();
        }

        function clipStart(c, tl) {
            var sr = M.srcRate(c, tl);
            return rFrames(c.srcIn, sr);
        }

        function writeKids(w, it, toLocal, tl) {
            var k;
            for (k = 0; k < it.kids.length; k++) {
                writeClip(w, it.kids[k].clip, tl, toLocal(it.kids[k].clip.recIn), it.kids[k].lane, null, null);
            }
            var mks = it.markers || [];
            for (k = 0; k < mks.length; k++) {
                writeMarker(w, mks[k], toLocal(mks[k].frame), tl);
            }
        }

        function writeMarker(w, mk, startR, tl) {
            w.empty("marker", [
                "start", rStr(startR),
                "duration", rStr(rFrames(Math.max(1, mk.duration || 1), tl.rate)),
                "value", mk.name || mk.comment || "Marker",
                "note", mk.comment && mk.comment !== mk.name ? mk.comment : undefined
            ]);
        }

        function writeClip(w, c, tl, offsetR, lane, spineItem, toLocal) {
            var dur = rFrames(c.recOut - c.recIn, tl.rate);
            var startR = clipStart(c, tl);
            var tag, ref;
            if (c.nested) { tag = "ref-clip"; ref = compoundId(c.nested); }
            else { tag = "asset-clip"; ref = assetId(c.media, tl); }
            var attrs = ["ref", ref, "lane", lane ? String(lane) : undefined, "offset", rStr(offsetR), "name", c.name,
                "start", rStr(startR), "duration", rStr(dur), "enabled", c.enabled ? undefined : "0"];
            if (tag === "asset-clip") { attrs.push("tcFormat", tl.rate.drop ? "DF" : "NDF"); }
            var hasKids = c.speed !== 1 || c.markers.length || (spineItem && (spineItem.kids.length || spineItem.markers));
            if (!hasKids) { w.empty(tag, attrs); return; }
            w.open(tag, attrs);
            if (c.speed !== 1) {
                // local time runs at timeline speed from `start`; timeMap maps it to source time
                var sr = M.srcRate(c, tl);
                var srcLen = (c.recOut - c.recIn) / tl.rate.fps * c.speed;
                var endVal = rAdd(startR, rFrames(srcLen * sr.fps, sr));
                w.open("timeMap");
                w.empty("timept", ["time", rStr(startR), "value", rStr(startR), "interp", "linear"]);
                w.empty("timept", ["time", rStr(rAdd(startR, dur)), "value", rStr(endVal), "interp", "linear"]);
                w.close();
            }
            if (spineItem) { writeKids(w, spineItem, toLocal, tl); }
            for (var k = 0; k < c.markers.length; k++) {
                writeMarker(w, c.markers[k], rAdd(startR, rFrames(c.markers[k].frame, tl.rate)), tl);
            }
            w.close();
        }

        var libW = new X.Writer("    ");
        libW.depth = 1;
        libW.open("library");
        libW.open("event", ["name", opts.eventName || "EDL AE Export"]);
        for (var t = 0; t < tls.length; t++) {
            libW.open("project", ["name", tls[t].name]);
            writeSequence(libW, tls[t]);
            libW.close();
        }
        libW.close();
        libW.close();

        var out = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>", "<!DOCTYPE fcpxml>", "", "<fcpxml version=\"1.8\">", "    <resources>"];
        out = out.concat(resW.out);
        out.push("    </resources>");
        out = out.concat(libW.out);
        out.push("</fcpxml>");
        return out.join("\n") + "\n";
    };

    F.write = function (tl, opts) { return [{ suffix: "", text: F.writeMany([tl], opts) }]; };

    F._parseTime = parseTime;
    return F;
}());
