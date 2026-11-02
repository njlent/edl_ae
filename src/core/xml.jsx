// Small XML reader/writer. ExtendScript has E4X, but a hand-rolled parser
// runs the same in After Effects and in the Node test harness.
//
// Elements are {tag, attrs:{}, kids:[elements], text:"concatenated text"}.
// Mixed-content ordering is not kept; none of the timeline formats need it.

EDLAE.xml = (function () {
    var U = EDLAE.util;
    var X = {};

    var ENT = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

    X.decode = function (s) {
        if (s.indexOf("&") < 0) { return s; }
        return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, function (all, e) {
            if (e.charAt(0) === "#") {
                var code = e.charAt(1) === "x" || e.charAt(1) === "X" ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
                if (isNaN(code)) { return all; }
                if (code > 0xFFFF) {
                    code -= 0x10000;
                    return String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
                }
                return String.fromCharCode(code);
            }
            return ENT.hasOwnProperty(e) ? ENT[e] : all;
        });
    };

    X.escape = function (s) {
        return String(s === undefined || s === null ? "" : s)
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    };

    function lineAt(text, pos) {
        var n = 1;
        for (var i = text.indexOf("\n"); i >= 0 && i < pos; i = text.indexOf("\n", i + 1)) { n++; }
        return n;
    }

    function parseAttrs(s) {
        var attrs = {};
        if (!s) { return attrs; }
        var re = /([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
        while ((m = re.exec(s)) !== null) {
            attrs[m[1]] = X.decode(m[3] !== undefined && m[3] !== "" ? m[3] : (m[4] || ""));
        }
        return attrs;
    }

    X.parse = function (text) {
        text = U.stripBOM(text);
        var len = text.length, pos = 0;
        var root = { tag: "#document", attrs: {}, kids: [], text: "" };
        var cur = root, stack = [];
        var tagRe = /<(\/?)([A-Za-z_][\-\w:.]*)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

        while (pos < len) {
            var lt = text.indexOf("<", pos);
            if (lt < 0) { cur.text += X.decode(text.substring(pos)); break; }
            if (lt > pos) { cur.text += X.decode(text.substring(pos, lt)); }
            var end;
            if (text.substr(lt, 4) === "<!--") {
                end = text.indexOf("-->", lt + 4);
                pos = end < 0 ? len : end + 3;
                continue;
            }
            if (text.substr(lt, 9) === "<![CDATA[") {
                end = text.indexOf("]]>", lt + 9);
                if (end < 0) { end = len; }
                cur.text += text.substring(lt + 9, end);
                pos = end + 3;
                continue;
            }
            if (text.substr(lt, 2) === "<?") {
                end = text.indexOf("?>", lt + 2);
                pos = end < 0 ? len : end + 2;
                continue;
            }
            if (text.substr(lt, 2) === "<!") {
                var gt = text.indexOf(">", lt), br = text.indexOf("[", lt);
                if (br >= 0 && gt >= 0 && br < gt) {
                    var close = text.indexOf("]", br);
                    gt = close < 0 ? -1 : text.indexOf(">", close);
                }
                pos = gt < 0 ? len : gt + 1;
                continue;
            }
            tagRe.lastIndex = lt;
            var m = tagRe.exec(text);
            if (!m || m.index !== lt) {
                throw new Error("XML parse error near line " + lineAt(text, lt));
            }
            pos = tagRe.lastIndex;
            if (m[1] === "/") {
                // close: pop to the matching open tag (lenient with stray closes)
                var found = -1;
                if (cur.tag === m[2]) { found = stack.length; }
                else {
                    for (var s = stack.length - 1; s >= 1; s--) { if (stack[s].tag === m[2]) { found = s; break; } }
                }
                if (found === stack.length) { cur = stack.pop(); }
                else if (found > 0) { cur = stack[found - 1]; stack.length = found - 1; }
            } else {
                var el = { tag: m[2], attrs: parseAttrs(m[3]), kids: [], text: "" };
                cur.kids.push(el);
                if (m[4] !== "/") { stack.push(cur); cur = el; }
            }
        }
        for (var i = 0; i < root.kids.length; i++) { return root.kids[i]; }
        throw new Error("XML parse error: no root element");
    };

    // ---- queries -----------------------------------------------------------

    X.child = function (el, tag) {
        if (!el) { return null; }
        for (var i = 0; i < el.kids.length; i++) { if (el.kids[i].tag === tag) { return el.kids[i]; } }
        return null;
    };

    X.children = function (el, tag) {
        var out = [];
        if (!el) { return out; }
        for (var i = 0; i < el.kids.length; i++) { if (!tag || el.kids[i].tag === tag) { out.push(el.kids[i]); } }
        return out;
    };

    // "a/b/c" -> first match at each step
    X.path = function (el, path) {
        var parts = path.split("/");
        for (var i = 0; i < parts.length && el; i++) { el = X.child(el, parts[i]); }
        return el;
    };

    X.text = function (el, path) {
        var e = path ? X.path(el, path) : el;
        return e ? U.trim(e.text) : "";
    };

    X.num = function (el, path, dflt) {
        var t = X.text(el, path);
        if (t === "") { return dflt; }
        var n = parseFloat(t);
        return isNaN(n) ? dflt : n;
    };

    X.attr = function (el, name, dflt) {
        return el && el.attrs.hasOwnProperty(name) ? el.attrs[name] : dflt;
    };

    // All descendants with tag, depth-first. stopAt: tags whose subtrees are not entered.
    X.findAll = function (el, tag, stopAt) {
        var out = [];
        function walk(e) {
            for (var i = 0; i < e.kids.length; i++) {
                var k = e.kids[i];
                if (k.tag === tag) { out.push(k); }
                if (!stopAt || !U.contains(stopAt, k.tag)) { walk(k); }
            }
        }
        if (el) { walk(el); }
        return out;
    };

    // ---- writer ------------------------------------------------------------

    function Writer(indent) {
        this.out = [];
        this.depth = 0;
        this.indent = indent === undefined ? "\t" : indent;
        this.stack = [];
    }

    function attrString(attrs) {
        if (!attrs) { return ""; }
        var s = "";
        for (var i = 0; i + 1 < attrs.length; i += 2) {
            if (attrs[i + 1] === undefined || attrs[i + 1] === null) { continue; }
            s += " " + attrs[i] + "=\"" + X.escape(attrs[i + 1]) + "\"";
        }
        return s;
    }

    Writer.prototype.pad = function () { return U.repeat(this.indent, this.depth); };
    Writer.prototype.raw = function (line) { this.out.push(line); return this; };
    Writer.prototype.open = function (tag, attrs) {
        this.out.push(this.pad() + "<" + tag + attrString(attrs) + ">");
        this.stack.push(tag);
        this.depth++;
        return this;
    };
    Writer.prototype.close = function () {
        this.depth--;
        this.out.push(this.pad() + "</" + this.stack.pop() + ">");
        return this;
    };
    Writer.prototype.leaf = function (tag, text, attrs) {
        this.out.push(this.pad() + "<" + tag + attrString(attrs) + ">" + X.escape(text) + "</" + tag + ">");
        return this;
    };
    Writer.prototype.empty = function (tag, attrs) {
        this.out.push(this.pad() + "<" + tag + attrString(attrs) + "/>");
        return this;
    };
    Writer.prototype.toString = function () { return this.out.join("\n") + "\n"; };

    X.Writer = Writer;
    return X;
}());
