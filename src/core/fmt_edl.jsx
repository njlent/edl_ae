// CMX 3600 EDL.
//
// Reading understands cuts, dissolves (D), wipes/keys (treated as dissolves),
// M2 motion effects, black/aux reels, the common comment lines
// (FROM/TO CLIP NAME, SOURCE FILE, LOC markers) and Resolve "|M:" marker lines.
//
// Writing produces one EDL per video track (CMX has a single picture track),
// with audio events (A, A2, A3...) in the first file.

EDLAE.fmt = EDLAE.fmt || {};
EDLAE.fmt.edl = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model;
    var F = { id: "edl", label: "CMX 3600 EDL (.edl)", ext: "edl", canRead: true, canWrite: true, combinable: false };

    F.sniff = function (text) {
        var head = String(text).substring(0, 6000);
        return /^\s*TITLE:/im.test(head) ||
            /^\s*\d{1,6}\s+\S+\s+\S+\s+[CDWK]\S*\s+(\d+\s+)?\d\d[:;]\d\d[:;]\d\d[:;]\d\d/m.test(head);
    };

    function isBlack(reel) { return /^(BL|BLK|BLACK)$/i.test(reel); }
    function isTrans(tr) { return /^(D|W\d*|K[BO]?)$/i.test(tr); }

    function trackInfo(tr) {
        tr = String(tr).toUpperCase();
        var m;
        if (tr === "V") { return { video: 0, audio: [] }; }
        if ((m = /^V(\d+)$/.exec(tr))) { return { video: Math.max(0, parseInt(m[1], 10) - 1), audio: [] }; }
        if (tr === "B") { return { video: 0, audio: [1] }; }
        if (tr === "A" || tr === "A1") { return { video: -1, audio: [1] }; }
        if (tr === "AA" || tr === "A12") { return { video: -1, audio: [1, 2] }; }
        if (tr === "A/V" || tr === "A1/V") { return { video: 0, audio: [1] }; }
        if (tr === "AA/V") { return { video: 0, audio: [1, 2] }; }
        if ((m = /^A(\d+)$/.exec(tr))) { return { video: -1, audio: [parseInt(m[1], 10)] }; }
        if ((m = /^A(\d+)\/V$/.exec(tr))) { return { video: 0, audio: [parseInt(m[1], 10)] }; }
        return { video: -1, audio: [] };
    }

    // ---- read --------------------------------------------------------------

    function parseEventLine(line) {
        var t = U.trim(line).split(/\s+/);
        if (t.length < 8 || !/^\d+$/.test(t[0])) { return null; }
        var n = t.length;
        for (var i = n - 4; i < n; i++) { if (!TC.isTC(t[i])) { return null; } }
        var mid = t.slice(1, n - 4), dur = 0;
        if (mid.length >= 4 && /^\d+$/.test(mid[mid.length - 1]) && isTrans(mid[mid.length - 2])) {
            dur = parseInt(mid.pop(), 10);
        }
        if (mid.length < 3) { return null; }
        var trans = mid.pop().toUpperCase();
        var track = mid.pop();
        return {
            num: t[0], reel: mid.join(" "), track: track, trans: trans, dur: dur,
            srcIn: t[n - 4], srcOut: t[n - 3], recIn: t[n - 2], recOut: t[n - 1],
            name: "", file: "", m2: null, markerInfo: null
        };
    }

    F.read = function (text, opts) {
        opts = opts || {};
        var baseRate = opts.rate || TC.make(24, false, false);
        var lines = U.lines(U.stripBOM(text));
        var title = "", fcmDrop = null, groups = [], group = null, locs = [], notes = [];
        var i, k;

        for (i = 0; i < lines.length; i++) {
            var line = U.trim(lines[i]), m;
            if (!line) { continue; }
            if ((m = /^TITLE:\s*(.*)$/i.exec(line))) { title = U.trim(m[1]); continue; }
            if ((m = /^FCM:\s*(.*)$/i.exec(line))) {
                fcmDrop = /DROP/i.test(m[1]) && !/NON/i.test(m[1]);
                continue;
            }
            if (/^M2\s/i.test(line)) {
                var mt = line.split(/\s+/);
                if (group && mt.length >= 3) {
                    var m2 = { reel: mt[1], fps: parseFloat(mt[mt.length - 2]), tc: mt[mt.length - 1] };
                    if (mt.length === 3) { m2.fps = parseFloat(mt[2]); m2.tc = ""; }
                    var target = null;
                    for (k = group.lines.length - 1; k >= 0; k--) {
                        if (group.lines[k].reel === m2.reel) { target = group.lines[k]; break; }
                    }
                    (target || group.lines[group.lines.length - 1]).m2 = m2;
                }
                continue;
            }
            var c0 = line.charAt(0);
            if (c0 === "*" || c0 === ">" || c0 === "|" || /\|M:/.test(line)) {
                handleComment(line, group, locs, notes);
                continue;
            }
            var ev = parseEventLine(line);
            if (ev) {
                ev.drop = fcmDrop;
                if (!group || group.num !== ev.num) {
                    group = { num: ev.num, lines: [], comments: [] };
                    groups.push(group);
                }
                group.lines.push(ev);
                continue;
            }
            notes.push(line);
        }

        var drop = fcmDrop !== null ? fcmDrop : baseRate.drop;
        var rate = TC.make(baseRate.base, baseRate.ntsc, drop);

        // Record start: the timecode hour of the first event unless given.
        var minRec = null;
        for (i = 0; i < groups.length; i++) {
            for (k = 0; k < groups[i].lines.length; k++) {
                var r = TC.fromTC(groups[i].lines[k].recIn, rate);
                if (!isNaN(r) && (minRec === null || r < minRec)) { minRec = r; }
            }
        }
        var tl = M.timeline(title || opts.name || "EDL", rate);
        tl.width = opts.width || 1920;
        tl.height = opts.height || 1080;
        tl.start = opts.start !== undefined ? opts.start : (minRec === null ? 0 : TC.hourFloor(minRec, rate));

        var mediaByKey = {};
        function mediaFor(L) {
            var path = L.file ? U.urlToPath(L.file) : "";
            var name = L.name || (path ? U.basename(path) : L.reel);
            var key = (path || name || L.reel).toLowerCase();
            if (!mediaByKey[key]) {
                mediaByKey[key] = M.media({
                    name: name, path: path, reel: /^AX$/i.test(L.reel) ? "" : L.reel,
                    rate: rate, start: 0, startKnown: false, hasVideo: true, hasAudio: false
                });
            }
            return mediaByKey[key];
        }

        function makeClip(L, kind, channel) {
            var recIn = TC.fromTC(L.recIn, rate) - tl.start;
            var recOut = TC.fromTC(L.recOut, rate) - tl.start;
            var srcIn = TC.fromTC(L.srcIn, rate);
            var speed = 1;
            if (L.m2 && !isNaN(L.m2.fps)) {
                speed = L.m2.fps / rate.base;
                if (Math.abs(speed - 1) < 0.005) { speed = 1; }
                speed = Math.round(speed * 10000) / 10000;
            }
            var media = mediaFor(L);
            if (kind === "audio") { media.hasAudio = true; }
            var clip = M.clip({
                name: L.name || media.name || L.reel,
                media: media, recIn: recIn, recOut: recOut, srcIn: srcIn, srcRate: rate,
                speed: speed, channel: channel || 1
            });
            clip.srcOut = M.srcOutFor(clip, tl);
            return clip;
        }

        function tracksFor(L) {
            var info = trackInfo(L.track), out = [], a;
            if (info.video >= 0) { out.push({ kind: "video", track: M.ensureTrack(tl, "video", info.video), channel: 1 }); }
            for (a = 0; a < info.audio.length; a++) {
                out.push({ kind: "audio", track: M.ensureTrack(tl, "audio", info.audio[a] - 1), channel: info.audio[a] });
            }
            return out;
        }

        function addCut(L) {
            if (isBlack(L.reel)) { return; }
            var dests = tracksFor(L);
            for (var d = 0; d < dests.length; d++) {
                var c = makeClip(L, dests[d].kind, dests[d].channel);
                if (c.recOut > c.recIn) { dests[d].track.clips.push(c); }
            }
        }

        function addTransition(from, to) {
            var dests = tracksFor(to);
            var tStart = TC.fromTC(to.recIn, rate) - tl.start;
            var len = to.dur > 0 ? to.dur : 0;
            if (!isTrans(to.trans) || /^W|^K/i.test(to.trans)) {
                notes.push("Event " + to.num + ": " + to.trans + " transition imported as a dissolve.");
            }
            for (var d = 0; d < dests.length; d++) {
                var trk = dests[d].track, outgoing = null, incoming = null, c;
                if (!from || !isBlack(from.reel)) {
                    for (c = trk.clips.length - 1; c >= 0; c--) {
                        if (trk.clips[c].recOut === tStart) { outgoing = trk.clips[c]; break; }
                    }
                }
                if (!isBlack(to.reel)) {
                    incoming = makeClip(to, dests[d].kind, dests[d].channel);
                    if (incoming.recOut > incoming.recIn) { trk.clips.push(incoming); } else { incoming = null; }
                }
                M.applyTransition(tl, outgoing, incoming, tStart, tStart + len);
            }
        }

        for (i = 0; i < groups.length; i++) {
            var g = groups[i];
            applyGroupComments(g);
            if (g.markerInfo) {
                var L0 = g.lines[0];
                tl.markers.push(M.marker({
                    name: g.markerInfo.name, comment: g.markerInfo.comment || "", color: g.markerInfo.color || "",
                    frame: TC.fromTC(L0.recIn, rate) - tl.start, duration: g.markerInfo.duration || 0
                }));
                continue;
            }
            for (k = 0; k < g.lines.length; k++) {
                var L = g.lines[k];
                var nextL = g.lines[k + 1];
                if (nextL && isTrans(nextL.trans) && L.trans === "C" && L.recIn === L.recOut) {
                    addTransition(L, nextL);
                    k++;
                } else if (isTrans(L.trans)) {
                    addTransition(null, L);
                } else {
                    addCut(L);
                }
            }
        }

        for (i = 0; i < locs.length; i++) {
            var f = TC.fromTC(locs[i].tc, rate);
            if (isNaN(f)) { continue; }
            tl.markers.push(M.marker({ name: locs[i].name, color: locs[i].color, frame: f - tl.start }));
        }

        tl.notes = notes;
        M.finalize(tl);
        return [tl];
    };

    function handleComment(line, group, locs, notes) {
        var body = U.trim(line.replace(/^[*>]+/, "")), m;
        if (/\|M:/.test(line)) {
            if (!group) { return; }
            var info = { name: "", color: "", duration: 0, comment: "" };
            if ((m = /\|M:\s*(.*?)\s*(\||$)/.exec(line))) { info.name = m[1]; }
            if ((m = /\|C:\s*(.*?)\s*(\||$)/.exec(line))) { info.color = m[1].replace(/^ResolveColor/i, "").toUpperCase(); }
            if ((m = /\|D:\s*(\d+)/.exec(line))) { info.duration = parseInt(m[1], 10); }
            group.markerInfo = info;
            return;
        }
        if ((m = /^LOC:\s*(\S+)\s+(\S+)\s*(.*)$/i.exec(body))) {
            locs.push({ tc: m[1], color: m[2].toUpperCase(), name: U.trim(m[3]) });
            return;
        }
        if (group) { group.comments.push(body); } else { notes.push(body); }
    }

    function applyGroupComments(g) {
        var first = g.lines[0], last = g.lines[g.lines.length - 1], m;
        for (var i = 0; i < g.comments.length; i++) {
            var c = g.comments[i];
            if ((m = /^FROM CLIP NAME:\s*(.*)$/i.exec(c))) { first.name = U.trim(m[1]); }
            else if ((m = /^TO CLIP NAME:\s*(.*)$/i.exec(c))) { last.name = U.trim(m[1]); }
            else if ((m = /^CLIP NAME:\s*(.*)$/i.exec(c))) { last.name = U.trim(m[1]); }
            else if ((m = /^FROM CLIP:\s*(.*)$/i.exec(c))) { first.file = U.trim(m[1]); } // OTIO: media URL
            else if ((m = /^TO CLIP:\s*(.*)$/i.exec(c))) { last.file = U.trim(m[1]); }
            else if ((m = /^(FROM )?(SOURCE )?FILE( NAME)?:\s*(.*)$/i.exec(c)) && (m[1] || m[2] || m[3])) { first.file = U.trim(m[4]); }
            else if ((m = /^TO (SOURCE )?FILE( NAME)?:\s*(.*)$/i.exec(c))) { last.file = U.trim(m[3]); }
        }
        if (g.lines.length > 1) {
            // A single FROM name on a cut-only group names every line.
            for (var k = 1; k < g.lines.length; k++) {
                if (!g.lines[k].name && !isTrans(g.lines[k].trans) && g.lines[k].reel === first.reel) {
                    g.lines[k].name = first.name;
                    g.lines[k].file = g.lines[k].file || first.file;
                }
            }
        }
    }

    // ---- write -------------------------------------------------------------

    function reelFor(c, opts) {
        var mode = opts.reelMode || "tape", base;
        if (mode === "ax") { return "AX"; }
        if (c.nested) { base = c.nested.name; }
        else if (!c.media) { return "AX"; }
        else if (mode === "name") { base = c.name; }
        else {
            var file = c.media.path ? U.basename(c.media.path) : c.media.name;
            base = U.stripExt(file);
            if (c.media.sequence) { base = base.replace(/[._\-]?\d+$/, ""); }
            if (mode === "tape" && c.media.reel) { base = c.media.reel; }
        }
        return U.sanitizeReel(base, opts.reel8 ? 8 : 0);
    }

    function m2Speed(v) {
        var s = Math.abs(v).toFixed(1), parts = s.split(".");
        return (v < 0 ? "-" : "") + U.padLeft(parts[0], 3, "0") + "." + parts[1];
    }

    function nativePath(p) {
        return /^[A-Za-z]:\//.test(p) || U.startsWith(p, "//") ? String(p).replace(/\//g, "\\") : p;
    }

    var LOC_COLORS = ["RED", "GREEN", "BLUE", "CYAN", "MAGENTA", "YELLOW", "BLACK", "WHITE"];

    function buildEdl(tl, title, videoTrack, audioTracks, markers, opts) {
        var out = ["TITLE: " + title, "FCM: " + (tl.rate.drop ? "DROP FRAME" : "NON-DROP FRAME"), ""];
        var entries = [], i, j;
        if (videoTrack) {
            for (i = 0; i < videoTrack.clips.length; i++) { entries.push({ clip: videoTrack.clips[i], label: "V", v: 0 }); }
        }
        for (j = 0; j < audioTracks.length; j++) {
            for (i = 0; i < audioTracks[j].clips.length; i++) {
                entries.push({ clip: audioTracks[j].clips[i], label: j === 0 ? "A" : "A" + (j + 1), v: 1 + j });
            }
        }
        entries = U.filter(entries, function (e) { return e.clip.enabled || opts.includeDisabled; });
        entries = U.stableSort(entries, function (a, b) { return (a.clip.recIn - b.clip.recIn) || (a.v - b.v); });

        // markers attach to the last picture event starting at or before them
        var locsFor = [];
        for (i = 0; i < markers.length; i++) {
            var best = -1;
            for (j = 0; j < entries.length; j++) {
                if (entries[j].clip.recIn <= markers[i].frame && (best < 0 || entries[j].v === 0)) { best = j; }
            }
            if (best < 0 && entries.length) { best = 0; }
            if (best >= 0) { (locsFor[best] = locsFor[best] || []).push(markers[i]); }
        }

        var num = 0, digits = Math.max(3, String(entries.length).length);
        var recRate = tl.rate;
        for (i = 0; i < entries.length; i++) {
            var c = entries[i].clip;
            num++;
            var reel = reelFor(c, opts);
            var sr = M.srcRate(c, tl);
            var recLen = c.recOut - c.recIn;
            var srcInF = Math.round(c.srcIn);
            // Forward speed changes write the source range actually used, so readers that only
            // look at the M2 line when source and record lengths differ (OTIO, some conform
            // tools) still see the effect. Reverse/freeze keep the nominal length (out > in).
            var srcOutF = c.speed > 0 ? Math.round(c.srcOut) : srcInF + Math.round(recLen / recRate.fps * sr.fps);
            var line = U.padLeft(num, digits, "0") + "  " + U.padRight(reel, 8) + " " + U.padRight(entries[i].label, 5) + " " +
                U.padRight("C", 8) + " " + TC.toTC(srcInF, sr) + " " + TC.toTC(srcOutF, sr) + " " +
                TC.toTC(tl.start + c.recIn, recRate) + " " + TC.toTC(tl.start + c.recOut, recRate);
            out.push(line);
            if (c.speed !== 1) {
                out.push("M2   " + U.padRight(reel, 8) + "       " + m2Speed(c.speed * recRate.base) +
                    "                " + TC.toTC(srcInF, sr));
            }
            if (opts.comments !== false) {
                out.push("* FROM CLIP NAME: " + c.name);
                if (c.media && c.media.path && opts.sourceFile !== false) {
                    out.push("* SOURCE FILE: " + nativePath(c.media.path));
                }
            }
            var locs = locsFor[i] || [];
            for (j = 0; j < locs.length; j++) {
                var col = String(locs[j].color || "").toUpperCase();
                if (!U.contains(LOC_COLORS, col)) { col = "BLUE"; }
                var txt = U.trim(String(locs[j].name || locs[j].comment || "").replace(/[\r\n]+/g, " "));
                out.push("* LOC: " + TC.toTC(tl.start + locs[j].frame, recRate) + " " + U.padRight(col, 7) + " " + txt);
            }
            out.push("");
        }
        return out.join("\r\n");
    }

    // Returns [{suffix, text}]
    F.write = function (tl, opts) {
        opts = opts || {};
        var vids = U.filter(tl.video, function (t) { return t.clips.length > 0; });
        var auds = opts.includeAudio === false ? [] : U.filter(tl.audio, function (t) { return t.clips.length > 0; });
        var markers = opts.markers === false ? [] : tl.markers;
        var files = [], i;
        if (vids.length <= 1) {
            files.push({ suffix: "", text: buildEdl(tl, tl.name, vids[0] || null, auds, markers, opts) });
        } else {
            for (i = 0; i < vids.length; i++) {
                var idx = U.indexOf(tl.video, vids[i]) + 1;
                files.push({
                    suffix: "_V" + idx,
                    text: buildEdl(tl, tl.name + " V" + idx, vids[i], i === 0 ? auds : [], i === 0 ? markers : [], opts)
                });
            }
        }
        return files;
    };

    return F;
}());
