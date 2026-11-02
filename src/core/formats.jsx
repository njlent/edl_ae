// Format registry: detection, reading, writing.

EDLAE.formats = (function () {
    var U = EDLAE.util, M = EDLAE.model;
    var R = {};

    R.list = [EDLAE.fmt.edl, EDLAE.fmt.xmeml, EDLAE.fmt.fcpxml, EDLAE.fmt.otio, EDLAE.fmt.csv];

    R.byId = function (id) {
        for (var i = 0; i < R.list.length; i++) { if (R.list[i].id === id) { return R.list[i]; } }
        return null;
    };

    R.readable = function () { return U.filter(R.list, function (f) { return f.canRead; }); };
    R.writable = function () { return U.filter(R.list, function (f) { return f.canWrite; }); };

    // Content sniffing first, extension second.
    R.detect = function (fileName, text) {
        var order = [EDLAE.fmt.otio, EDLAE.fmt.fcpxml, EDLAE.fmt.xmeml, EDLAE.fmt.edl], i;
        for (i = 0; i < order.length; i++) { if (order[i].sniff(text)) { return order[i]; } }
        var ext = U.ext(fileName);
        if (ext === "xml") { return EDLAE.fmt.xmeml; }
        for (i = 0; i < R.list.length; i++) { if (R.list[i].canRead && R.list[i].ext === ext) { return R.list[i]; } }
        return null;
    };

    // -> {format, timelines, notes}
    R.read = function (fileName, text, opts) {
        var fmt = (opts && opts.format && R.byId(opts.format)) || R.detect(fileName, text);
        if (!fmt) { throw new Error("Unrecognised file format: " + U.basename(fileName)); }
        var o = U.extend({}, opts || {});
        if (!o.name) { o.name = U.stripExt(U.basename(fileName)); }
        var tls = fmt.read(text, o);
        var notes = [];
        for (var i = 0; i < tls.length; i++) { notes = notes.concat(tls[i].notes || []); }
        return { format: fmt, timelines: tls, notes: notes };
    };

    // Nested timelines first so references resolve in formats that define-once.
    R.dependencyOrder = function (tls) {
        var seen = {}, out = [], selected = {};
        var i;
        for (i = 0; i < tls.length; i++) { selected[tls[i].id] = true; }
        function visit(tl) {
            if (seen[tl.id]) { return; }
            seen[tl.id] = true;
            var tracks = M.allTracks(tl);
            for (var t = 0; t < tracks.length; t++) {
                for (var c = 0; c < tracks[t].clips.length; c++) {
                    var n = tracks[t].clips[c].nested;
                    if (n && selected[n.id]) { visit(n); }
                }
            }
            out.push(tl);
        }
        for (i = 0; i < tls.length; i++) { visit(tls[i]); }
        return out;
    };

    // -> [{name, text}] where name is the file base name (no extension)
    R.write = function (fmtId, tls, opts) {
        var fmt = R.byId(fmtId), out = [], i, j;
        if (!fmt || !fmt.canWrite) { throw new Error("Cannot write format " + fmtId); }
        opts = opts || {};
        if (opts.combine && fmt.combinable && tls.length > 1) {
            out.push({ name: opts.combinedName || "EDL AE Export", text: fmt.writeMany(R.dependencyOrder(tls), opts) });
            return out;
        }
        for (i = 0; i < tls.length; i++) {
            var files = fmt.write(tls[i], opts);
            for (j = 0; j < files.length; j++) {
                out.push({ name: tls[i].name + files[j].suffix, text: files[j].text });
            }
        }
        return out;
    };

    return R;
}());
