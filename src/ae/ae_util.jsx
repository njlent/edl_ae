// After Effects helpers: file IO, settings, project lookup, XMP timecode.

EDLAE.ae = EDLAE.ae || {};
EDLAE.ae.util = (function () {
    var U = EDLAE.util, TC = EDLAE.tc;
    var A = {};
    var SECTION = "EDL_AE";

    A.isWin = $.os.indexOf("Windows") >= 0;

    A.readText = function (path) {
        var f = new File(path);
        if (!f.exists) { throw new Error("File not found: " + path); }
        f.encoding = "UTF-8";
        if (!f.open("r")) { throw new Error("Cannot open " + f.fsName + (f.error ? " (" + f.error + ")" : "")); }
        var s = f.read();
        f.close();
        return U.stripBOM(s);
    };

    A.writeText = function (path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        f.lineFeed = "Unix"; // text already carries its own line endings
        if (!f.open("w")) {
            throw new Error("Cannot write " + f.fsName + (f.error ? " (" + f.error + ")" : "") +
                ". Check Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network.");
        }
        var ok = f.write(text);
        f.close();
        if (!ok) { throw new Error("Write failed: " + f.fsName); }
        return f;
    };

    // Model paths use forward slashes; File() accepts them on Windows too.
    A.modelPath = function (file) { return U.normSlashes(file.fsName); };

    A.getSetting = function (key, dflt) {
        try {
            if (app.settings.haveSetting(SECTION, key)) { return app.settings.getSetting(SECTION, key); }
        } catch (e) {}
        return dflt;
    };

    A.getBool = function (key, dflt) {
        var v = A.getSetting(key, dflt ? "1" : "0");
        return v === "1" || v === "true";
    };

    A.setSetting = function (key, val) {
        try { app.settings.saveSetting(SECTION, key, typeof val === "boolean" ? (val ? "1" : "0") : String(val)); } catch (e) {}
    };

    A.comps = function () {
        var out = [], items = app.project.items;
        for (var i = 1; i <= items.length; i++) { if (items[i] instanceof CompItem) { out.push(items[i]); } }
        return U.stableSort(out, function (a, b) {
            var x = a.name.toLowerCase(), y = b.name.toLowerCase();
            return x < y ? -1 : (x > y ? 1 : a.id - b.id);
        });
    };

    A.itemById = function (id) {
        var items = app.project.items;
        for (var i = 1; i <= items.length; i++) { if (items[i].id === id) { return items[i]; } }
        return null;
    };

    A.compRate = function (comp) {
        var drop = false;
        try { drop = comp.dropFrame; } catch (e) {}
        return TC.fromFps(comp.frameRate, drop);
    };

    A.compLabel = function (comp) {
        var r = A.compRate(comp);
        return {
            size: comp.width + "x" + comp.height,
            fps: TC.label(r),
            duration: TC.toTC(Math.round(comp.duration * r.fps), TC.make(r.base, false, false))
        };
    };

    // ---- XMP ----------------------------------------------------------------

    var xmpState = null;
    function xmpReady() {
        if (xmpState !== null) { return xmpState; }
        try {
            if (typeof XMPMeta === "undefined") { new ExternalObject("lib:AdobeXMPScript"); }
            xmpState = typeof XMPFile !== "undefined";
        } catch (e) { xmpState = false; }
        return xmpState;
    }

    var XMP_RATES = { "23976": 23.976, "24": 24, "25": 25, "2997": 29.97, "30": 30, "47952": 47.952, "48": 48,
        "50": 50, "5994": 59.94, "60": 60, "100": 100, "11988": 119.88, "120": 120 };

    function xmpVal(v) { return v === undefined || v === null ? "" : String(v.value !== undefined ? v.value : v); }

    var xmpCache = {};
    // -> {frames, rate, reel} or null
    A.readMediaTimecode = function (fsName) {
        var key = String(fsName).toLowerCase();
        if (xmpCache.hasOwnProperty(key)) { return xmpCache[key]; }
        var out = null;
        if (xmpReady()) {
            try {
                var xf = new XMPFile(fsName, XMPConst.FILE_UNKNOWN, XMPConst.OPEN_FOR_READ);
                var xmp = xf.getXMP();
                xf.closeFile(0);
                if (xmp) {
                    // startTimecode is what Premiere/AE write; the QuickTime handler reports the
                    // file's timecode track (tmcd) as altTimecode.
                    var ns = XMPConst.NS_DM, tv = "", tf = "", fields = ["startTimecode", "altTimecode"];
                    for (var fi = 0; fi < fields.length && !TC.isTC(tv); fi++) {
                        tv = xmpVal(xmp.getStructField(ns, fields[fi], ns, "timeValue"));
                        tf = xmpVal(xmp.getStructField(ns, fields[fi], ns, "timeFormat"));
                    }
                    var reel = xmpVal(xmp.getProperty(ns, "tapeName")) || xmpVal(xmp.getProperty(ns, "altTapeName"));
                    if (tv && TC.isTC(tv)) {
                        var m = /^(\d+)(Drop|NonDrop)?Timecode$/.exec(tf);
                        var fps = m && XMP_RATES[m[1]] ? XMP_RATES[m[1]] : 0;
                        var rate = fps ? TC.fromFps(fps, m[2] === "Drop") : null;
                        out = { tc: tv, rate: rate, reel: reel };
                    } else if (reel) {
                        out = { tc: "", rate: null, reel: reel };
                    }
                }
            } catch (e) { out = null; }
        }
        xmpCache[key] = out;
        return out;
    };

    // Start frame of a footage file in `rate` frames, or null if unknown.
    A.mediaStartFrames = function (fsName, rate, useXmp, useSeqFrames) {
        var name = U.basename(fsName), info;
        if (useSeqFrames && U.isImageExt(U.ext(name))) {
            var seq = U.parseFrameFile(name);
            if (seq) { return { frames: seq.frame, reel: "" }; }
        }
        if (useXmp) {
            info = A.readMediaTimecode(fsName);
            if (info && info.tc) {
                var tcRate = info.rate || rate;
                var f = TC.fromTC(info.tc, TC.make(tcRate.base, tcRate.ntsc, tcRate.drop));
                if (!isNaN(f)) {
                    if (tcRate.base !== rate.base) { f = Math.round(f / tcRate.fps * rate.fps); }
                    return { frames: f, reel: info.reel, drop: tcRate.drop };
                }
            }
            if (info && info.reel) { return { frames: null, reel: info.reel }; }
        }
        return null;
    };

    return A;
}());
