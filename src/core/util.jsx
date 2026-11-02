// ES3 helpers. ExtendScript has no Array.prototype.indexOf/map/forEach,
// no String.prototype.trim, no JSON and no Object.keys, so everything that
// needs them goes through here.

EDLAE.util = (function () {
    var U = {};

    U.trim = function (s) {
        return String(s === undefined || s === null ? "" : s).replace(/^\s+|\s+$/g, "");
    };

    U.indexOf = function (arr, v) {
        for (var i = 0; i < arr.length; i++) { if (arr[i] === v) { return i; } }
        return -1;
    };

    U.contains = function (arr, v) { return U.indexOf(arr, v) >= 0; };

    U.map = function (arr, fn) {
        var out = [];
        for (var i = 0; i < arr.length; i++) { out.push(fn(arr[i], i)); }
        return out;
    };

    U.filter = function (arr, fn) {
        var out = [];
        for (var i = 0; i < arr.length; i++) { if (fn(arr[i], i)) { out.push(arr[i]); } }
        return out;
    };

    U.keys = function (obj) {
        var out = [];
        for (var k in obj) { if (obj.hasOwnProperty(k)) { out.push(k); } }
        return out;
    };

    U.extend = function (dst, src) {
        if (src) { for (var k in src) { if (src.hasOwnProperty(k)) { dst[k] = src[k]; } } }
        return dst;
    };

    U.isArray = function (v) {
        return Object.prototype.toString.call(v) === "[object Array]";
    };

    // Stable insertion sort; ExtendScript's Array.sort is not guaranteed stable.
    U.stableSort = function (arr, cmp) {
        var a = arr.slice(0);
        for (var i = 1; i < a.length; i++) {
            var v = a[i], j = i - 1;
            while (j >= 0 && cmp(a[j], v) > 0) { a[j + 1] = a[j]; j--; }
            a[j + 1] = v;
        }
        return a;
    };

    U.repeat = function (s, n) {
        var out = "";
        for (var i = 0; i < n; i++) { out += s; }
        return out;
    };

    U.padLeft = function (s, n, ch) {
        s = String(s);
        ch = ch === undefined ? " " : ch;
        while (s.length < n) { s = ch + s; }
        return s;
    };

    U.padRight = function (s, n, ch) {
        s = String(s);
        ch = ch === undefined ? " " : ch;
        while (s.length < n) { s = s + ch; }
        return s;
    };

    U.startsWith = function (s, prefix) { return String(s).substring(0, prefix.length) === prefix; };

    U.endsWith = function (s, suffix) {
        s = String(s);
        return s.length >= suffix.length && s.substring(s.length - suffix.length) === suffix;
    };

    U.lines = function (text) { return String(text).split(/\r\n|\r|\n/); };

    U.stripBOM = function (text) {
        text = String(text);
        return text.charCodeAt(0) === 0xFEFF ? text.substring(1) : text;
    };

    // ---- paths -------------------------------------------------------------

    U.normSlashes = function (p) { return String(p).replace(/\\/g, "/"); };

    U.basename = function (p) {
        p = U.normSlashes(p).replace(/\/+$/, "");
        var i = p.lastIndexOf("/");
        return i >= 0 ? p.substring(i + 1) : p;
    };

    U.dirname = function (p) {
        p = U.normSlashes(p);
        var i = p.lastIndexOf("/");
        return i >= 0 ? p.substring(0, i) : "";
    };

    U.ext = function (p) {
        var b = U.basename(p), i = b.lastIndexOf(".");
        return i > 0 ? b.substring(i + 1).toLowerCase() : "";
    };

    U.stripExt = function (p) {
        var b = U.basename(p), i = b.lastIndexOf(".");
        return i > 0 ? b.substring(0, i) : b;
    };

    U.safeFileName = function (name) {
        var s = String(name).replace(/[\\\/:*?"<>|\x00-\x1f]/g, "_");
        s = U.trim(s);
        return s.length ? s : "untitled";
    };

    // Native or slash path -> file URL. Windows drive paths become
    // file:///C:/..., UNC paths file://server/share/...
    U.pathToUrl = function (path, useLocalhost) {
        if (!path) { return ""; }
        var p = U.normSlashes(path), prefix;
        if (/^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p)) {
            prefix = useLocalhost ? "file://localhost/" : "file:///";
        } else if (U.startsWith(p, "//")) {
            p = p.substring(2);
            prefix = "file://";
        } else {
            if (U.startsWith(p, "/")) { p = p.substring(1); }
            prefix = useLocalhost ? "file://localhost/" : "file:///";
        }
        var parts = p.split("/");
        for (var i = 0; i < parts.length; i++) {
            if (i === 0 && /^[A-Za-z]:$/.test(parts[i])) { continue; }
            parts[i] = encodeURIComponent(parts[i]).replace(/%2C/g, ",").replace(/%40/g, "@")
                .replace(/%2B/g, "+").replace(/%3D/g, "=").replace(/%26/g, "&")
                .replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
        }
        return prefix + parts.join("/");
    };

    U.decodeURIComponentSafe = function (s) {
        try { return decodeURIComponent(s); } catch (e) {
            try { return unescape(s); } catch (e2) { return s; }
        }
    };

    // File URL (or plain path) -> path with forward slashes.
    // Windows drive paths come back as "C:/dir/file.mov".
    U.urlToPath = function (url) {
        if (!url) { return ""; }
        var s = U.trim(url), host = "";
        if (/^file:/i.test(s)) {
            s = s.replace(/^file:/i, "");
            if (U.startsWith(s, "//")) {
                s = s.substring(2);
                var slash = s.indexOf("/");
                host = slash >= 0 ? s.substring(0, slash) : s;
                s = slash >= 0 ? s.substring(slash) : "/";
                if (host.toLowerCase() === "localhost") { host = ""; }
            }
            s = U.decodeURIComponentSafe(s);
        } else if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) {
            return s; // some other scheme, leave it alone
        }
        s = U.normSlashes(s);
        if (host) { return "//" + host + s; }
        if (/^\/[A-Za-z]:(\/|$)/.test(s)) { return s.substring(1); }
        return s;
    };

    // ---- names -------------------------------------------------------------

    U.sanitizeReel = function (name, maxLen) {
        var s = String(name || "").replace(/[^A-Za-z0-9_\-]/g, "_").replace(/_+/g, "_");
        s = s.replace(/^_+|_+$/g, "");
        if (!s.length) { s = "AX"; }
        if (maxLen && s.length > maxLen) { s = s.substring(0, maxLen); }
        return s;
    };

    U.uniqueName = function (base, taken) {
        if (!taken[base]) { taken[base] = true; return base; }
        for (var i = 2; ; i++) {
            var n = base + " " + i;
            if (!taken[n]) { taken[n] = true; return n; }
        }
    };

    U.fmtNum = function (n, decimals) {
        var f = Math.pow(10, decimals);
        return String(Math.round(n * f) / f);
    };

    U.gcd = function (a, b) {
        a = Math.abs(a); b = Math.abs(b);
        while (b) { var t = b; b = a % b; a = t; }
        return a || 1;
    };

    U.toInt = function (v, dflt) {
        var n = parseInt(v, 10);
        return isNaN(n) ? dflt : n;
    };

    U.toFloat = function (v, dflt) {
        var n = parseFloat(v);
        return isNaN(n) ? dflt : n;
    };

    U.bool = function (v) {
        var s = U.trim(v).toUpperCase();
        return s === "TRUE" || s === "1" || s === "YES";
    };

    U.round = function (n) { return Math.round(n); };

    // Image sequence frame file: "shot_010.1001.exr" -> {prefix:"shot_010.", frame:1001, pad:4, suffix:".exr"}
    U.parseFrameFile = function (fileName) {
        var m = /^(.*?)(\d+)(\.[A-Za-z0-9]+)$/.exec(String(fileName));
        if (!m) { return null; }
        return { prefix: m[1], frame: parseInt(m[2], 10), pad: m[2].length, suffix: m[3] };
    };

    var IMAGE_EXT = ["exr", "dpx", "tif", "tiff", "png", "jpg", "jpeg", "tga", "bmp", "cin", "sgi",
        "rgb", "hdr", "psd", "iff", "pic", "webp", "avif", "heic", "jp2", "j2k", "ari", "arx", "dng"];

    U.isImageExt = function (ext) { return U.contains(IMAGE_EXT, String(ext).toLowerCase()); };

    var AUDIO_EXT = ["wav", "wave", "aif", "aiff", "aifc", "mp3", "m4a", "aac", "flac", "ogg", "bwf", "caf", "wma"];

    U.isAudioExt = function (ext) { return U.contains(AUDIO_EXT, String(ext).toLowerCase()); };

    return U;
}());
