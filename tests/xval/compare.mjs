// Cross-validation step 3: read the OTIO-authored files (theirs.*) with our
// readers and compare against theirs_expected.json, and check what OTIO saw
// in our files (ours_read_by_otio.json).
//
//   node tests/xval/compare.mjs build/xval

import fs from "node:fs";
import path from "node:path";
import { R, TC, arr } from "../harness.mjs";

const dir = path.resolve(process.argv[2] || "build/xval");
const exp = JSON.parse(fs.readFileSync(path.join(dir, "theirs_expected.json"), "utf8"));
let bad = 0;
const check = (cond, msg) => { console.log((cond ? "ok   " : "FAIL ") + msg); if (!cond) { bad++; } };

for (const [adapter, err] of Object.entries(exp.write_errors)) { console.log(`skip theirs via ${adapter}: OTIO could not write it (${err})`); }

for (const ext of ["otio", "xml", "fcpxml", "edl"]) {
    const file = path.join(dir, "theirs." + ext);
    if (!fs.existsSync(file)) { continue; }
    let tl;
    try { tl = R.read(file, fs.readFileSync(file, "utf8"), { rate: TC.fromFps(23.976) }).timelines[0]; }
    catch (e) { check(false, `theirs.${ext}: ${e.message}`); continue; }
    const got = {};
    arr(tl.video).forEach((t, i) => {
        const rows = arr(t.clips).map((c) => [c.name, c.recIn, c.recOut, Math.round(c.srcIn)]);
        if (rows.length) { got["V" + (i + 1)] = rows; }
    });
    const want = { V1: exp.expected.V1 };
    if (ext !== "edl") { want.V2 = exp.expected.V2; }
    // names differ by adapter (EDL uses FROM CLIP NAME), compare timing first, names loosely
    const timing = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((r) => r.slice(1))])));
    check(timing(got) === timing(want), `theirs.${ext} timing  got ${timing(got)}`);
    // OTIO's CMX writer drops global_start_time and records from 00:00:00:00
    check(tl.start === (ext === "edl" ? 0 : exp.expected.start), `theirs.${ext} start ${tl.start}`);
    const paths = arr(tl.video[0].clips).map((c) => c.media && c.media.path);
    check(JSON.stringify(paths) === JSON.stringify(["C:/media/a.mov", "C:/media/b clip.mov"]), `theirs.${ext} media paths ${JSON.stringify(paths)}`);
    check(Math.abs(tl.rate.fps - 24000 / 1001) < 1e-6, `theirs.${ext} rate ${tl.rate.fps}`);
}

const seen = JSON.parse(fs.readFileSync(path.join(dir, "ours_read_by_otio.json"), "utf8"));
for (const [file, s] of Object.entries(seen)) {
    check(!s.error, `OTIO reads ${file}${s.error ? ": " + s.error : ""}`);
}
const v1 = (f) => (seen[f] && seen[f].tracks && seen[f].tracks.V1) || [];
check(JSON.stringify(v1("ours.otio").map((r) => r.speed)) === "[1,2]", "OTIO sees 200% in ours.otio");
check(JSON.stringify(v1("ours.edl").map((r) => r.speed)) === "[1,2]", "OTIO sees M2 200% in ours.edl");
check(JSON.stringify(v1("ours.xml").map((r) => [r.rec, r.src])) === "[[[0,48],86410],[[60,120],100]]", "OTIO reads ours.xml V1 timing");
console.log(bad ? `${bad} cross-check(s) failed` : "cross-checks passed");
process.exit(bad ? 1 : 0);
