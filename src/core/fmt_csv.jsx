// CSV shot list (export only): one row per clip, all tracks.

EDLAE.fmt = EDLAE.fmt || {};
EDLAE.fmt.csv = (function () {
    var U = EDLAE.util, TC = EDLAE.tc, M = EDLAE.model;
    var F = { id: "csv", label: "CSV shot list (.csv)", ext: "csv", canRead: false, canWrite: true, combinable: false };

    function cell(v) {
        var s = String(v === undefined || v === null ? "" : v);
        return /[",\r\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
    }

    F.write = function (tl, opts) {
        opts = opts || {};
        var rows = [["Track", "Clip", "Reel", "Source In", "Source Out", "Record In", "Record Out",
            "Duration", "Speed %", "Enabled", "File"]];
        var tracks = M.allTracks(tl), i, j;
        for (i = 0; i < tracks.length; i++) {
            if (tracks[i].kind === "audio" && opts.includeAudio === false) { continue; }
            var label = (tracks[i].kind === "audio" ? "A" : "V") + (U.indexOf(tracks[i].kind === "audio" ? tl.audio : tl.video, tracks[i]) + 1);
            for (j = 0; j < tracks[i].clips.length; j++) {
                var c = tracks[i].clips[j], sr = M.srcRate(c, tl);
                rows.push([
                    label, c.name,
                    c.media ? (c.media.reel || "") : (c.nested ? c.nested.name : ""),
                    TC.toTC(Math.round(c.srcIn), sr), TC.toTC(Math.round(c.srcOut), sr),
                    TC.toTC(tl.start + c.recIn, tl.rate), TC.toTC(tl.start + c.recOut, tl.rate),
                    c.recOut - c.recIn, U.fmtNum(c.speed * 100, 2), c.enabled ? "yes" : "no",
                    c.media && c.media.path ? c.media.path : ""
                ]);
            }
        }
        var lines = [];
        for (i = 0; i < rows.length; i++) { lines.push(U.map(rows[i], cell).join(",")); }
        return [{ suffix: "", text: lines.join("\r\n") + "\r\n" }];
    };

    return F;
}());
