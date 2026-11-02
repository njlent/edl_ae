// Node test runner for the format core.
//
//   npm test
//
// 1. Every source file and the bundle must parse as ES3 (ExtendScript).
// 2. The core runs in a VM context with the ES5+ built-ins ExtendScript lacks
//    deleted, so an accidental arr.forEach / JSON / trim fails here, not in AE.
// 3. Unit tests, fixture tests and write -> read round trips for each format.

import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import { ROOT, CORE, AE, bundle } from "../scripts/build.mjs";
import { E, TC, M, R, U, arr, rate, summarize, read, sample } from "./harness.mjs";
import { lint } from "./lint.mjs";

let failures = 0, passes = 0;
const only = process.argv[2] || "";

function ok(cond, msg) {
    if (cond) { passes++; return; }
    failures++;
    console.log("  FAIL " + msg);
}
function eq(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    ok(sa === sb, `${msg}\n       got:      ${sa}\n       expected: ${sb}`);
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (±${tol})`); }
function test(name, fn) {
    if (only && !name.includes(only)) { return; }
    const before = failures;
    try { fn(); } catch (e) { failures++; console.log(`  FAIL ${name}: threw ${e && e.stack || e}`); }
    console.log(`${failures === before ? "ok  " : "FAIL"} ${name}`);
}

// ---- 1. ES3 syntax --------------------------------------------------------

test("sources parse as ES3", () => {
    for (const rel of [...CORE, ...AE]) {
        const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
        try { acorn.parse(src, { ecmaVersion: 3, allowReserved: "never", sourceType: "script" }); }
        catch (e) { ok(false, `${rel}: ${e.message}`); }
    }
    const b = bundle();
    try { acorn.parse(b, { ecmaVersion: 3, allowReserved: "never", sourceType: "script" }); ok(true); }
    catch (e) { ok(false, `bundle: ${e.message}`); }
    ok(/^[\x00-\x7f]*$/.test(b), "bundle is ASCII");
});

test("scope lint (no implicit globals, no shared loop counters)", () => {
    for (const rel of [...CORE, ...AE]) {
        for (const p of lint(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel)) { ok(false, p); }
    }
});

// ---- 2. format tests (sandbox in harness.mjs) ------------------------------

test("timecode NDF/DF", () => {
    eq(TC.toTC(86400, rate(24)), "01:00:00:00", "24 1h");
    eq(TC.toTC(86400, rate(23.976)), "01:00:00:00", "23.976 1h");
    eq(TC.toTC(1800, rate(29.97, true)), "00:01:00;02", "29.97 DF 1 min");
    eq(TC.toTC(17982, rate(29.97, true)), "00:10:00;00", "29.97 DF 10 min");
    eq(TC.toTC(107892, rate(29.97, true)), "01:00:00;00", "29.97 DF 1h");
    eq(TC.toTC(215784, rate(59.94, true)), "01:00:00;00", "59.94 DF 1h");
    eq(TC.fromTC("00:01:00;02", rate(29.97, true)), 1800, "DF parse");
    eq(TC.fromTC("01:00:00;00", rate(29.97)), 107892, "';' implies DF");
    for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
        for (const drop of [false, true]) {
            const r = rate(fps, drop);
            for (let f = 0; f < 200000; f += 997) { if (TC.fromTC(TC.toTC(f, r), r) !== f) { ok(false, `roundtrip ${fps} ${drop} ${f}`); break; } }
        }
    }
    eq(TC.label(rate(23.976)), "23.976", "label");
    eq(TC.frameDuration(rate(23.976)), { num: 1001, den: 24000 }, "frameDuration");
    eq(TC.hourFloor(86400 + 500, rate(24)), 86400, "hourFloor");
});

test("paths and urls", () => {
    eq(U.pathToUrl("C:\\Media\\a b#1.mov"), "file:///C:/Media/a%20b%231.mov", "win url");
    eq(U.pathToUrl("C:/Media/x.mov", true), "file://localhost/C:/Media/x.mov", "localhost url");
    eq(U.pathToUrl("/Volumes/RAID/x y.mov"), "file:///Volumes/RAID/x%20y.mov", "mac url");
    eq(U.pathToUrl("\\\\server\\share\\x.mov"), "file://server/share/x.mov", "unc url");
    eq(U.urlToPath("file://localhost/C%3a/Media/a%20b.mov"), "C:/Media/a b.mov", "premiere url");
    eq(U.urlToPath("file:///C:/Media/a%20b.mov"), "C:/Media/a b.mov", "triple slash");
    eq(U.urlToPath("file:///Volumes/RAID/x.mov"), "/Volumes/RAID/x.mov", "mac");
    eq(U.urlToPath("file://server/share/x.mov"), "//server/share/x.mov", "unc");
    eq(U.urlToPath("file://localhost/Volumes/A/b.mov"), "/Volumes/A/b.mov", "localhost mac");
    eq(JSON.stringify(U.parseFrameFile("shot_010.1001.exr")), JSON.stringify({ prefix: "shot_010.", frame: 1001, pad: 4, suffix: ".exr" }), "frame file");
});

test("xml + json basics", () => {
    const X = E.xml, J = E.json;
    const doc = X.parse(`<?xml version="1.0"?><!DOCTYPE x [ <!ENTITY a "b"> ]><!-- c --><r a="1 &amp; 2" b='x>y'><k>t&lt;1&#65;</k><e/><![CDATA[<raw>]]></r>`);
    eq(doc.tag, "r", "root");
    eq(doc.attrs.a, "1 & 2", "attr entity");
    eq(doc.attrs.b, "x>y", "attr with >");
    eq(X.text(doc, "k"), "t<1A", "text entities");
    ok(doc.text.indexOf("<raw>") >= 0, "cdata");
    const o = J.parse(`{"a": [1, 2.5, -3e2, true, null], "s": "x\\u00e9\\n", "f": 24.0}`);
    eq(o.a[2], -300, "json number");
    eq(o.s, "x\u00e9\n", "json string");
    const s = J.stringify({ r: J.F(24), v: J.F(86400.5), n: 3, s: "q\"" });
    ok(/"r": 24\.0/.test(s) && /"v": 86400\.5/.test(s) && /"n": 3/.test(s), "json float marker: " + s);
});

test("EDL fixture: cuts, dissolve, M2, audio, markers", () => {
    const res = read("sample.edl", { rate: rate(24) });
    const tl = res.timelines[0];
    eq(tl.name, "SAMPLE CUT", "title");
    eq(tl.start, 86400, "start at 1h");
    const v = arr(tl.video[0].clips);
    eq(v.length, 5, "video clips");
    eq([v[0].name, v[0].recIn, v[0].recOut, v[0].srcIn], ["A001C003_220101.mov", 0, 120, 86400 + 240], "event 1");
    eq(v[0].media.path, "D:/footage/A001C003_220101.mov", "source file comment");
    // event 2 dissolves into event 3 over 24 frames: A extends, B starts at the cut
    eq([v[1].recIn, v[1].recOut, v[1].transitionIn], [120, 264, 0], "outgoing extended through dissolve");
    eq([v[2].name, v[2].recIn, v[2].recOut, v[2].transitionIn], ["B002C010.mov", 240, 360, 24], "incoming");
    eq([v[3].speed, v[3].recIn, v[3].recOut, Math.round(v[3].srcOut - v[3].srcIn)], [0.5, 360, 408, 24], "M2 50%");
    eq([v[4].name, v[4].transitionOut, v[4].recOut], ["C001.mov", 12, 468], "fade to black");
    eq(arr(tl.audio).length, 2, "two audio tracks");
    eq(arr(tl.audio[0].clips).length, 2, "A1 clips");
    eq(arr(tl.audio[1].clips).length, 1, "A2 clips");
    eq(arr(tl.markers).map((m) => [m.frame, m.name, m.color]), [[24, "check flicker", "RED"], [300, "VFX 010", "GREEN"]], "LOC markers");
});

test("EDL drop frame header", () => {
    const tl = R.read("x.edl", "TITLE: DF\r\nFCM: DROP FRAME\r\n\r\n001  AX  V  C  00:00:00;00 00:00:01;00 01:00:00;00 01:00:01;00\r\n", { rate: rate(29.97) }).timelines[0];
    ok(tl.rate.drop, "drop flag from FCM");
    eq(tl.start, 107892, "DF hour");
    eq(arr(tl.video[0].clips)[0].recOut, 30, "DF length");
});

test("FCP7 XML fixture", () => {
    const res = read("premiere.xml");
    eq(res.format.id, "xmeml", "detected");
    eq(arr(res.timelines).map((t) => t.name), ["Edit v01", "Nest A"], "both top-level sequences listed");
    const tl = res.timelines[0];
    eq([tl.rate.base, tl.rate.ntsc, tl.start, tl.width, tl.height], [24, true, 86400, 3840, 2160], "sequence settings");
    const v = arr(tl.video[0].clips);
    eq([v[0].name, v[0].recIn, v[0].recOut, v[0].srcIn], ["A001_C002.mov", 0, 124, 86450], "clip 1 runs through the dissolve");
    eq(arr(v[0].markers).map((m) => [m.frame, m.name]), [[10, "clip note"]], "clip marker");
    eq([v[1].recIn, v[1].recOut, v[1].transitionIn], [100, 200, 24], "clip 2 dissolve-in");
    eq(v[0].media.path, "C:/Media/A001 C002.mov", "file path");
    ok(v[1].media === v[0].media, "file id reference resolves to same media");
    eq([v[2].speed, v[2].recIn, v[2].recOut, Math.round(v[2].srcOut - v[2].srcIn)], [2, 200, 248, 96], "time remap 200%");
    const v2 = arr(tl.video[1].clips);
    eq([v2[0].kind, v2[0].name, v2[0].recOut], ["generator", "Black Video", 12], "generator item");
    ok(v2[1].nested && v2[1].nested.name === "Nest A", "nested sequence");
    ok(v2[1].nested === res.timelines[1], "nested instance shared with the top-level list");
    eq([v2[1].recIn, v2[1].recOut, v2[1].srcIn], [24, 72, 10], "nested clip timing");
    eq(arr(tl.audio).length, 2, "audio tracks");
    eq(arr(tl.audio[1].clips)[0].channel, 2, "source channel");
    eq(arr(tl.markers).map((m) => [m.frame, m.name]), [[48, "Note"]], "markers");
});

test("FCPXML fixture", () => {
    const res = read("resolve.fcpxml");
    eq(res.format.id, "fcpxml", "detected");
    const tl = res.timelines[0];
    eq([tl.name, tl.rate.base, tl.rate.ntsc, tl.start, tl.duration], ["Timeline 1", 24, true, 86400, 240], "sequence");
    const v1 = arr(tl.video[0].clips);
    eq(v1.map((c) => [c.name, c.recIn, c.recOut, c.srcIn]), [
        ["A001", 0, 108, 86400 + 24],
        ["B001", 84, 192, 0],
    ], "spine with cross dissolve");
    eq(v1[1].transitionIn, 24, "dissolve length");
    eq(v1[0].media.path, "C:/Footage/A001.mov", "media-rep src");
    const v2 = arr(tl.video[1].clips);
    eq(v2.map((c) => [c.name, c.recIn, c.recOut, c.srcIn, Math.round(c.speed * 100)]), [
        ["C001", 48, 96, 120, 100],
        ["D001 50%", 196, 220, 10, 50],
    ], "connected clips (lane 1), timeMap speed");
    const v3 = arr(tl.video[2].clips);
    ok(v3[0].nested && v3[0].nested.name === "Compound 1", "ref-clip compound");
    eq([v3[0].recIn, v3[0].recOut, v3[0].srcIn], [0, 24, 86400 + 12], "compound timing");
    const a1 = arr(tl.audio[0].clips);
    eq(a1.map((c) => [c.name, c.recIn, c.recOut]), [["Music", 0, 240]], "audio lane -1");
    eq(arr(tl.markers).map((m) => [m.frame, m.name]), [[12, "clip marker"], [200, "end gap marker"]], "primary storyline markers are timeline markers");
    eq(arr(v2[1].markers).length, 0, "no stray clip markers");
});

test("OTIO fixture", () => {
    const res = read("sample.otio");
    eq(res.format.id, "otio", "detected");
    const tl = res.timelines[0];
    eq([tl.name, tl.start, tl.rate.base], ["OTIO Sample", 86400, 24], "timeline");
    const v = arr(tl.video[0].clips);
    eq(v.map((c) => [c.name, c.recIn, c.recOut, c.srcIn]), [["shot1", 0, 60, 86400 + 10], ["shot2", 36, 120, 1001]], "clips with gap and transition");
    eq(v[1].transitionIn, 24, "transition");
    eq(v[1].media.path, "/Volumes/plates/shot2/shot2.1001.exr", "image sequence url");
    eq(v[0].media.path, "C:/media/shot 1.mov", "external url");
    eq(arr(tl.video[1].clips)[0].speed, 2, "LinearTimeWarp");
    eq(arr(tl.markers).map((m) => [m.frame, m.name]), [[30, "otio marker"]], "stack markers (global start removed)");
});

function roundTrip(fmtId, check) {
    const tl = sample();
    const files = arr(R.write(fmtId, [tl], { markers: true }));
    ok(files.length >= 1, fmtId + " wrote files");
    const back = arr(files).map((f) => arr(R.read("x." + R.byId(fmtId).ext, f.text, { rate: rate(24) }).timelines));
    check(tl, back, files);
}

test("round trip: FCP7 XML", () => roundTrip("xmeml", (tl, back) => {
    const t2 = back[0][0];
    eq(summarize(t2), summarize(tl), "tracks/clips");
    eq([t2.start, t2.width, t2.rate.base], [86400, 1920, 24], "settings");
    eq(arr(t2.markers).map((m) => [m.frame, m.name, m.duration]), [[12, "Marker one", 0], [100, "Second", 5]], "markers");
    const nest = arr(t2.video[1].clips)[1].nested;
    eq(summarize(nest), summarize(arr(tl.video[1].clips)[1].nested), "nested");
}));

test("round trip: OTIO", () => roundTrip("otio", (tl, back) => {
    const t2 = back[0][0];
    eq(summarize(t2), summarize(tl), "tracks/clips");
    eq(t2.start, 86400, "start");
    eq(arr(t2.markers).map((m) => [m.frame, m.name]), [[12, "Marker one"], [100, "Second"]], "markers");
    eq(arr(t2.video[1].clips)[0].media.path, "D:/plates/c.1001.exr", "image sequence reference");
}));

test("round trip: FCPXML", () => roundTrip("fcpxml", (tl, back) => {
    const t2 = back[0][0];
    const want = summarize(tl, { kinds: ["video"] });
    eq(summarize(t2, { kinds: ["video"] }), want, "video");
    // linked A/V audio is carried by the video clip; only audio-only media becomes an audio lane
    eq(summarize(t2, { kinds: ["audio"] }), { A2: summarize(tl, { kinds: ["audio"] }).A2 }, "audio-only lane keeps its track");
    eq(arr(t2.markers).map((m) => [m.frame, m.name]), [[12, "Marker one"], [100, "Second"]], "markers");
}));

test("round trip: EDL", () => roundTrip("edl", (tl, back, files) => {
    eq(arr(files).map((f) => f.name), ["Round Trip_V1", "Round Trip_V2"], "one EDL per video track");
    const t1 = back[0][0], t2 = back[1][0];
    const v1 = arr(t1.video[0].clips), want = arr(tl.video[0].clips);
    eq(v1.map((c) => [c.name, c.recIn, c.recOut, Math.round(c.srcIn), c.speed]), want.map((c) => [c.name, c.recIn, c.recOut, c.srcIn, c.speed]), "V1");
    eq(v1[0].media.path, "C:/media/a.mov", "SOURCE FILE comment");
    eq(arr(t1.audio).map((t) => arr(t.clips).length), [1, 1], "audio events");
    const v2 = arr(t2.video[0].clips);
    eq(v2.map((c) => [c.recIn, c.recOut, Math.round(c.srcIn)]), [[30, 70, 1010], [80, 100, 5]], "V2 incl. nested as clip");
    eq(arr(t1.markers).map((m) => [m.frame, m.name]), [[12, "Marker one"], [100, "Second"]], "LOC markers");
    ok(/M2   b_clip  +048\.0 +00:00:04:04/.test(files[0].text), "M2 line:\n" + files[0].text);
}));

test("EDL writer column layout", () => {
    const files = arr(R.write("edl", [sample()], { reel8: true }));
    const line = files[0].text.split("\r\n").find((l) => /^001 /.test(l));
    eq(line, "001  a        V     C        01:00:00:10 01:00:02:10 01:00:00:00 01:00:02:00", "CMX columns");
});

test("combined export: xmeml project + otio collection + fcpxml multiple projects", () => {
    const tl = sample(), nest = arr(tl.video[1].clips)[1].nested;
    const xml = arr(R.write("xmeml", [tl, nest], { combine: true }))[0].text;
    const back = arr(R.read("x.xml", xml, {}).timelines);
    eq(back.map((t) => t.name), ["Nest", "Round Trip"], "nested sequence defined first");
    eq(summarize(back[1]), summarize(tl), "main sequence intact");
    const otio = arr(R.write("otio", [tl, nest], { combine: true }))[0].text;
    eq(arr(R.read("x.otio", otio, {}).timelines).length, 2, "otio collection");
    const fx = arr(R.write("fcpxml", [tl, nest], { combine: true }))[0].text;
    eq(arr(R.read("x.fcpxml", fx, {}).timelines).map((t) => t.name), ["Nest", "Round Trip"], "fcpxml projects");
});

test("csv export", () => {
    const csv = arr(R.write("csv", [sample()], {}))[0].text;
    const lines = csv.trim().split("\r\n");
    eq(lines.length, 7, "header + 6 clips");
    ok(lines[1].startsWith("V1,a.mov,"), lines[1]);
});

test("29.97 DF round trips", () => {
    const r = rate(29.97, true);
    const tl = M.timeline("DF", r);
    tl.start = 107892;
    const m = M.media({ name: "x.mov", path: "C:/x.mov", rate: r, start: 107892, startKnown: true, duration: 9000 });
    const c = M.clip({ name: "x.mov", media: m, recIn: 0, recOut: 1800, srcIn: 107892 + 1798, srcRate: r });
    c.srcOut = M.srcOutFor(c, tl);
    M.ensureTrack(tl, "video", 0).clips.push(c);
    M.finalize(tl);
    for (const f of ["edl", "xmeml", "fcpxml", "otio"]) {
        const text = arr(R.write(f, [tl], {}))[0].text;
        const t2 = R.read("x." + R.byId(f).ext, text, { rate: rate(29.97) }).timelines[0];
        eq([t2.rate.drop, t2.start, summarize(t2, { kinds: ["video"] })], [true, 107892, summarize(tl, { kinds: ["video"] })], f);
    }
});

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
