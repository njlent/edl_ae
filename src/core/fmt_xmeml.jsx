// Final Cut Pro 7 XML (xmeml v4/v5). Read and written by Premiere Pro,
// DaVinci Resolve, Avid (via tools), Nuke Studio and most conform tools.

EDLAE.fmt = EDLAE.fmt || {};
EDLAE.fmt.xmeml = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model, X = EDLAE.xml;
    var F = { id: "xmeml", label: "Final Cut Pro 7 XML (.xml)", ext: "xml", canRead: true, canWrite: true, combinable: true };

    F.sniff = function (text) { return /<xmeml[\s>]/.test(String(text).substring(0, 4000)); };

    var PAR = [["square", 1], ["NTSC-601", 10 / 11], ["PAL-601", 59 / 54], ["HD-(1440x1080)", 4 / 3],
        ["HD-(960x720)", 4 / 3], ["DVCPROHD-(1280x1080)", 1.5], ["NTSC-CCIR-601", 10 / 11], ["PAL-CCIR-601", 59 / 54]];

    function parPar(s) {
        for (var i = 0; i < PAR.length; i++) { if (PAR[i][0].toLowerCase() === String(s).toLowerCase()) { return PAR[i][1]; } }
        return 1;
    }

    function parName(v) {
        var best = PAR[0], d = 1e9;
        for (var i = 0; i < 6; i++) {
            if (Math.abs(PAR[i][1] - v) < d) { d = Math.abs(PAR[i][1] - v); best = PAR[i]; }
        }
        return best[0];
    }

    function parseRate(el) {
        if (!el) { return null; }
        var base = X.num(el, "timebase", NaN);
        if (isNaN(base) || base <= 0) { return null; }
        return TC.make(base, U.bool(X.text(el, "ntsc")), false);
    }

    // ---- read --------------------------------------------------------------

    F.read = function (text, opts) {
        opts = opts || {};
        var root = X.parse(text);
        if (root.tag !== "xmeml") { throw new Error("Not an FCP7 XML file (root is <" + root.tag + ">)."); }

        var seqDefs = {}, fileDefs = {}, i;
        var allSeq = X.findAll(root, "sequence");
        for (i = 0; i < allSeq.length; i++) {
            if (allSeq[i].kids.length && allSeq[i].attrs.id) { seqDefs[allSeq[i].attrs.id] = allSeq[i]; }
        }
        var allFiles = X.findAll(root, "file");
        for (i = 0; i < allFiles.length; i++) {
            if (allFiles[i].kids.length && allFiles[i].attrs.id) { fileDefs[allFiles[i].attrs.id] = allFiles[i]; }
        }

        var seqCache = {}, mediaCache = {};

        function parseFile(fileEl, fallbackRate) {
            if (!fileEl) { return null; }
            var id = fileEl.attrs.id;
            if (!fileEl.kids.length && id && fileDefs[id]) { fileEl = fileDefs[id]; }
            if (id && mediaCache[id]) { return mediaCache[id]; }
            var rate = parseRate(X.child(fileEl, "rate")) || fallbackRate;
            var tcEl = X.child(fileEl, "timecode"), start = NaN;
            if (tcEl) {
                var tcRate = parseRate(X.child(tcEl, "rate")) || rate;
                if (X.text(tcEl, "displayformat") === "DF") { tcRate = TC.make(tcRate.base, tcRate.ntsc, true); }
                start = X.num(tcEl, "frame", NaN);
                if (isNaN(start) && X.text(tcEl, "string")) { start = TC.fromTC(X.text(tcEl, "string"), tcRate); }
                if (!isNaN(start) && tcRate.base !== rate.base) { start = Math.round(TC.convert(start, tcRate, rate)); }
            }
            var url = X.text(fileEl, "pathurl"), path = U.urlToPath(url);
            var vsc = X.path(fileEl, "media/video/samplecharacteristics");
            var hasV = !!X.path(fileEl, "media/video"), hasA = !!X.path(fileEl, "media/audio");
            if (!X.child(fileEl, "media")) { hasV = true; }
            var media = M.media({
                name: X.text(fileEl, "name") || (path ? U.basename(path) : id || "offline"),
                path: path, url: url,
                reel: X.text(tcEl, "reel/name"),
                rate: rate, start: isNaN(start) ? 0 : start, startKnown: !isNaN(start),
                duration: X.num(fileEl, "duration", 0),
                width: X.num(vsc, "width", 0), height: X.num(vsc, "height", 0),
                hasVideo: hasV, hasAudio: hasA
            });
            if (hasV && path && U.isImageExt(U.ext(path)) && media.duration > 1) {
                media.sequence = U.parseFrameFile(U.basename(path));
            }
            if (id) { mediaCache[id] = media; }
            return media;
        }

        function timeRemap(el) {
            var speed = 1, reverse = false, filters = X.children(el, "filter");
            for (var f = 0; f < filters.length; f++) {
                var eff = X.child(filters[f], "effect");
                if (!eff) { continue; }
                if (X.text(eff, "effectid") !== "timeremap" && !/time\s*remap/i.test(X.text(eff, "name"))) { continue; }
                var params = X.children(eff, "parameter");
                for (var p = 0; p < params.length; p++) {
                    var pid = X.text(params[p], "parameterid");
                    if (pid === "speed") { speed = U.toFloat(X.text(params[p], "value"), 100) / 100; }
                    if (pid === "reverse") { reverse = U.bool(X.text(params[p], "value")); }
                }
            }
            if (reverse && speed > 0) { speed = -speed; }
            return speed;
        }

        function parseItem(el, tl, kind) {
            var isGen = el.tag === "generatoritem";
            var sr = parseRate(X.child(el, "rate")) || tl.rate;
            var start = X.num(el, "start", -1), end = X.num(el, "end", -1);
            var inF = X.num(el, "in", 0), outF = X.num(el, "out", 0);
            var speed = isGen ? 1 : timeRemap(el);
            if (Math.abs(speed) < 1e-6) { speed = 0; }
            var tlLen = speed !== 0 ? Math.round((outF - inF) / sr.fps / Math.abs(speed) * tl.rate.fps) : (end - start);
            if (start < 0 && end >= 0) { start = end - tlLen; }
            if (end < 0 && start >= 0) { end = start + tlLen; }
            if (start < 0 && end < 0) { return null; }

            var media = null, nested = null, mediaStart = 0;
            if (!isGen) {
                var seqEl = X.child(el, "sequence");
                if (seqEl) {
                    nested = parseSequence(seqEl);
                    mediaStart = TC.convert(nested.start, nested.rate, sr);
                } else {
                    media = parseFile(X.child(el, "file"), sr);
                    if (media) { mediaStart = TC.convert(media.start, media.rate || sr, sr); }
                }
            }
            var clip = M.clip({
                name: X.text(el, "name") || (media ? media.name : "") || X.text(el, "effect/name") || "Clip",
                kind: isGen || (!media && !nested) ? "generator" : "clip",
                media: media, nested: nested,
                recIn: start, recOut: end,
                srcIn: mediaStart + (speed < 0 ? outF : inF),
                srcRate: sr, speed: speed,
                enabled: X.text(el, "enabled") !== "FALSE"
            });
            clip.srcOut = M.srcOutFor(clip, tl);
            if (kind === "audio") { clip.channel = X.num(el, "sourcetrack/trackindex", 1); }
            var mks = X.children(el, "marker");
            for (var k = 0; k < mks.length; k++) {
                var mIn = X.num(mks[k], "in", 0), mOut = X.num(mks[k], "out", -1);
                var rel = speed !== 0 ? (mIn - inF) / sr.fps / speed * tl.rate.fps : 0;
                clip.markers.push(M.marker({
                    name: X.text(mks[k], "name"), comment: X.text(mks[k], "comment"),
                    frame: Math.round(rel), duration: mOut > mIn ? Math.round((mOut - mIn) / sr.fps * tl.rate.fps) : 0
                }));
            }
            return clip;
        }

        function parseTrack(trkEl, tl, kind, idx) {
            var track = M.ensureTrack(tl, kind, idx);
            track.enabled = X.text(trkEl, "enabled") !== "FALSE";
            var transitions = [], k;
            for (k = 0; k < trkEl.kids.length; k++) {
                var it = trkEl.kids[k];
                if (it.tag === "clipitem" || it.tag === "generatoritem") {
                    var c = parseItem(it, tl, kind);
                    if (c && c.recOut > c.recIn) { track.clips.push(c); }
                } else if (it.tag === "transitionitem") {
                    transitions.push({
                        start: X.num(it, "start", 0), end: X.num(it, "end", 0),
                        alignment: X.text(it, "alignment")
                    });
                }
            }
            M.sortTrack(track);
            for (k = 0; k < transitions.length; k++) {
                var t = transitions[k], nb = M.transitionNeighbours(track.clips, t.start, t.end);
                if (t.alignment === "start-black") { nb.outgoing = null; }
                if (t.alignment === "end-black") { nb.incoming = null; }
                M.applyTransition(tl, nb.outgoing, nb.incoming, t.start, t.end);
            }
        }

        function parseSequence(el) {
            var id = el.attrs.id;
            if (id && seqCache[id]) { return seqCache[id]; }
            if (!el.kids.length && id && seqDefs[id]) { el = seqDefs[id]; }
            var rate = parseRate(X.child(el, "rate")) || opts.rate || TC.make(24, false, false);
            var tl = M.timeline(X.text(el, "name") || id || "Sequence", rate);
            if (id) { seqCache[id] = tl; }
            var tcEl = X.child(el, "timecode");
            var drop = tcEl && X.text(tcEl, "displayformat") === "DF";
            tl.rate = TC.make(rate.base, rate.ntsc, drop);
            if (tcEl) {
                var st = X.num(tcEl, "frame", NaN);
                if (isNaN(st) && X.text(tcEl, "string")) { st = TC.fromTC(X.text(tcEl, "string"), tl.rate); }
                tl.start = isNaN(st) ? 0 : st;
            }
            var sc = X.path(el, "media/video/format/samplecharacteristics");
            tl.width = X.num(sc, "width", 1920);
            tl.height = X.num(sc, "height", 1080);
            tl.pixelAspect = sc && X.text(sc, "pixelaspectratio") ? parPar(X.text(sc, "pixelaspectratio")) : 1;
            tl.duration = X.num(el, "duration", 0);

            var vt = X.children(X.path(el, "media/video"), "track"), k;
            for (k = 0; k < vt.length; k++) { parseTrack(vt[k], tl, "video", k); }
            var at = X.children(X.path(el, "media/audio"), "track");
            for (k = 0; k < at.length; k++) { parseTrack(at[k], tl, "audio", k); }

            var mks = X.children(el, "marker");
            for (k = 0; k < mks.length; k++) {
                var mIn = X.num(mks[k], "in", 0), mOut = X.num(mks[k], "out", -1);
                tl.markers.push(M.marker({
                    name: X.text(mks[k], "name"), comment: X.text(mks[k], "comment"),
                    frame: mIn, duration: mOut > mIn ? mOut - mIn : 0
                }));
            }
            return M.finalize(tl);
        }

        var tops = X.findAll(root, "sequence", ["clipitem", "generatoritem"]), out = [];
        for (i = 0; i < tops.length; i++) {
            if (tops[i].kids.length) { out.push(parseSequence(tops[i])); }
        }
        if (!out.length) { throw new Error("No sequences found in this XML file."); }
        return out;
    };

    // ---- write -------------------------------------------------------------

    function writeRate(w, rate) {
        w.open("rate");
        w.leaf("timebase", rate.base);
        w.leaf("ntsc", rate.ntsc ? "TRUE" : "FALSE");
        w.close();
    }

    function writeTimecode(w, frames, rate, reel) {
        w.open("timecode");
        writeRate(w, rate);
        w.leaf("string", TC.toTC(frames, rate));
        w.leaf("frame", Math.round(frames));
        w.leaf("displayformat", rate.drop ? "DF" : "NDF");
        if (reel) { w.open("reel"); w.leaf("name", reel); w.close(); }
        w.close();
    }

    function writeFile(w, media, tl, ctx) {
        var key = M.mediaKey(media);
        if (ctx.files[key]) { w.empty("file", ["id", ctx.files[key]]); return; }
        var id = "file-" + (ctx.nextFile++);
        ctx.files[key] = id;
        var rate = media.rate || tl.rate;
        w.open("file", ["id", id]);
        w.leaf("name", media.path ? U.basename(media.path) : media.name);
        if (media.path) { w.leaf("pathurl", U.pathToUrl(media.path, true)); }
        writeRate(w, rate);
        w.leaf("duration", Math.max(1, Math.round(media.duration || 0)));
        writeTimecode(w, media.start || 0, rate, media.reel);
        w.open("media");
        if (media.hasVideo) {
            w.open("video");
            w.open("samplecharacteristics");
            writeRate(w, rate);
            w.leaf("width", media.width || tl.width);
            w.leaf("height", media.height || tl.height);
            w.leaf("anamorphic", "FALSE");
            w.leaf("pixelaspectratio", "square");
            w.leaf("fielddominance", "none");
            w.close();
            w.close();
        }
        if (media.hasAudio) {
            w.open("audio");
            w.open("samplecharacteristics");
            w.leaf("depth", 16);
            w.leaf("samplerate", 48000);
            w.close();
            w.leaf("channelcount", 2);
            w.close();
        }
        w.close();
        w.close();
    }

    function writeTimeRemap(w, speed) {
        w.open("filter");
        w.open("effect");
        w.leaf("name", "Time Remap");
        w.leaf("effectid", "timeremap");
        w.leaf("effectcategory", "motion");
        w.leaf("effecttype", "motion");
        w.leaf("mediatype", "video");
        w.open("parameter", ["authoringApp", "PremierePro"]);
        w.leaf("parameterid", "variablespeed"); w.leaf("name", "variablespeed");
        w.leaf("valuemin", 0); w.leaf("valuemax", 1); w.leaf("value", 0);
        w.close();
        w.open("parameter", ["authoringApp", "PremierePro"]);
        w.leaf("parameterid", "speed"); w.leaf("name", "speed");
        w.leaf("valuemin", -100000); w.leaf("valuemax", 100000); w.leaf("value", U.fmtNum(Math.abs(speed) * 100, 4));
        w.close();
        w.open("parameter", ["authoringApp", "PremierePro"]);
        w.leaf("parameterid", "reverse"); w.leaf("name", "reverse"); w.leaf("value", speed < 0 ? "TRUE" : "FALSE");
        w.close();
        w.open("parameter", ["authoringApp", "PremierePro"]);
        w.leaf("parameterid", "frameblending"); w.leaf("name", "frameblending"); w.leaf("value", "FALSE");
        w.close();
        w.close();
        w.close();
    }

    function writeMarkers(w, markers, toFrame, durScale) {
        for (var i = 0; i < markers.length; i++) {
            var mk = markers[i], f = Math.round(toFrame(mk.frame));
            w.open("marker");
            w.leaf("comment", mk.comment || "");
            w.leaf("name", mk.name || "");
            w.leaf("in", f);
            w.leaf("out", mk.duration > 0 ? f + Math.round(mk.duration * durScale) : -1);
            w.close();
        }
    }

    function writeClip(w, c, tl, kind, ctx) {
        var sr = M.srcRate(c, tl);
        var mediaStart = 0, mediaDur;
        if (c.nested) {
            mediaStart = TC.convert(c.nested.start, c.nested.rate, sr);
            mediaDur = TC.convert(c.nested.duration, c.nested.rate, sr);
        } else if (c.media) {
            mediaStart = TC.convert(c.media.start || 0, c.media.rate || sr, sr);
            mediaDur = TC.convert(c.media.duration || 0, c.media.rate || sr, sr);
        }
        var a = Math.min(c.srcIn, c.srcOut) - mediaStart, b = Math.max(c.srcIn, c.srcOut) - mediaStart;
        if (!c.nested && !c.media) { a = 0; b = c.recOut - c.recIn; }
        if (!(mediaDur > 0)) { mediaDur = b; }

        w.open("clipitem", ["id", "clipitem-" + (ctx.nextClip++)]);
        w.leaf("name", c.name);
        w.leaf("enabled", c.enabled ? "TRUE" : "FALSE");
        w.leaf("duration", Math.max(1, Math.round(mediaDur)));
        writeRate(w, sr);
        w.leaf("start", Math.round(c.recIn));
        w.leaf("end", Math.round(c.recOut));
        w.leaf("in", Math.round(a));
        w.leaf("out", Math.round(b));
        if (c.nested) {
            writeSequence(w, c.nested, ctx);
        } else if (c.media) {
            writeFile(w, c.media, tl, ctx);
        } else {
            writeFile(w, M.media({ name: c.name, rate: sr, duration: b, hasVideo: kind === "video", hasAudio: kind === "audio" }), tl, ctx);
        }
        if (kind === "audio") {
            w.open("sourcetrack");
            w.leaf("mediatype", "audio");
            w.leaf("trackindex", c.channel || 1);
            w.close();
        }
        if (c.speed !== 1) { writeTimeRemap(w, c.speed); }
        if (c.markers.length) {
            var sp = c.speed || 1;
            writeMarkers(w, c.markers, function (f) {
                return a + f / tl.rate.fps * Math.abs(sp) * sr.fps;
            }, Math.abs(sp) * sr.fps / tl.rate.fps);
        }
        w.close();
    }

    function writeSequence(w, tl, ctx) {
        if (ctx.seqs[tl.id]) { w.empty("sequence", ["id", ctx.seqs[tl.id]]); return; }
        var id = "sequence-" + (ctx.nextSeq++), i, j;
        ctx.seqs[tl.id] = id;
        w.open("sequence", ["id", id]);
        w.leaf("name", tl.name);
        w.leaf("duration", Math.max(1, Math.round(tl.duration)));
        writeRate(w, tl.rate);
        w.open("media");
        w.open("video");
        w.open("format");
        w.open("samplecharacteristics");
        writeRate(w, tl.rate);
        w.leaf("width", tl.width);
        w.leaf("height", tl.height);
        w.leaf("anamorphic", "FALSE");
        w.leaf("pixelaspectratio", parName(tl.pixelAspect || 1));
        w.leaf("fielddominance", "none");
        w.close();
        w.close();
        var vids = tl.video.length ? tl.video : [M.track("video", "V1")];
        for (i = 0; i < vids.length; i++) {
            w.open("track");
            for (j = 0; j < vids[i].clips.length; j++) { writeClip(w, vids[i].clips[j], tl, "video", ctx); }
            w.leaf("enabled", vids[i].enabled ? "TRUE" : "FALSE");
            w.leaf("locked", "FALSE");
            w.close();
        }
        w.close();
        w.open("audio");
        w.leaf("numOutputChannels", 2);
        w.open("format");
        w.open("samplecharacteristics");
        w.leaf("depth", 16);
        w.leaf("samplerate", 48000);
        w.close();
        w.close();
        for (i = 0; i < tl.audio.length; i++) {
            w.open("track");
            for (j = 0; j < tl.audio[i].clips.length; j++) { writeClip(w, tl.audio[i].clips[j], tl, "audio", ctx); }
            w.leaf("enabled", tl.audio[i].enabled ? "TRUE" : "FALSE");
            w.leaf("locked", "FALSE");
            w.leaf("outputchannelindex", i % 2 + 1);
            w.close();
        }
        w.close();
        w.close();
        writeTimecode(w, tl.start, tl.rate, "");
        writeMarkers(w, tl.markers, function (f) { return f; }, 1);
        w.close();
    }

    F.writeMany = function (tls, opts) {
        opts = opts || {};
        var w = new X.Writer("\t");
        var ctx = { files: {}, seqs: {}, nextFile: 1, nextClip: 1, nextSeq: 1 };
        w.raw("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        w.raw("<!DOCTYPE xmeml>");
        w.open("xmeml", ["version", "4"]);
        if (tls.length === 1) {
            writeSequence(w, tls[0], ctx);
        } else {
            w.open("project");
            w.leaf("name", opts.projectName || "EDL AE Export");
            w.open("children");
            for (var i = 0; i < tls.length; i++) { writeSequence(w, tls[i], ctx); }
            w.close();
            w.close();
        }
        w.close();
        return w.toString();
    };

    F.write = function (tl, opts) { return [{ suffix: "", text: F.writeMany([tl], opts) }]; };

    return F;
}());
