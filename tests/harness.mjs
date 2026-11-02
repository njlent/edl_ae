// Shared test harness: loads the ExtendScript core into a VM context that
// lacks the ES5+ built-ins ExtendScript doesn't have, plus a sample timeline.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT, CORE } from "../scripts/build.mjs";

// arrays from the sandbox lack ES5 methods; use the host's
export const arr = (a) => Array.prototype.slice.call(a || []);

// ---- 2. sandbox ----------------------------------------------------------

const ctx = vm.createContext({});
vm.runInContext(`
    (function () {
        var A = Array.prototype, S = String.prototype, i;
        function del(o, ks) { for (i = 0; i < ks.length; i++) { delete o[ks[i]]; } }
        del(A, ["indexOf","lastIndexOf","forEach","map","filter","reduce","reduceRight","some","every","find","findIndex","includes","fill","flat","flatMap","keys","values","entries","at"]);
        del(S, ["trim","trimStart","trimEnd","trimLeft","trimRight","padStart","padEnd","startsWith","endsWith","includes","repeat","at","replaceAll","codePointAt","normalize"]);
        delete Object.keys; delete Object.create; delete Object.defineProperty; delete Object.assign; delete Object.entries; delete Object.values;
        delete Array.isArray; delete Array.from; delete Array.of;
        delete Function.prototype.bind; delete Date.now;
        delete this.JSON; delete this.Map; delete this.Set; delete this.Promise; delete this.Symbol;
    }).call(this);
`, ctx);
vm.runInContext(`var EDLAE = { version: "test" };`, ctx);
for (const rel of CORE) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx, { filename: rel });
}
export const E = ctx.EDLAE;
export const { tc: TC, model: M, formats: R, util: U } = E;

// ---- helpers ---------------------------------------------------------------

export function rate(fps, drop) { return TC.fromFps(fps, !!drop); }

export function summarize(tl, { kinds = ["video", "audio"], srcRound = true } = {}) {
    const out = {};
    for (const kind of kinds) {
        const tracks = arr(kind === "video" ? tl.video : tl.audio);
        tracks.forEach((t, i) => {
            const clips = arr(t.clips).map((c) => ({
                name: c.name, rec: [c.recIn, c.recOut],
                src: srcRound ? Math.round(c.srcIn) : c.srcIn,
                speed: Math.round(c.speed * 1000) / 1000,
                path: c.media ? c.media.path : (c.nested ? "nested:" + c.nested.name : ""),
                tin: c.transitionIn || 0, tout: c.transitionOut || 0,
            }));
            if (clips.length) { out[(kind === "video" ? "V" : "A") + (i + 1)] = clips; }
        });
    }
    return out;
}

export function read(file, opts) {
    const p = path.join(ROOT, "tests", "fixtures", file);
    return R.read(p, fs.readFileSync(p, "utf8"), opts || {});
}

export function fixturePath(file) { return path.join(ROOT, "tests", "fixtures", file); }

// Synthetic timeline used by the round trips.
export function sample() {
    const r24 = rate(24);
    const tl = M.timeline("Round Trip", r24);
    tl.start = 86400;
    tl.width = 1920; tl.height = 1080;
    const a = M.media({ name: "a.mov", path: "C:/media/a.mov", rate: r24, start: 86400, startKnown: true, duration: 2400, width: 1920, height: 1080, hasVideo: true, hasAudio: true });
    const b = M.media({ name: "b.mov", path: "C:/media/b clip.mov", rate: r24, start: 0, startKnown: true, duration: 1000, width: 1920, height: 1080, hasVideo: true });
    const c = M.media({ name: "c.1001.exr", path: "D:/plates/c.1001.exr", rate: r24, start: 1001, startKnown: true, duration: 100, width: 2048, height: 1080, hasVideo: true, sequence: U.parseFrameFile("c.1001.exr") });
    const d = M.media({ name: "d.wav", path: "C:/media/d.wav", rate: r24, start: 0, startKnown: true, duration: 2400, hasVideo: false, hasAudio: true });

    const n = M.timeline("Nest", r24);
    n.start = 0;
    n.duration = 48;
    M.ensureTrack(n, "video", 0).clips.push(M.clip({ name: "a.mov", media: a, recIn: 0, recOut: 48, srcIn: 86500, srcOut: 86548, srcRate: r24 }));
    M.finalize(n);

    const add = (kind, idx, props) => {
        const clip = M.clip(props);
        if (!clip.srcRate) { clip.srcRate = r24; }
        clip.srcOut = M.srcOutFor(clip, tl);
        M.ensureTrack(tl, kind, idx).clips.push(clip);
        return clip;
    };
    add("video", 0, { name: "a.mov", media: a, recIn: 0, recOut: 48, srcIn: 86410, audioLinked: true });
    add("video", 0, { name: "b.mov", media: b, recIn: 60, recOut: 120, srcIn: 100, speed: 2 });
    add("video", 1, { name: "c", media: c, recIn: 30, recOut: 70, srcIn: 1010 });
    add("video", 1, { name: "Nest", nested: n, recIn: 80, recOut: 100, srcIn: 5 });
    add("audio", 0, { name: "a.mov", media: a, recIn: 0, recOut: 48, srcIn: 86410 });
    add("audio", 1, { name: "d.wav", media: d, recIn: 10, recOut: 110, srcIn: 0 });
    tl.markers.push(M.marker({ name: "Marker one", frame: 12 }));
    tl.markers.push(M.marker({ name: "Second", comment: "with note", frame: 100, duration: 5 }));
    tl.duration = 130;
    return M.finalize(tl);
}
