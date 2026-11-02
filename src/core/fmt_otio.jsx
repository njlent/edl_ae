// OpenTimelineIO JSON (.otio). Writes Timeline.1 / Clip.1 / ExternalReference.1,
// ImageSequenceReference.1 for frame sequences and Stack.1 for nested comps.
// Reads Timeline.1 and SerializableCollection.1, Clip.1/Clip.2, gaps,
// transitions, LinearTimeWarp/FreezeFrame and nested stacks/tracks.

EDLAE.fmt = EDLAE.fmt || {};
EDLAE.fmt.otio = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model, J = EDLAE.json;
    var F = { id: "otio", label: "OpenTimelineIO (.otio)", ext: "otio", canRead: true, canWrite: true, combinable: true };

    F.sniff = function (text) { return /"OTIO_SCHEMA"\s*:/.test(String(text).substring(0, 4000)); };

    function schema(o) { return o && o.OTIO_SCHEMA ? String(o.OTIO_SCHEMA).split(".")[0] : ""; }

    // ---- read --------------------------------------------------------------

    function rtSec(rt) { return rt && rt.rate ? rt.value / rt.rate : 0; }

    function firstRate(obj) {
        // depth-first search for any RationalTime rate
        if (!obj || typeof obj !== "object") { return 0; }
        if (schema(obj) === "RationalTime" && obj.rate > 0) { return obj.rate; }
        for (var k in obj) {
            if (obj.hasOwnProperty(k) && typeof obj[k] === "object") {
                var r = firstRate(obj[k]);
                if (r) { return r; }
            }
        }
        return 0;
    }

    F.read = function (text, opts) {
        opts = opts || {};
        var root = J.parse(text), out = [];
        var tls = [];
        if (schema(root) === "Timeline") { tls.push(root); }
        else if (schema(root) === "SerializableCollection") {
            var kids = root.children || [];
            for (var i = 0; i < kids.length; i++) { if (schema(kids[i]) === "Timeline") { tls.push(kids[i]); } }
        } else if (schema(root) === "Stack" || schema(root) === "Track") {
            tls.push({ name: root.name, tracks: schema(root) === "Stack" ? root : { children: [root] } });
        }
        if (!tls.length) { throw new Error("No OTIO timelines found."); }
        for (var t = 0; t < tls.length; t++) { out.push(readTimeline(tls[t], opts)); }
        return out;
    };

    function mediaFromRef(ref, mediaCache, fallbackRate) {
        if (!ref) { return null; }
        var s = schema(ref), path = "", url = "", seq = null;
        if (s === "ExternalReference") {
            url = ref.target_url || "";
            path = U.urlToPath(url);
        } else if (s === "ImageSequenceReference") {
            var pad = ref.frame_zero_padding || 0;
            seq = { prefix: ref.name_prefix || "", frame: ref.start_frame || 0, pad: pad, suffix: ref.name_suffix || "" };
            var base = ref.target_url_base || "";
            if (base && !U.endsWith(base, "/")) { base += "/"; }
            url = base + seq.prefix + U.padLeft(seq.frame, pad, "0") + seq.suffix;
            path = U.urlToPath(url);
        } else if (s !== "MissingReference" && s !== "GeneratorReference") {
            return null;
        }
        if (s === "GeneratorReference") { return null; }
        var ar = ref.available_range;
        var rate = ar && ar.duration && ar.duration.rate ? TC.fromFps(ar.duration.rate, false) :
            (ref.rate ? TC.fromFps(ref.rate, false) : fallbackRate);
        var name = ref.name || (path ? U.basename(path) : "");
        var key = (path || name || "").toLowerCase() || ("missing" + U.keys(mediaCache).length);
        if (mediaCache[key]) { return mediaCache[key]; }
        var md = ref.metadata || {};
        var media = M.media({
            name: name, path: path, url: url, rate: rate,
            start: ar && ar.start_time ? Math.round(rtSec(ar.start_time) * rate.fps) : 0,
            startKnown: !!(ar && ar.start_time),
            duration: ar && ar.duration ? Math.round(rtSec(ar.duration) * rate.fps) : 0,
            hasVideo: true, hasAudio: false, sequence: seq,
            width: (md.edl_ae && md.edl_ae.width) || 0, height: (md.edl_ae && md.edl_ae.height) || 0
        });
        if (seq && media.startKnown === false) { media.start = seq.frame; media.startKnown = true; }
        mediaCache[key] = media;
        return media;
    }

    function readTimeline(obj, opts) {
        var rateNum = (obj.global_start_time && obj.global_start_time.rate) || firstRate(obj.tracks) || (opts.rate ? opts.rate.fps : 24);
        var rate = TC.fromFps(rateNum, false);
        var tl = M.timeline(obj.name || "Timeline", rate);
        var md = (obj.metadata && obj.metadata.edl_ae) || {};
        tl.width = md.width || opts.width || 1920;
        tl.height = md.height || opts.height || 1080;
        if (md.drop) { tl.rate = TC.make(rate.base, rate.ntsc, true); }
        tl.start = obj.global_start_time ? Math.round(rtSec(obj.global_start_time) * rate.fps) : 0;
        readStack(obj.tracks || {}, tl, {}, 0);
        var mk = (obj.tracks && obj.tracks.markers) || [];
        var end = M.computeDuration(tl);
        for (var i = 0; i < mk.length; i++) {
            var m = readMarker(mk[i], tl.rate);
            if (tl.start > 0 && m.frame >= tl.start && m.frame - tl.start <= end) { m.frame -= tl.start; }
            tl.markers.push(m);
        }
        return M.finalize(tl);
    }

    function readMarker(mk, rate) {
        var mr = mk.marked_range || {};
        return M.marker({
            name: mk.name || "", comment: mk.comment || "", color: mk.color || "",
            frame: Math.round(rtSec(mr.start_time) * rate.fps),
            duration: Math.round(rtSec(mr.duration) * rate.fps)
        });
    }

    // Read a Stack into tl's tracks. nestedCache maps nothing across files; nested stacks are separate timelines.
    function readStack(stack, tl, mediaCache, depth) {
        var tracks = stack.children || [], vi = 0, ai = 0;
        for (var t = 0; t < tracks.length; t++) {
            if (schema(tracks[t]) !== "Track") { continue; }
            var kind = String(tracks[t].kind || "Video").toLowerCase() === "audio" ? "audio" : "video";
            var track = M.ensureTrack(tl, kind, kind === "audio" ? ai++ : vi++);
            if (tracks[t].name) { track.name = tracks[t].name; }
            track.enabled = tracks[t].enabled !== false;
            readTrack(tracks[t], track, tl, mediaCache, depth);
        }
    }

    function readTrack(trackObj, track, tl, mediaCache, depth) {
        var items = trackObj.children || [], cursor = 0, pending = null, i, k;
        var fps = tl.rate.fps;
        for (i = 0; i < items.length; i++) {
            var it = items[i], s = schema(it);
            if (s === "Transition") {
                pending = {
                    inOff: Math.round(rtSec(it.in_offset) * fps),
                    outOff: Math.round(rtSec(it.out_offset) * fps),
                    prev: track.clips.length ? track.clips[track.clips.length - 1] : null,
                    at: cursor
                };
                continue;
            }
            var sr = it.source_range;
            var durSec = sr ? rtSec(sr.duration) : 0;
            var clip = null;
            if (s === "Clip") {
                var ref = it.media_reference;
                if (it.media_references) { ref = it.media_references[it.active_media_reference_key || "DEFAULT_MEDIA"]; }
                var media = mediaFromRef(ref, mediaCache, tl.rate);
                if (!sr && ref && ref.available_range) { sr = ref.available_range; durSec = rtSec(sr.duration); }
                var srcRate = media ? media.rate : (sr && sr.start_time && sr.start_time.rate ? TC.fromFps(sr.start_time.rate) : tl.rate);
                clip = M.clip({
                    name: it.name || (media ? media.name : "Clip"),
                    kind: media ? "clip" : "generator", media: media,
                    srcIn: sr ? Math.round(rtSec(sr.start_time) * srcRate.fps) : 0, srcRate: srcRate,
                    enabled: it.enabled !== false
                });
                if (media && track.kind === "audio") {
                    media.hasAudio = true;
                    if (U.isAudioExt(U.ext(media.path || media.name))) { media.hasVideo = false; }
                }
            } else if (s === "Stack" || s === "Track") {
                var nested = M.timeline(it.name || "Nested", tl.rate);
                nested.width = tl.width;
                nested.height = tl.height;
                if (s === "Stack") { readStack(it, nested, mediaCache, depth + 1); }
                else {
                    var nk = String(it.kind || "Video").toLowerCase() === "audio" ? "audio" : "video";
                    readTrack(it, M.ensureTrack(nested, nk, 0), nested, mediaCache, depth + 1);
                }
                M.finalize(nested);
                clip = M.clip({
                    name: it.name || "Nested", nested: nested,
                    srcIn: sr ? Math.round(rtSec(sr.start_time) * tl.rate.fps) : 0, srcRate: tl.rate,
                    enabled: it.enabled !== false
                });
                if (!sr) { durSec = nested.duration / tl.rate.fps; }
            } else if (s !== "Gap") {
                if (sr) { cursor += Math.round(durSec * fps); }
                continue;
            }
            var len = Math.round(durSec * fps);
            if (clip) {
                clip.recIn = cursor;
                clip.recOut = cursor + len;
                var effects = it.effects || [];
                for (k = 0; k < effects.length; k++) {
                    var es = schema(effects[k]);
                    if (es === "LinearTimeWarp") { clip.speed = Number(effects[k].time_scalar); }
                    if (es === "FreezeFrame") { clip.speed = 0; }
                }
                if (isNaN(clip.speed)) { clip.speed = 1; }
                clip.srcOut = M.srcOutFor(clip, tl);
                var mks = it.markers || [];
                for (k = 0; k < mks.length; k++) {
                    var mk = readMarker(mks[k], tl.rate);
                    // clip markers are in source time; make them clip-relative
                    mk.frame = Math.round((mk.frame - clip.srcIn / M.srcRate(clip, tl).fps * fps) / (clip.speed || 1));
                    clip.markers.push(mk);
                }
                if (clip.recOut > clip.recIn) { track.clips.push(clip); }
            }
            if (pending) {
                var tStart = pending.at - pending.inOff, tEnd = pending.at + pending.outOff;
                M.applyTransition(tl, pending.prev, clip && clip.recIn === pending.at ? clip : null, tStart, tEnd);
                pending = null;
            }
            cursor += len;
        }
        if (pending) { M.applyTransition(tl, pending.prev, null, pending.at - pending.inOff, pending.at + pending.outOff); }
    }

    // ---- write -------------------------------------------------------------

    function RT(frames, rate) { return { OTIO_SCHEMA: "RationalTime.1", rate: J.F(rate), value: J.F(frames) }; }
    function TR(start, dur, rate) { return { OTIO_SCHEMA: "TimeRange.1", duration: RT(dur, rate), start_time: RT(start, rate) }; }

    function markerObj(mk, frame, rate) {
        return {
            OTIO_SCHEMA: "Marker.2", metadata: {}, name: mk.name || "",
            color: mk.color && /^(PINK|RED|ORANGE|YELLOW|GREEN|CYAN|BLUE|PURPLE|MAGENTA|BLACK|WHITE)$/i.test(mk.color) ? String(mk.color).toUpperCase() : "RED",
            marked_range: TR(frame, mk.duration || 0, rate),
            comment: mk.comment || ""
        };
    }

    function refFor(media, tl) {
        if (!media) { return { OTIO_SCHEMA: "MissingReference.1", metadata: {}, name: "", available_range: null, available_image_bounds: null }; }
        var rate = (media.rate || tl.rate).fps;
        var ar = media.duration > 0 ? TR(media.start || 0, media.duration, rate) : null;
        var md = { edl_ae: { width: media.width || 0, height: media.height || 0 } };
        if (!media.path) {
            return { OTIO_SCHEMA: "MissingReference.1", metadata: md, name: media.name, available_range: ar, available_image_bounds: null };
        }
        if (media.sequence) {
            var dir = U.dirname(media.path);
            return {
                OTIO_SCHEMA: "ImageSequenceReference.1", metadata: md, name: media.name,
                available_range: ar, available_image_bounds: null,
                target_url_base: U.pathToUrl(dir, false) + "/",
                name_prefix: media.sequence.prefix, name_suffix: media.sequence.suffix,
                start_frame: media.sequence.frame, frame_step: 1, rate: J.F(rate),
                frame_zero_padding: media.sequence.pad, missing_frame_policy: "error"
            };
        }
        return {
            OTIO_SCHEMA: "ExternalReference.1", metadata: md, name: media.name,
            available_range: ar, available_image_bounds: null,
            target_url: U.pathToUrl(media.path, false)
        };
    }

    function stackObj(tl, name, sourceRange) {
        var tracks = [], i;
        for (i = 0; i < tl.video.length; i++) { tracks.push(trackObj(tl, tl.video[i], "Video")); }
        for (i = 0; i < tl.audio.length; i++) { tracks.push(trackObj(tl, tl.audio[i], "Audio")); }
        return {
            OTIO_SCHEMA: "Stack.1", metadata: {}, name: name, source_range: sourceRange || null,
            effects: [], markers: [], enabled: true, children: tracks
        };
    }

    function trackObj(tl, track, kind) {
        var children = [], cursor = 0, fps = tl.rate.fps;
        for (var i = 0; i < track.clips.length; i++) {
            var c = track.clips[i];
            if (c.recIn < cursor) { continue; } // overlaps can't live on one OTIO track
            if (c.recIn > cursor) {
                children.push({
                    OTIO_SCHEMA: "Gap.1", metadata: {}, name: "", source_range: TR(0, c.recIn - cursor, fps),
                    effects: [], markers: [], enabled: true
                });
            }
            var sr = M.srcRate(c, tl);
            var recLen = c.recOut - c.recIn;
            var srcDur = recLen / fps * sr.fps;
            var effects = [];
            if (c.speed !== 1) {
                effects.push(c.speed === 0 ?
                    { OTIO_SCHEMA: "FreezeFrame.1", metadata: {}, name: "", effect_name: "FreezeFrame", time_scalar: J.F(0) } :
                    { OTIO_SCHEMA: "LinearTimeWarp.1", metadata: {}, name: "", effect_name: "LinearTimeWarp", time_scalar: J.F(c.speed) });
            }
            var markers = [];
            for (var k = 0; k < c.markers.length; k++) {
                markers.push(markerObj(c.markers[k], c.srcIn + c.markers[k].frame / fps * (c.speed || 1) * sr.fps, sr.fps));
            }
            if (c.nested) {
                var st = stackObj(c.nested, c.name, TR(c.srcIn - TC.convert(c.nested.start, c.nested.rate, sr), srcDur, sr.fps));
                st.effects = effects;
                st.markers = markers;
                st.enabled = c.enabled;
                children.push(st);
            } else {
                children.push({
                    OTIO_SCHEMA: "Clip.1", metadata: {}, name: c.name,
                    source_range: TR(c.srcIn, srcDur, sr.fps),
                    effects: effects, markers: markers, enabled: c.enabled,
                    media_reference: refFor(c.media, tl)
                });
            }
            cursor = c.recOut;
        }
        return {
            OTIO_SCHEMA: "Track.1", metadata: {}, name: track.name || "", source_range: null,
            effects: [], markers: [], enabled: track.enabled, children: children, kind: kind
        };
    }

    function timelineObj(tl, opts) {
        var st = stackObj(tl, "tracks", null);
        if (opts.markers !== false) {
            for (var i = 0; i < tl.markers.length; i++) { st.markers.push(markerObj(tl.markers[i], tl.markers[i].frame, tl.rate.fps)); }
        }
        return {
            OTIO_SCHEMA: "Timeline.1",
            metadata: { edl_ae: { width: tl.width, height: tl.height, drop: tl.rate.drop } },
            name: tl.name,
            global_start_time: RT(tl.start, tl.rate.fps),
            tracks: st
        };
    }

    F.writeMany = function (tls, opts) {
        opts = opts || {};
        var obj;
        if (tls.length === 1) { obj = timelineObj(tls[0], opts); }
        else {
            var kids = [];
            for (var i = 0; i < tls.length; i++) { kids.push(timelineObj(tls[i], opts)); }
            obj = { OTIO_SCHEMA: "SerializableCollection.1", metadata: {}, name: opts.projectName || "EDL AE Export", children: kids };
        }
        return J.stringify(obj, "    ") + "\n";
    };

    F.write = function (tl, opts) { return [{ suffix: "", text: F.writeMany([tl], opts) }]; };

    return F;
}());
