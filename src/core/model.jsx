// Shared timeline model. Every reader produces it, every writer consumes it,
// the AE side converts comps to and from it.
//
// Timeline
//   name, id
//   rate            Rate (EDLAE.tc)
//   width, height, pixelAspect
//   start           record timecode of frame 0, in timeline frames
//   duration        timeline frames
//   video[], audio[] Track (index 0 = V1 / A1; higher video tracks sit on top)
//   markers[]       Marker, frame relative to timeline start
//
// Track
//   kind "video"|"audio", name, enabled, clips[] (sorted by recIn)
//
// Clip
//   name
//   kind      "clip" | "generator"
//   media     Media or null (generators, offline names)
//   nested    Timeline or null (nested sequence / precomp)
//   recIn, recOut   timeline frames from timeline start, out exclusive
//   srcIn, srcOut   source frames at srcRate, absolute (include media.start),
//                   srcIn is the first frame played; for reverse speed srcOut < srcIn.
//                   srcOut = srcIn + (recOut-recIn)/rate.fps * speed * srcRate.fps
//   srcRate   Rate of the source frame numbers
//   speed     playback speed, 1 = normal, negative = reverse, 0 = freeze
//   enabled
//   transitionIn / transitionOut   frames of dissolve at head / tail (0 = cut)
//   audioLinked   true when the video clip also carries its media's audio
//   channel   audio source channel (1-based) for audio clips
//   markers[] Marker, frame relative to clip recIn
//
// Media
//   name, path ("C:/dir/file.mov" or "/Volumes/..."), url, reel
//   rate, start (first frame's timecode in media frames), duration (frames)
//   width, height, hasVideo, hasAudio, isStill
//   sequence  {prefix, frame, pad, suffix} for image sequences
//
// Marker
//   name, comment, frame, duration, color

EDLAE.model = (function () {
    var U = EDLAE.util, TC = EDLAE.tc;
    var M = {};
    var nextId = 1;

    M.timeline = function (name, rate) {
        return {
            id: "tl" + (nextId++),
            name: name || "Sequence",
            rate: rate || TC.make(24, false, false),
            width: 1920, height: 1080, pixelAspect: 1,
            start: 0, duration: 0,
            video: [], audio: [], markers: [],
            notes: []
        };
    };

    M.track = function (kind, name) {
        return { kind: kind, name: name || "", enabled: true, clips: [] };
    };

    M.clip = function (props) {
        return U.extend({
            name: "", kind: "clip", media: null, nested: null,
            recIn: 0, recOut: 0, srcIn: 0, srcOut: 0, srcRate: null,
            speed: 1, enabled: true, transitionIn: 0, transitionOut: 0,
            audioLinked: false, channel: 1, markers: []
        }, props);
    };

    M.media = function (props) {
        return U.extend({
            name: "", path: "", url: "", reel: "",
            rate: null, start: 0, startKnown: false, duration: 0,
            width: 0, height: 0, hasVideo: true, hasAudio: false, isStill: false,
            sequence: null
        }, props);
    };

    M.marker = function (props) {
        return U.extend({ name: "", comment: "", frame: 0, duration: 0, color: "" }, props);
    };

    M.ensureTrack = function (tl, kind, index) {
        var list = kind === "audio" ? tl.audio : tl.video;
        while (list.length <= index) {
            list.push(M.track(kind, (kind === "audio" ? "A" : "V") + (list.length + 1)));
        }
        return list[index];
    };

    M.sortTrack = function (track) {
        track.clips = U.stableSort(track.clips, function (a, b) { return a.recIn - b.recIn; });
    };

    M.allTracks = function (tl) { return tl.video.concat(tl.audio); };

    M.clipCount = function (tl) {
        var n = 0, tracks = M.allTracks(tl);
        for (var i = 0; i < tracks.length; i++) { n += tracks[i].clips.length; }
        return n;
    };

    M.computeDuration = function (tl) {
        var end = 0, tracks = M.allTracks(tl), i, j;
        for (i = 0; i < tracks.length; i++) {
            for (j = 0; j < tracks[i].clips.length; j++) {
                if (tracks[i].clips[j].recOut > end) { end = tracks[i].clips[j].recOut; }
            }
        }
        for (i = 0; i < tl.markers.length; i++) {
            var mEnd = tl.markers[i].frame + Math.max(1, tl.markers[i].duration);
            if (mEnd > end) { end = mEnd; }
        }
        return end;
    };

    M.finalize = function (tl) {
        var tracks = M.allTracks(tl);
        for (var i = 0; i < tracks.length; i++) { M.sortTrack(tracks[i]); }
        var d = M.computeDuration(tl);
        if (d > tl.duration) { tl.duration = d; }
        return tl;
    };

    M.srcRate = function (clip, tl) {
        return clip.srcRate || (clip.media && clip.media.rate) || (clip.nested && clip.nested.rate) || tl.rate;
    };

    // Recompute srcOut from srcIn, record length and speed.
    M.srcOutFor = function (clip, tl) {
        var sr = M.srcRate(clip, tl);
        return clip.srcIn + (clip.recOut - clip.recIn) / tl.rate.fps * clip.speed * sr.fps;
    };

    M.mediaKey = function (media) {
        if (!media) { return ""; }
        if (media.path) { return "p:" + U.normSlashes(media.path).toLowerCase(); }
        return "n:" + String(media.name || media.reel).toLowerCase();
    };

    M.summary = function (tl) {
        return TC.label(tl.rate) + " fps, " + tl.video.length + "V/" + tl.audio.length + "A, " +
            M.clipCount(tl) + " clips, " + TC.toTC(tl.duration, TC.make(tl.rate.base, false, false));
    };

    // Shift a clip's head (positive = later) keeping source in sync.
    M.trimHead = function (clip, tl, frames) {
        var sr = M.srcRate(clip, tl);
        clip.recIn += frames;
        clip.srcIn += frames / tl.rate.fps * clip.speed * sr.fps;
    };

    // Shift a clip's tail (positive = later).
    M.trimTail = function (clip, tl, frames) {
        var sr = M.srcRate(clip, tl);
        clip.recOut += frames;
        clip.srcOut += frames / tl.rate.fps * clip.speed * sr.fps;
    };

    // Apply a dissolve centred anywhere in [tStart, tEnd) on a track whose
    // clips still abut at the cut. Outgoing is extended to tEnd, incoming
    // starts at tStart. Either side may be null (fade from/to black).
    M.applyTransition = function (tl, outgoing, incoming, tStart, tEnd) {
        var len = tEnd - tStart;
        if (len <= 0) { return; }
        if (outgoing && outgoing.recOut < tEnd) { M.trimTail(outgoing, tl, tEnd - outgoing.recOut); }
        if (incoming && incoming.recIn > tStart) { M.trimHead(incoming, tl, tStart - incoming.recIn); }
        if (incoming) { incoming.transitionIn = len; }
        else if (outgoing) { outgoing.transitionOut = len; }
    };

    // Find the clips on either side of a transition region on one track.
    M.transitionNeighbours = function (clips, tStart, tEnd) {
        var out = null, inc = null, best, i;
        best = 1e12;
        for (i = 0; i < clips.length; i++) {
            var c = clips[i];
            if (c.recOut >= tStart && c.recOut <= tEnd && c.recIn < tStart) {
                var d = Math.abs(c.recOut - (tStart + tEnd) / 2);
                if (d < best) { best = d; out = c; }
            }
        }
        best = 1e12;
        for (i = 0; i < clips.length; i++) {
            var k = clips[i];
            if (k !== out && k.recIn >= tStart && k.recIn <= tEnd && k.recOut > tEnd) {
                var d2 = Math.abs(k.recIn - (tStart + tEnd) / 2);
                if (d2 < best) { best = d2; inc = k; }
            }
        }
        return { outgoing: out, incoming: inc };
    };

    return M;
}());
