// Frame rates and SMPTE timecode, including drop-frame for 29.97 / 59.94.
//
// A Rate is {fps, base, ntsc, drop}:
//   fps  - exact frames per second (24000/1001 for 23.976)
//   base - integer timecode base (24 for 23.976)
//   ntsc - true for the x/1.001 rates
//   drop - drop-frame counting (only for ntsc 30/60 bases)

EDLAE.tc = (function () {
    var U = EDLAE.util;
    var T = {};

    T.COMMON = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 119.88, 120];

    T.make = function (base, ntsc, drop) {
        base = Math.round(base);
        if (base < 1) { base = 24; }
        ntsc = !!ntsc;
        var canDrop = ntsc && base % 30 === 0;
        return {
            fps: ntsc ? base * 1000 / 1001 : base,
            base: base,
            ntsc: ntsc,
            drop: !!drop && canDrop
        };
    };

    // From any fps number: 23.976, 23.98, 24000/1001, 29.97, 25, 12.5 ...
    T.fromFps = function (fps, drop) {
        fps = Number(fps);
        if (!(fps > 0)) { return T.make(24, false, false); }
        var base = Math.round(fps);
        if (Math.abs(fps - base) < 0.0005) { return T.make(base, false, drop); }
        var ntscBase = Math.round(fps * 1.001);
        if (Math.abs(fps - ntscBase * 1000 / 1001) < 0.006) { return T.make(ntscBase, true, drop); }
        // odd rate (e.g. 12.5): keep the real fps, timecode counts on the rounded base
        return { fps: fps, base: Math.max(1, Math.ceil(fps)), ntsc: false, drop: false };
    };

    T.equal = function (a, b) {
        return !!a && !!b && Math.abs(a.fps - b.fps) < 0.0001;
    };

    T.label = function (rate) {
        var s;
        if (rate.ntsc) { s = U.fmtNum(rate.fps, 3); }
        else if (Math.abs(rate.fps - Math.round(rate.fps)) < 1e-6) { s = String(Math.round(rate.fps)); }
        else { s = U.fmtNum(rate.fps, 3); }
        return s + (rate.drop ? " DF" : "");
    };

    // Seconds per frame as a reduced rational {num, den}.
    T.frameDuration = function (rate) {
        if (rate.ntsc) { return { num: 1001, den: rate.base * 1000 }; }
        if (Math.abs(rate.fps - Math.round(rate.fps)) < 1e-6) { return { num: 100, den: Math.round(rate.fps) * 100 }; }
        var den = Math.round(rate.fps * 1000), num = 1000, g = U.gcd(num, den);
        return { num: num / g, den: den / g };
    };

    function dropCount(rate) { return Math.round(rate.base / 15); } // 2 for 30, 4 for 60

    T.framesPerDay = function (rate) {
        if (rate.drop) { return 24 * 6 * (rate.base * 600 - dropCount(rate) * 9); }
        return 24 * 3600 * rate.base;
    };

    T.toTC = function (frames, rate) {
        frames = Math.round(frames);
        var day = T.framesPerDay(rate);
        frames = ((frames % day) + day) % day;
        var base = rate.base, sep = ":";
        if (rate.drop) {
            var d = dropCount(rate);
            var per10 = base * 600 - d * 9;
            var perMin = base * 60 - d;
            var tens = Math.floor(frames / per10);
            var rem = frames % per10;
            if (rem > d) { frames += d * 9 * tens + d * Math.floor((rem - d) / perMin); }
            else { frames += d * 9 * tens; }
            sep = ";";
        }
        var ff = frames % base;
        var ss = Math.floor(frames / base) % 60;
        var mm = Math.floor(frames / (base * 60)) % 60;
        var hh = Math.floor(frames / (base * 3600)) % 24;
        return U.padLeft(hh, 2, "0") + ":" + U.padLeft(mm, 2, "0") + ":" +
            U.padLeft(ss, 2, "0") + sep + U.padLeft(ff, base > 99 ? 3 : 2, "0");
    };

    T.isTC = function (s) {
        return /^-?\d{1,2}[:;.]\d{1,2}[:;.]\d{1,2}[:;.]\d{1,3}$/.test(U.trim(s));
    };

    // Returns NaN on garbage. A ';' or '.' before the frames field forces
    // drop-frame counting when the rate supports it.
    T.fromTC = function (s, rate) {
        s = U.trim(s);
        var m = /^(-?)(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})([:;.])(\d{1,3})$/.exec(s);
        if (!m) { return NaN; }
        var hh = parseInt(m[2], 10), mm = parseInt(m[3], 10), ss = parseInt(m[4], 10), ff = parseInt(m[6], 10);
        var base = rate.base;
        var drop = rate.drop || ((m[5] === ";" || m[5] === ".") && rate.ntsc && base % 30 === 0);
        var frames = (hh * 3600 + mm * 60 + ss) * base + ff;
        if (drop) {
            var totalMin = hh * 60 + mm;
            frames -= dropCount(rate) * (totalMin - Math.floor(totalMin / 10));
        }
        return m[1] === "-" ? -frames : frames;
    };

    // Convert a frame count between rates via seconds.
    T.convert = function (frames, fromRate, toRate) {
        if (!fromRate || !toRate || T.equal(fromRate, toRate)) { return frames; }
        return frames / fromRate.fps * toRate.fps;
    };

    // Timecode *label* conversion: the same HH:MM:SS:FF on a different base.
    // Used when a media start TC is defined on a different base than the media rate.
    T.convertTCBase = function (frames, fromRate, toRate) {
        if (!fromRate || !toRate || fromRate.base === toRate.base) { return frames; }
        return Math.round(T.fromTC(T.toTC(frames, fromRate).replace(/;/g, ":"), T.make(toRate.base, false, false)) * 1);
    };

    // Floor a record frame to the start of its timecode hour (01:00:00:00 sequences).
    T.hourFloor = function (frames, rate) {
        var tc = T.toTC(frames, rate);
        var hh = parseInt(tc.substring(0, 2), 10);
        return T.fromTC(U.padLeft(hh, 2, "0") + ":00:00:00", rate);
    };

    return T;
}());
