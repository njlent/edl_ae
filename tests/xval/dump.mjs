// Cross-validation step 1: write the sample timeline with our writers so
// OpenTimelineIO's adapters can read it (tests/xval/otio_check.py).
//
//   node tests/xval/dump.mjs build/xval

import fs from "node:fs";
import path from "node:path";
import { R, arr, sample, summarize } from "../harness.mjs";

const out = path.resolve(process.argv[2] || "build/xval");
fs.mkdirSync(out, { recursive: true });
const tl = sample();
for (const [fmt, ext] of [["edl", "edl"], ["xmeml", "xml"], ["fcpxml", "fcpxml"], ["otio", "otio"]]) {
    arr(R.write(fmt, [tl], {})).forEach((f, i) => {
        fs.writeFileSync(path.join(out, `ours${i ? "_" + (i + 1) : ""}.${ext}`), f.text);
    });
}
fs.writeFileSync(path.join(out, "ours_expected.json"), JSON.stringify(summarize(tl), null, 1));
console.log("wrote", out);
