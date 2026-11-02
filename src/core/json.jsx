// JSON for ExtendScript (no native JSON object). The parser is a plain
// recursive-descent reader; it never evals file contents.

EDLAE.json = (function () {
    var U = EDLAE.util;
    var J = {};

    // Wrap a number that must be written as a float ("24.0"); OTIO's
    // RationalTime fields are doubles.
    J.F = function (n) { return { __jsonFloat: Number(n) }; };

    function quote(s) {
        return "\"" + String(s).replace(/[\\"\x00-\x1f\u2028\u2029]/g, function (c) {
            switch (c) {
            case "\\": return "\\\\";
            case "\"": return "\\\"";
            case "\n": return "\\n";
            case "\r": return "\\r";
            case "\t": return "\\t";
            case "\b": return "\\b";
            case "\f": return "\\f";
            default: return "\\u" + U.padLeft(c.charCodeAt(0).toString(16), 4, "0");
            }
        }) + "\"";
    }

    function num(n, asFloat) {
        if (!isFinite(n)) { return "null"; }
        var s = String(n);
        if (asFloat && /^-?\d+$/.test(s)) { s += ".0"; }
        return s;
    }

    J.stringify = function (value, indent) {
        indent = indent === undefined ? "    " : indent;
        function write(v, depth) {
            if (v === null || v === undefined) { return "null"; }
            var t = typeof v;
            if (t === "boolean") { return v ? "true" : "false"; }
            if (t === "number") { return num(v, false); }
            if (t === "string") { return quote(v); }
            if (v.hasOwnProperty && v.hasOwnProperty("__jsonFloat")) { return num(v.__jsonFloat, true); }
            var pad = U.repeat(indent, depth + 1), padEnd = U.repeat(indent, depth), nl = indent ? "\n" : "", parts = [], i;
            if (U.isArray(v)) {
                if (!v.length) { return "[]"; }
                for (i = 0; i < v.length; i++) { parts.push(pad + write(v[i], depth + 1)); }
                return "[" + nl + parts.join("," + nl) + nl + padEnd + "]";
            }
            var keys = U.keys(v);
            if (!keys.length) { return "{}"; }
            for (i = 0; i < keys.length; i++) {
                if (v[keys[i]] === undefined || typeof v[keys[i]] === "function") { continue; }
                parts.push(pad + quote(keys[i]) + ":" + (indent ? " " : "") + write(v[keys[i]], depth + 1));
            }
            return "{" + nl + parts.join("," + nl) + nl + padEnd + "}";
        }
        return write(value, 0);
    };

    J.parse = function (text) {
        text = U.stripBOM(text);
        var i = 0, len = text.length;

        function fail(msg) { throw new Error("JSON parse error at offset " + i + ": " + msg); }
        function ws() {
            while (i < len) {
                var c = text.charCodeAt(i);
                if (c === 32 || c === 9 || c === 10 || c === 13) { i++; } else { break; }
            }
        }
        function str() {
            i++; // opening quote
            var out = "", start = i;
            while (i < len) {
                var c = text.charAt(i);
                if (c === "\"") { out += text.substring(start, i); i++; return out; }
                if (c === "\\") {
                    out += text.substring(start, i);
                    var e = text.charAt(i + 1);
                    if (e === "u") {
                        out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16));
                        i += 6;
                    } else {
                        out += ({ "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[e] || e;
                        i += 2;
                    }
                    start = i;
                } else { i++; }
            }
            fail("unterminated string");
        }
        function value() {
            ws();
            var c = text.charAt(i);
            if (c === "{") {
                i++;
                var obj = {};
                ws();
                if (text.charAt(i) === "}") { i++; return obj; }
                for (;;) {
                    ws();
                    if (text.charAt(i) !== "\"") { fail("expected key"); }
                    var k = str();
                    ws();
                    if (text.charAt(i) !== ":") { fail("expected ':'"); }
                    i++;
                    obj[k] = value();
                    ws();
                    var d = text.charAt(i);
                    i++;
                    if (d === "}") { return obj; }
                    if (d !== ",") { fail("expected ',' or '}'"); }
                }
            }
            if (c === "[") {
                i++;
                var arr = [];
                ws();
                if (text.charAt(i) === "]") { i++; return arr; }
                for (;;) {
                    arr.push(value());
                    ws();
                    var d2 = text.charAt(i);
                    i++;
                    if (d2 === "]") { return arr; }
                    if (d2 !== ",") { fail("expected ',' or ']'"); }
                }
            }
            if (c === "\"") { return str(); }
            if (text.substr(i, 4) === "true") { i += 4; return true; }
            if (text.substr(i, 5) === "false") { i += 5; return false; }
            if (text.substr(i, 4) === "null") { i += 4; return null; }
            if (text.substr(i, 3) === "NaN") { i += 3; return NaN; }
            if (text.substr(i, 8) === "Infinity") { i += 8; return Infinity; }
            if (text.substr(i, 9) === "-Infinity") { i += 9; return -Infinity; }
            var m = /^-?\d+(\.\d+)?([eE][+\-]?\d+)?/.exec(text.substr(i, 64));
            if (!m) { fail("unexpected character '" + c + "'"); }
            i += m[0].length;
            return parseFloat(m[0]);
        }
        var v = value();
        ws();
        if (i < len) { fail("trailing data"); }
        return v;
    };

    return J;
}());
