// dsp.js: FFT, Welch-PSD, Peaksuche, Drehzahlschaetzung, Ratterbewertung.
// Reine Funktionen ohne DOM, damit sie auch unter Node testbar sind.

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, half = len >> 1;
    for (let k = 0; k < half; k++) {
      const cr = Math.cos(ang * k), ci = Math.sin(ang * k);
      for (let i = k; i < n; i += len) {
        const b = i + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[i] - tr; im[b] = im[i] - ti;
        re[i] += tr; im[i] += ti;
      }
    }
  }
}

// Leistungsdichtespektrum nach Welch (Hann, 50 % Ueberlappung), Ergebnis in dB.
export function welch(x, fs, nper = 16384) {
  while (nper > 256 && nper > x.length) nper >>= 1;
  if (x.length < nper) throw new Error("Aufnahme zu kurz");
  const w = new Float64Array(nper);
  let u = 0;
  for (let i = 0; i < nper; i++) {
    w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nper);
    u += w[i] * w[i];
  }
  const half = nper / 2 + 1, p = new Float64Array(half);
  const re = new Float64Array(nper), im = new Float64Array(nper);
  let segs = 0;
  for (let s = 0; s + nper <= x.length; s += nper >> 1) {
    let m = 0;
    for (let i = 0; i < nper; i++) m += x[s + i];
    m /= nper;
    for (let i = 0; i < nper; i++) { re[i] = (x[s + i] - m) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < half; k++) p[k] += re[k] * re[k] + im[k] * im[k];
    segs++;
  }
  const scale = 1 / (fs * u * segs), db = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    const one = k === 0 || k === half - 1 ? 1 : 2;
    db[k] = 10 * Math.log10(p[k] * scale * one + 1e-20);
  }
  return { df: fs / nper, db, segs, nper };
}

// Gleitender Mittelwert in dB als Grundrauschen.
export function floorDb(db, halfWin) {
  const n = db.length, cs = new Float64Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + db[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWin), b = Math.min(n, i + halfWin + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

// Lokale Maxima mit Mindest-Prominenz, Frequenz parabolisch interpoliert.
export function findPeaks(db, df, { fmin = 50, fmax = 10000, prom = 10, winHz = 400 } = {}) {
  const i0 = Math.max(1, Math.ceil(fmin / df));
  const i1 = Math.min(db.length - 2, Math.floor(fmax / df));
  const W = Math.max(3, Math.round(winHz / df));
  const out = [];
  for (let i = i0; i <= i1; i++) {
    const v = db[i];
    if (!(v > db[i - 1] && v >= db[i + 1])) continue;
    let mL = v, mR = v;
    for (let j = i - 1; j >= Math.max(0, i - W); j--) { if (db[j] > v) break; if (db[j] < mL) mL = db[j]; }
    for (let j = i + 1; j <= Math.min(db.length - 1, i + W); j++) { if (db[j] > v) break; if (db[j] < mR) mR = db[j]; }
    const pr = v - Math.max(mL, mR);
    if (pr < prom) continue;
    const a = db[i - 1], c = db[i + 1], d = a - 2 * v + c;
    const off = d ? 0.5 * (a - c) / d : 0;
    out.push({ i, f: (i + off) * df, db: v - 0.25 * (a - c) * off, prom: pr });
  }
  return out;
}

// Ist-Drehfrequenz aus dem Harmonischen-Kamm schaetzen (Schlupf des Spindelmotors).
export function estimateRot(db, df, f0, { lo = 0.9, hi = 1.03, fmax = 8000 } = {}) {
  const fl = floorDb(db, Math.max(5, Math.round(50 / df)));
  const above = i => Math.min(30, Math.max(0, Math.max(db[i - 1], db[i], db[i + 1]) - fl[i]));
  const H = Math.max(1, Math.min(40, Math.floor(fmax / (f0 * lo))));
  const score = fs => {
    let s = 0, hits = 0;
    for (let h = 1; h <= H; h++) {
      const i = Math.round(h * fs / df);
      if (i < 1 || i >= db.length - 1) break;
      const a = above(i);
      s += a;
      if (a > 6) hits++;
    }
    return { s, hits };
  };
  const step = df / (2 * H), res = [];
  for (let fs = f0 * lo; fs <= f0 * hi; fs += step) res.push({ fs, ...score(fs) });
  const best = res.reduce((a, b) => (b.s > a.s ? b : a), res[0]);
  const top = res.filter(r => r.s >= best.s - 0.5);
  const fs = top.reduce((a, r) => a + r.fs, 0) / top.length;
  const ok = best.hits >= 3;
  return { fs: ok ? fs : f0, measured: ok, hits: best.hits };
}

// RMS-Huellkurve fuer die Bereichswahl.
export function envelope(x, fs, win = 0.05) {
  const n = Math.max(1, Math.round(win * fs)), out = [];
  for (let s = 0; s < x.length; s += n) {
    let q = 0;
    const e = Math.min(x.length, s + n);
    for (let i = s; i < e; i++) q += x[i] * x[i];
    out.push(Math.sqrt(q / (e - s)));
  }
  return { env: Float32Array.from(out), dt: n / fs };
}

// Stationaeren Schnittbereich automatisch waehlen: lauter Teil, Raender 0,3 s abgeschnitten.
export function autoSegment(x, fs) {
  const { env, dt } = envelope(x, fs);
  const dur = x.length / fs;
  const sorted = Array.from(env).sort((a, b) => a - b);
  const thr = 0.5 * sorted[Math.floor(0.9 * (sorted.length - 1))];
  let a = env.findIndex(v => v >= thr), b = env.length - 1;
  while (b > 0 && env[b] < thr) b--;
  let t0 = a * dt + 0.3, t1 = (b + 1) * dt - 0.3;
  if (a < 0 || t1 - t0 < 1) { t0 = 0; t1 = dur; }
  return [Math.max(0, t0), Math.min(dur, t1)];
}

function idleAt(idle, f) {
  if (!idle) return null;
  const i = Math.round(f / idle.df);
  let m = -Infinity;
  for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < idle.db.length) m = Math.max(m, idle.db[j]);
  return m;
}

// Gesamtauswertung. p: {n, z, fmin, fmax, prom, idleMin, rotFs?}
export function analyse(cut, idle, p) {
  const f0 = p.n / 60;
  const base = p.rotFs || f0;
  const rot = estimateRot(cut.db, cut.df, base, p.rotFs ? { lo: 0.95, hi: 1.01, fmax: p.fmax } : { fmax: p.fmax });
  const fs = rot.fs, fz = fs * p.z, slip = fs / f0;
  const fl = floorDb(cut.db, Math.max(5, Math.round(50 / cut.df)));
  const peaks = findPeaks(cut.db, cut.df, { fmin: p.fmin, fmax: p.fmax, prom: p.prom });
  for (const k of peaks) {
    const h = Math.round(k.f / fs);
    const tol = Math.max(1.5 * cut.df, 0.003 * k.f);
    k.h = h;
    k.harmonic = h >= 1 && Math.abs(k.f - h * fs) <= tol;
    k.tooth = k.harmonic && h % p.z === 0;
    k.above = k.db - fl[k.i];
    const id = idleAt(idle, k.f);
    k.overIdle = id === null ? null : k.db - id;
  }
  const cands = peaks
    .filter(k => !k.harmonic && (k.overIdle === null || k.overIdle >= p.idleMin))
    .sort((a, b) => b.above - a.above);
  const maxHarm = peaks.filter(k => k.harmonic).reduce((m, k) => Math.max(m, k.above), 0);
  let verdict = "stabil";
  if (cands.length) verdict = cands[0].above >= 20 && cands[0].above >= maxHarm - 6 ? "rattern" : "verdacht";
  markSidebands(cands, cands[0]?.f, fz, cut.df);
  return { fs, fz, slip, rotMeasured: rot.measured, rotHits: rot.hits, peaks, cands, fc: cands[0]?.f ?? null, verdict };
}

// Seitenbaender fc +- m fz gehoeren zur Ratterfrequenz und sind keine eigene Mode.
export function markSidebands(cands, fc, fz, df) {
  for (const k of cands) {
    k.sideband = false;
    if (fc == null || k.f === fc) continue;
    const m = Math.round((k.f - fc) / fz);
    k.sideband = m !== 0 && Math.abs(m) <= 3 && Math.abs(k.f - fc - m * fz) <= Math.max(2 * df, 0.004 * k.f);
  }
}

// Stabile Drehzahlen n = 60 fc / (z k), umgerechnet auf Soll-Drehzahl ueber den Schlupf.
export function suggest(fc, { z, slip = 1, nmin, nmax, n, vf }) {
  const out = [];
  for (let k = 1; k <= 200; k++) {
    const nAct = 60 * fc / (z * k), nCmd = nAct / slip;
    if (nCmd > nmax) continue;
    if (nCmd < nmin) break;
    const r = Math.round(nCmd / 10) * 10;
    out.push({ k, n: r, nAct: Math.round(nAct), vf: vf ? Math.round(vf * r / n) : null });
    if (out.length >= 4) break;
  }
  return out;
}

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
