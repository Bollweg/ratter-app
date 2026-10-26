// app.js: Oberflaeche, Aufnahme, Ablauf. Auswertung in dsp.js, Ablage in store.js.
import * as D from "./dsp.js";
import * as S from "./store.js";

const VERSION = "1.0.0";
const DEF = { fmin: 50, fmax: 10000, prom: 10, idleMin: 10, idleDur: 5, maxCut: 30, nper: 16384 };
const OPS = ["Nut", "Seitenschnitt", "Tasche", "Planen", "Zirkular", "Sonstiges"];
const RATINGS = { gut: "Sauber", leicht: "Leichte Marken", rattern: "Rattermarken" };
const RATING_CLS = { gut: "good", leicht: "warn", rattern: "bad" };
const VERDICT = {
  rattern: ["bad", "Rattern erkannt"],
  verdacht: ["warn", "Verdacht auf Rattern"],
  stabil: ["good", "Kein Rattern erkannt"],
};
const STEPS = ["Aufbau", "Leerlauf", "Schnitt", "Auswertung", "Speichern"];
const RPM = "min⁻¹";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v, d = 0) => (v == null || v === "" || !isFinite(v) ? "-" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pnum = v => { const x = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(x) ? x : null; };
const when = ts => new Date(ts).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });

const st = {
  tab: "messen", step: 0, machines: [], setups: [], meas: [], cfg: { ...DEF },
  draft: null, idle: null, cut: null, res: null, fcManual: null, seg: null,
  zoom: 0, log: false, filter: "", detail: null, edit: null, saved: null, back: null, confirm: null,
};

const getSetup = id => st.setups.find(s => s.id === id);
const getMachine = id => st.machines.find(m => m.id === id) || st.machines[0];
const setupLabel = s => `${s.name} (Ø${num(s.d, 1)} mm, z = ${s.z}, ${num(s.stickout)} mm frei)`;

/* ---------- Start ---------- */

async function init() {
  try {
    st.machines = await S.all("maschinen");
    st.setups = await S.all("setups");
    st.meas = await S.all("messungen");
    Object.assign(st.cfg, (await S.kvGet("cfg")) || {});
  } catch (e) {
    toast("Speicher nicht verfügbar: " + e.message);
  }
  if (!st.machines.length) {
    // Annahme: Untergrenze 3000, Obergrenze laut docs/komponenten-spindel.md (4-polig, 599 Hz)
    const m = { id: S.uid(), name: "Spinogy X22 4-polig", nmin: 3000, nmax: 17970 };
    st.machines.push(m);
    S.put("maschinen", m).catch(() => {});
  }
  st.draft = newDraft();
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  $("#nav").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
  const app = $("#app");
  app.addEventListener("click", onClick);
  app.addEventListener("change", onChange);
  app.addEventListener("input", onInput);
  let rt;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(draw, 150); });
  render();
}

function newDraft(b = {}) {
  const last = [...st.meas].sort((x, y) => y.ts - x.ts)[0];
  return {
    id: S.uid(), ts: null,
    setupId: b.setupId ?? last?.setupId ?? st.setups[0]?.id ?? "",
    n: b.n ?? "", vf: b.vf ?? "", ap: b.ap ?? "", ae: b.ae ?? "",
    material: b.material ?? last?.material ?? "", op: b.op ?? last?.op ?? "Nut",
    note: "", rating: null, prevId: b.prevId ?? null,
  };
}

function go(tab) {
  st.tab = tab; st.detail = null; st.edit = null; st.confirm = null;
  render();
}

function render(top = true) {
  if (st.tab !== "messen" || (st.step !== 1 && st.step !== 2)) micRelease();
  $$("#nav [data-tab]").forEach(b => b.setAttribute("aria-current", b.dataset.tab === st.tab ? "page" : "false"));
  const v = { messen: vMessen, verlauf: vVerlauf, setups: vSetups, einst: vEinst }[st.tab];
  $("#app").innerHTML = v();
  if (top) scrollTo(0, 0);
  draw();
}

/* ---------- Messen ---------- */

const stepper = () => `<ol class="steps" aria-label="Ablauf">${STEPS.map((s, i) =>
  `<li class="${i === st.step ? "cur" : i < st.step ? "done" : ""}"><span>${i + 1}</span><em>${s}</em></li>`).join("")}</ol>`;

function vMessen() {
  return stepper() + [vAufbau, vLeerlauf, vSchnitt, vAuswertung, vSpeichern][st.step]();
}

const field = (id, label, unit, val, req = false) => `<label class="fld" for="${id}"><span>${label}${req ? " *" : ""}</span>
  <span class="unit"><input id="${id}" inputmode="decimal" autocomplete="off" value="${esc(val)}"><em>${unit}</em></span></label>`;

function vAufbau() {
  const d = st.draft;
  if (!st.setups.length) return `<section class="card empty"><h2>Zuerst ein Setup anlegen</h2>
    <p>Ein Setup ist die Kombination aus Maschine, Fräser, Halter und Auskragung. Die Ratterfrequenz hängt fast nur davon ab, deshalb gehört jede Messung zu einem Setup.</p>
    <button class="btn pri" data-act="newSetup">Setup anlegen</button></section>`;
  const mats = [...new Set(st.meas.map(m => m.material).filter(Boolean))];
  return `<section class="card"><h2>Was wird gefräst?</h2>
    <label class="fld" for="f-setup"><span>Setup *</span><select id="f-setup">${st.setups.map(s =>
      `<option value="${s.id}" ${s.id === d.setupId ? "selected" : ""}>${esc(setupLabel(s))}</option>`).join("")}</select></label>
    <div class="grid2">
      ${field("f-n", "Soll-Drehzahl", RPM, d.n, true)}
      ${field("f-vf", "Vorschub", "mm/min", d.vf)}
      ${field("f-ap", "Schnitttiefe ap", "mm", d.ap)}
      ${field("f-ae", "Schnittbreite ae", "mm", d.ae)}
    </div>
    <div class="grid2">
      <label class="fld" for="f-mat"><span>Werkstoff</span><input id="f-mat" list="mats" value="${esc(d.material)}" placeholder="z. B. 5083"></label>
      <label class="fld" for="f-op"><span>Bearbeitung</span><select id="f-op">${OPS.map(o => `<option ${o === d.op ? "selected" : ""}>${o}</option>`).join("")}</select></label>
    </div>
    <datalist id="mats">${mats.map(m => `<option value="${esc(m)}">`).join("")}</datalist>
    <button class="link" data-act="newSetup">Neues Setup anlegen</button>
  </section>
  <section class="card tip"><h3>Vorbereitung</h3><ul>
    <li>Spindel einige Minuten warmlaufen lassen.</li>
    <li>Handy 10 bis 30 cm neben die Spindel legen, bei allen Aufnahmen an dieselbe Stelle.</li>
    <li>Absaugung, Kompressor und Radio möglichst aus.</li>
    <li>Einen Schnitt programmieren, der mindestens 5 s gleichmäßig läuft.</li>
    <li>Zum Rattern provozieren die Tiefe schrittweise erhöhen. Die Aufnahme mit Rattern ist die wertvollste.</li>
  </ul></section>
  <div class="bar"><span></span><button class="btn pri" data-act="next1">Weiter zum Leerlauf</button></div>`;
}

const recBlock = () => `<div class="rec"><canvas id="live" class="chart live"></canvas>
  <div class="meter" aria-hidden="true"><i id="lvl"></i></div>
  <div class="recinfo"><span id="rtime">Bereit</span><span id="clip" class="clip" hidden>Übersteuert, Handy weiter weg legen</span></div></div>`;

function idleInfo() {
  const i = st.idle, r = i.rot;
  const nIst = r.fs * 60, slip = (1 - r.fs / (i.n / 60)) * 100;
  return `<p class="ok">Leerlauf aufgenommen (${num(i.dur, 1)} s). ${r.measured
    ? `Ist-Drehzahl <b>${num(nIst)} ${RPM}</b>, Schlupf ${num(slip, 1)} %.`
    : "Drehzahl nicht sicher erkennbar, die App rechnet mit der Soll-Drehzahl."}</p>`;
}

function vLeerlauf() {
  const d = st.draft, i = st.idle, fresh = i && i.n === d.n;
  return `<section class="card"><h2>Leerlauf aufnehmen</h2>
    <p>Spindel auf <b>${num(d.n)} ${RPM}</b>, Fräser frei in der Luft, dann ${st.cfg.idleDur} s aufnehmen. So kennt die App die Geräusche von Spindel, Lüfter und Umrichter und misst die Ist-Drehzahl.</p>
    ${recBlock()}
    ${fresh ? idleInfo() : i ? `<p class="hint">Vorhandene Leerlaufaufnahme gehört zu ${num(i.n)} ${RPM}, bitte neu aufnehmen.</p>` : ""}
    <div class="row"><button class="btn pri" data-act="recIdle">${fresh ? "Neu aufnehmen" : "Aufnahme starten"}</button>
    <label class="btn">WAV-Datei laden<input type="file" accept="audio/*,.wav" id="file-idle" hidden></label></div>
  </section>
  <div class="bar"><button class="btn" data-act="back">Zurück</button>
    <button class="btn ghost" data-act="skipIdle">Ohne Leerlauf</button>
    <button class="btn pri" data-act="next2" ${fresh ? "" : "disabled"}>Weiter</button></div>`;
}

function vSchnitt() {
  const c = st.cut;
  return `<section class="card"><h2>Schnitt aufnehmen</h2>
    <p>Starte die Aufnahme, sobald der Fräser voll im Schnitt ist, und stoppe vor dem Ausfahren. Mindestens 3 s, höchstens ${st.cfg.maxCut} s. Den genauen Bereich wählst du danach.</p>
    ${recBlock()}
    ${c ? `<p class="ok">Schnitt aufgenommen (${num(c.dur, 1)} s).</p>` : ""}
    <div class="row"><button class="btn pri" data-act="recCut">${c ? "Neu aufnehmen" : "Aufnahme starten"}</button>
    <label class="btn">WAV-Datei laden<input type="file" accept="audio/*,.wav" id="file-cut" hidden></label></div>
  </section>
  <div class="bar"><button class="btn" data-act="back">Zurück</button>
    <button class="btn pri" data-act="next3" ${c ? "" : "disabled"}>Zur Auswertung</button></div>`;
}

function kvBlock(r, n, z) {
  const rows = [
    ["Soll-Drehzahl", `${num(n)} ${RPM}`],
    ["Ist-Drehzahl", `${num(r.fs * 60)} ${RPM} <small>${r.rotMeasured ? "gemessen" : "angenommen"}</small>`],
    ["Schlupf", `${num((1 - r.slip) * 100, 1)} %`],
    ["Zahneingriff f<sub>z</sub>", `${num(r.fz)} Hz <small>z = ${z}</small>`],
    ["Ratterfrequenz f<sub>c</sub>", r.fc ? `${num(r.fc)} Hz` : "-"],
    ["f<sub>c</sub> / f<sub>z</sub>", r.fc ? num(r.fc / r.fz, 2) : "-"],
  ];
  return `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

const zoomChips = () => {
  const opts = [1000, 2000, 5000, st.cfg.fmax];
  return `<div class="chips">${opts.map((f, i) => `<button class="chip ${st.zoom === i ? "on" : ""}" data-act="zoom" data-i="${i}">${f >= 1000 ? num(f / 1000) + " kHz" : f}</button>`).join("")}
    <button class="chip ${st.log ? "on" : ""}" data-act="log">log</button></div>`;
};

function peakType(k, r, z, idleMin) {
  if (k.harmonic) return k.tooth ? ["tooth", `Zahneingriff ${k.h / z}×`] : ["muted", `Drehfrequenz ${k.h}×`];
  if (r.fc != null && Math.abs(k.f - r.fc) < 0.5) return ["bad", "Ratterfrequenz"];
  if (k.sideband) return ["warn", "Seitenband"];
  if (k.overIdle != null && k.overIdle < idleMin) return ["muted", "Grundgeräusch"];
  return ["warn", "Nicht harmonisch"];
}

function peakTable(r, z, pick) {
  const rows = [...r.peaks].sort((a, b) => b.above - a.above).slice(0, 14);
  if (!rows.length) return `<p class="hint">Keine deutlichen Peaks gefunden.</p>`;
  return `<div class="scroll"><table class="tbl"><thead><tr><th>Frequenz</th><th>über Grund</th><th>über Leerlauf</th><th>Art</th></tr></thead><tbody>
    ${rows.map(k => {
      const [cls, t] = peakType(k, r, z, st.cfg.idleMin);
      return `<tr ${pick ? `data-act="pickFc" data-f="${k.f}" tabindex="0"` : ""}><td>${num(k.f)} Hz</td><td>${num(k.above, 1)} dB</td><td>${k.overIdle == null ? "-" : num(k.overIdle, 1) + " dB"}</td><td><span class="tag ${cls}">${t}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function suggBlock(fc, sugg, machine, again) {
  if (!fc) return `<section class="card"><h2>Empfehlung</h2><p>Der Schnitt läuft stabil. Erhöhe die Schnitttiefe schrittweise und miss erneut, um die Grenze zu finden.</p></section>`;
  if (!sugg.length) return `<section class="card"><h2>Empfehlung</h2><p>Keine stabile Drehzahl im Bereich ${num(machine?.nmin)} bis ${num(machine?.nmax)} ${RPM}. Abhilfe: kürzere Auskragung, Fräser mit ungleicher Teilung, weniger ap oder ae.</p></section>`;
  return `<section class="card"><h2>Stabile Drehzahlen</h2>
    <p class="hint">n = 60 · f<sub>c</sub> / (z · k), auf Soll-Drehzahl umgerechnet. Das kleinste k gibt die größte stabile Zone.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>k</th><th>Soll-n</th><th>Ist-n</th><th>Vorschub</th></tr></thead><tbody>
    ${sugg.map((s, i) => `<tr class="${i === 0 ? "best" : ""}"><td>${s.k}</td><td><b>${num(s.n)}</b> ${RPM}</td><td>${num(s.nAct)}</td><td>${s.vf ? num(s.vf) + " mm/min" : "-"}</td></tr>`).join("")}
    </tbody></table></div>
    ${again ? `<p class="hint">Nachmessung starten mit:</p><div class="row">${sugg.map((s, i) =>
      `<button class="btn sm ${i === 0 ? "pri" : ""}" data-act="again" data-n="${s.n}" data-vf="${s.vf ?? ""}" data-id="${again}">${num(s.n)} ${RPM}</button>`).join("")}</div>` : ""}
    <p class="hint">Läuft es nicht ganz ruhig, 3 bis 5 % höher probieren. Der Vorschub ist mitskaliert, damit der Zahnvorschub gleich bleibt.</p></section>`;
}

function vAuswertung() {
  const r = st.res, d = st.draft, s = getSetup(d.setupId), m = getMachine(s?.machineId);
  const [cls, label] = VERDICT[r.verdict];
  return `<section class="verdict ${cls}" role="status"><b>${label}</b><span>${r.fc
      ? `Ratterfrequenz ${num(r.fc)} Hz${st.fcManual != null ? " (von Hand gewählt)" : ""}`
      : "Kein nicht-harmonischer Peak über der Schwelle."}</span></section>
    <section class="card"><h2>Kennwerte</h2>${kvBlock(r, d.n, s.z)}</section>
    <section class="card"><div class="head"><h2>Spektrum</h2>${zoomChips()}</div>
      <canvas id="spec" class="chart" data-pick="1"></canvas>
      ${legend()}
      <p class="hint">Tippe auf einen Peak, um ihn als Ratterfrequenz zu setzen.${st.fcManual != null ? ` <button class="link" data-act="fcAuto">Zurück zur Automatik</button>` : ""}</p></section>
    ${suggBlock(r.fc, r.sugg, m)}
    <section class="card"><h2>Bereich der Aufnahme</h2>
      <canvas id="env" class="chart small"></canvas>
      <div class="grid2">
        <label class="fld" for="seg0"><span>Start <b id="s0">${num(st.seg[0], 1)} s</b></span><input type="range" id="seg0" min="0" max="${st.cut.dur}" step="0.1" value="${st.seg[0]}"></label>
        <label class="fld" for="seg1"><span>Ende <b id="s1">${num(st.seg[1], 1)} s</b></span><input type="range" id="seg1" min="0" max="${st.cut.dur}" step="0.1" value="${st.seg[1]}"></label>
      </div>
      <p class="hint">Nur den gleichmäßigen Teil im vollen Schnitt wählen, Ein- und Ausfahren weglassen.</p></section>
    <section class="card"><h2>Peaks</h2>${peakTable(r, s.z, true)}</section>
    <div class="bar"><button class="btn" data-act="back">Zurück</button><button class="btn pri" data-act="next4">Weiter zum Speichern</button></div>`;
}

const legend = () => `<p class="legend"><span><i class="lg cut"></i>Schnitt</span><span><i class="lg idle"></i>Leerlauf</span><span><i class="lg tooth"></i>Zahneingriff und Vielfache</span><span><i class="lg bad"></i>Ratterfrequenz</span></p>`;

function vSpeichern() {
  const d = st.draft, r = st.res, s = getSetup(d.setupId);
  if (st.saved) {
    const m = st.saved;
    return `<section class="verdict good" role="status"><b>Messung gespeichert</b><span>${esc(s?.name)}, ${num(m.n)} ${RPM}, ${when(m.ts)}</span></section>
      ${suggBlock(m.fc, m.sugg, getMachine(s?.machineId), m.id)}
      <section class="card"><h2>Wie weiter?</h2><div class="stack">
        <button class="btn" data-act="deeper">Gleiche Drehzahl, andere Schnitttiefe</button>
        <button class="btn" data-act="fresh">Neue Messung</button>
        <button class="btn ghost" data-act="tab" data-tab="verlauf">Zum Verlauf</button></div></section>`;
  }
  return `<section class="card"><h2>Wie sieht die Oberfläche aus?</h2>
      <div class="opts" role="group" aria-label="Oberfläche">${Object.entries(RATINGS).map(([k, v]) =>
        `<button class="opt ${RATING_CLS[k]} ${d.rating === k ? "on" : ""}" data-act="rate" data-v="${k}" aria-pressed="${d.rating === k}">${v}</button>`).join("")}</div>
      <label class="fld" for="f-note"><span>Notiz</span><textarea id="f-note" rows="3" placeholder="z. B. Geräusch, Späne, Auffälligkeiten">${esc(d.note)}</textarea></label></section>
    <section class="card"><h2>Zusammenfassung</h2><dl class="kv">
      <div><dt>Setup</dt><dd>${esc(s?.name)}</dd></div>
      <div><dt>Drehzahl</dt><dd>${num(d.n)} ${RPM}</dd></div>
      <div><dt>ap / ae</dt><dd>${num(d.ap, 1)} / ${num(d.ae, 1)} mm</dd></div>
      <div><dt>Befund</dt><dd>${VERDICT[r.verdict][1]}</dd></div>
      <div><dt>Ratterfrequenz</dt><dd>${r.fc ? num(r.fc) + " Hz" : "-"}</dd></div>
      <div><dt>Vorschlag</dt><dd>${r.sugg[0] ? num(r.sugg[0].n) + " " + RPM : "-"}</dd></div></dl></section>
    <div class="bar"><button class="btn" data-act="back">Zurück</button><button class="btn pri" data-act="save">Messung speichern</button></div>`;
}

/* ---------- Aufnahme ---------- */

const rec = { ctx: null, stream: null, node: null, an: null, chunks: [], on: false, raf: 0, wake: null };

async function micStart() {
  if (!window.isSecureContext) throw new Error("Mikrofon braucht HTTPS");
  if (!rec.ctx) rec.ctx = new AudioContext();
  await rec.ctx.resume();
  if (rec.stream) return;
  rec.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const code = `registerProcessor("rec", class extends AudioWorkletProcessor {
    process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } });`;
  await rec.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
  const src = rec.ctx.createMediaStreamSource(rec.stream);
  rec.node = new AudioWorkletNode(rec.ctx, "rec");
  rec.an = rec.ctx.createAnalyser();
  rec.an.fftSize = 8192;
  rec.an.smoothingTimeConstant = 0.5;
  const mute = rec.ctx.createGain();
  mute.gain.value = 0;
  src.connect(rec.an);
  src.connect(rec.node);
  rec.node.connect(mute).connect(rec.ctx.destination);
  rec.node.port.onmessage = e => { if (rec.on) rec.chunks.push(e.data); };
}

function micRelease() {
  if (rec.on) recordStop();
  rec.stream?.getTracks().forEach(t => t.stop());
  rec.ctx?.close().catch(() => {});
  Object.assign(rec, { ctx: null, stream: null, node: null, an: null });
}

function micError(e) {
  if (e.name === "NotAllowedError") return "Mikrofon nicht erlaubt. In Chrome: Schloss-Symbol in der Adresszeile, Berechtigungen, Mikrofon zulassen.";
  if (e.name === "NotFoundError") return "Kein Mikrofon gefunden.";
  return "Mikrofon-Fehler: " + e.message;
}

function recordRun(maxSec) {
  rec.chunks = [];
  rec.on = true;
  const t0 = performance.now(), fbuf = new Float32Array(rec.an.frequencyBinCount), tbuf = new Float32Array(rec.an.fftSize);
  let clipUntil = 0, top = -200;
  return new Promise(res => {
    rec.done = res;
    const tick = () => {
      if (!rec.on) return;
      const t = (performance.now() - t0) / 1000;
      rec.an.getFloatFrequencyData(fbuf);
      rec.an.getFloatTimeDomainData(tbuf);
      let pk = 0;
      for (const v of tbuf) pk = Math.max(pk, Math.abs(v));
      if (pk > 0.98) clipUntil = t + 1.5;
      const lv = $("#lvl"), cl = $("#clip"), tm = $("#rtime"), cv = $("#live");
      if (lv) lv.style.width = Math.min(100, Math.max(0, (20 * Math.log10(pk + 1e-9) + 60) / 60 * 100)) + "%";
      if (cl) cl.hidden = t > clipUntil;
      if (tm) tm.textContent = `Aufnahme ${num(t, 1)} s von max. ${maxSec} s`;
      let mx = -200;
      for (const v of fbuf) if (v > mx) mx = v;
      top = Math.max(top - 0.3, Math.ceil((mx + 3) / 10) * 10);
      if (cv) drawSpectrum(cv, { db: fbuf, df: rec.ctx.sampleRate / rec.an.fftSize, fmax: st.cfg.fmax, range: 80, top: Math.ceil(top / 10) * 10 });
      if (t >= maxSec) return recordStop();
      rec.raf = requestAnimationFrame(tick);
    };
    tick();
  });
}

function recordStop() {
  if (!rec.on) return;
  rec.on = false;
  cancelAnimationFrame(rec.raf);
  const n = rec.chunks.reduce((a, c) => a + c.length, 0), x = new Float32Array(n);
  let o = 0;
  for (const c of rec.chunks) { x.set(c, o); o += c.length; }
  rec.chunks = [];
  rec.done?.(x);
}

async function wake(on) {
  try {
    if (on && !rec.wake) rec.wake = await navigator.wakeLock?.request("screen");
    if (!on && rec.wake) { await rec.wake.release(); rec.wake = null; }
  } catch { rec.wake = null; }
}

async function doRecord(kind) {
  try { await micStart(); } catch (e) { toast(micError(e)); return; }
  const btn = $(`[data-act=rec${kind}]`);
  if (kind === "Cut") { btn.textContent = "Stopp"; btn.dataset.act = "stop"; btn.classList.add("stop"); }
  else btn.disabled = true;
  $$(".bar .btn, .rec ~ .row label").forEach(b => b.setAttribute("disabled", ""));
  await wake(true);
  const x = await recordRun(kind === "Idle" ? st.cfg.idleDur : st.cfg.maxCut);
  await wake(false);
  const rate = rec.ctx?.sampleRate || 48000;
  if (x.length < rate * (kind === "Idle" ? 1 : 2)) { toast("Aufnahme zu kurz"); render(false); return; }
  kind === "Idle" ? setIdle(x, rate) : setCut(x, rate);
  render(false);
}

async function loadWav(file, kind) {
  try {
    const buf = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const ab = await ctx.decodeAudioData(buf);
    const x = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const ch = ab.getChannelData(c);
      for (let i = 0; i < x.length; i++) x[i] += ch[i] / ab.numberOfChannels;
    }
    kind === "idle" ? setIdle(x, ab.sampleRate) : setCut(x, ab.sampleRate);
    render(false);
  } catch (e) {
    toast("Datei nicht lesbar: " + e.message);
  }
}

const trim = (spec, fmax) => ({ df: spec.df, db: spec.db.slice(0, Math.min(spec.db.length, Math.ceil(fmax / spec.df) + 2)) });

function setIdle(x, rate) {
  const n = st.draft.n, spec = D.welch(x, rate, st.cfg.nper);
  const rot = D.estimateRot(spec.db, spec.df, n / 60, { fmax: st.cfg.fmax });
  st.idle = { n, rate, dur: x.length / rate, spec: trim(spec, st.cfg.fmax), rot };
}

function setCut(x, rate) {
  const { env, dt } = D.envelope(x, rate);
  st.cut = { x, rate, dur: x.length / rate, env, dt };
  st.seg = D.autoSegment(x, rate);
  st.fcManual = null;
  analyseNow();
}

function analyseNow() {
  const c = st.cut, d = st.draft, s = getSetup(d.setupId);
  const a = Math.round(st.seg[0] * c.rate), b = Math.round(st.seg[1] * c.rate);
  const spec = trim(D.welch(c.x.subarray(a, b), c.rate, st.cfg.nper), st.cfg.fmax);
  const idle = st.idle && st.idle.n === d.n ? st.idle : null;
  const r = D.analyse(spec, idle?.spec, {
    n: d.n, z: s.z, fmin: st.cfg.fmin, fmax: st.cfg.fmax, prom: st.cfg.prom, idleMin: st.cfg.idleMin,
    rotFs: idle?.rot.measured ? idle.rot.fs : null,
  });
  st.res = { ...r, spec, fcAuto: r.fc, idleSpec: idle?.spec ?? null };
  applyFc();
  autoZoom(Math.max(1.3 * (r.fc ?? 0), 3.2 * r.fz));
}

// Kleinsten Ausschnitt waehlen, der die gesuchte Frequenz noch zeigt.
function autoZoom(f) {
  const i = [1000, 2000, 5000].findIndex(x => x >= f);
  st.zoom = i < 0 ? 3 : i;
}

function applyFc() {
  const r = st.res, d = st.draft, s = getSetup(d.setupId), m = getMachine(s?.machineId);
  r.fc = st.fcManual ?? r.fcAuto;
  D.markSidebands(r.cands, r.fc, r.fz, r.spec.df);
  r.sugg = r.fc ? D.suggest(r.fc, { z: s.z, slip: r.slip, nmin: m?.nmin ?? 0, nmax: m?.nmax ?? 1e9, n: d.n, vf: pnum(d.vf) }) : [];
}

/* ---------- Diagramme ---------- */

function prep(cv) {
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return null;
  const dpr = devicePixelRatio || 1;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  return { W, H, g };
}

function colors() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  return { ink: v("--ink"), muted: v("--muted"), line: v("--line"), accent: v("--accent"), tooth: v("--tooth"), bad: v("--bad"), good: v("--good"), warn: v("--warn") };
}

function ticks(f0, f1, log) {
  if (log) return [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f >= f0 && f <= f1);
  const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000].find(s => (f1 - f0) / s <= 6) || 5000;
  const out = [];
  for (let f = Math.ceil(f0 / step) * step; f <= f1; f += step) out.push(f);
  return out;
}

const fLabel = f => (f >= 1000 ? num(f / 1000, f % 1000 ? 1 : 0) + "k" : String(f));

function drawSpectrum(cv, o) {
  const p = prep(cv);
  if (!p) return null;
  const { W, H, g } = p, c = colors();
  const L = 34, R = 6, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
  const log = !!o.log, f0 = log ? 20 : 0;
  const f1 = Math.min(o.fmax, (o.db.length - 1) * o.df);
  const X = f => (log ? L + pw * Math.log(f / f0) / Math.log(f1 / f0) : L + pw * (f - f0) / (f1 - f0));
  const env = (db, df) => {
    const px = new Float32Array(Math.ceil(pw) + 1).fill(-Infinity);
    for (let i = Math.max(1, Math.ceil(f0 / df)); i < db.length && i * df <= f1; i++) {
      const k = Math.round(X(i * df) - L);
      if (db[i] > px[k]) px[k] = db[i];
    }
    return px;
  };
  const main = env(o.db, o.df), idle = o.idle ? env(o.idle.db, o.idle.df) : null;
  let mx = -Infinity;
  for (const v of main) if (v > mx) mx = v;
  if (!isFinite(mx)) mx = 0;
  const top = o.top ?? Math.ceil((mx + 3) / 10) * 10, bot = top - (o.range || 70);
  const Y = v => T + ph * (top - Math.max(bot, Math.min(top, v))) / (top - bot);

  g.strokeStyle = c.line; g.fillStyle = c.muted; g.lineWidth = 1;
  g.textAlign = "right"; g.textBaseline = "middle";
  for (let v = top; v >= bot; v -= 10) {
    g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke();
    if ((top - v) % 20 === 0) g.fillText(String(v), L - 4, Y(v));
  }
  g.textAlign = "center"; g.textBaseline = "top";
  for (const f of ticks(f0, f1, log)) {
    g.beginPath(); g.moveTo(X(f), T); g.lineTo(X(f), T + ph); g.stroke();
    g.fillText(fLabel(f), X(f), T + ph + 5);
  }
  g.textAlign = "left"; g.fillText("Hz", 2, T + ph + 5);

  if (o.fz) {
    g.save(); g.strokeStyle = c.tooth; g.setLineDash([3, 4]); g.globalAlpha = 0.8;
    for (let f = o.fz; f < f1; f += o.fz) { if (f < f0) continue; g.beginPath(); g.moveTo(X(f), T); g.lineTo(X(f), T + ph); g.stroke(); }
    g.restore();
  }
  const line = (px, col, w) => {
    g.strokeStyle = col; g.lineWidth = w; g.lineJoin = "round"; g.beginPath();
    let on = false;
    px.forEach((v, k) => { if (!isFinite(v)) return; const x = L + k, y = Y(v); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; });
    g.stroke();
  };
  if (idle) line(idle, c.muted, 1);
  line(main, c.accent, 1.5);
  if (o.fc) {
    g.strokeStyle = c.bad; g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(o.fc), T); g.lineTo(X(o.fc), T + ph); g.stroke();
    g.fillStyle = c.bad; g.textBaseline = "top";
    g.textAlign = X(o.fc) > W - 70 ? "right" : "left";
    g.fillText(`${num(o.fc)} Hz`, X(o.fc) + (g.textAlign === "left" ? 4 : -4), T + 2);
  }
  for (const k of o.marks || []) {
    if (k.f > f1 || k.f < f0) continue;
    g.fillStyle = k.col; g.beginPath(); g.arc(X(k.f), Y(k.db), 3, 0, 7); g.fill();
  }
  return { inv: x => (log ? f0 * Math.pow(f1 / f0, (x - L) / pw) : f0 + (x - L) / pw * (f1 - f0)), X };
}

function drawEnv(cv) {
  const p = prep(cv);
  if (!p) return;
  const { W, H, g } = p, c = colors(), e = st.cut.env;
  let mx = 1e-9;
  for (const v of e) mx = Math.max(mx, v);
  const bw = W / e.length;
  e.forEach((v, i) => {
    const t = i * st.cut.dt, inSeg = t >= st.seg[0] && t <= st.seg[1];
    g.fillStyle = inSeg ? c.accent : c.line;
    const h = Math.max(1, (H - 4) * v / mx);
    g.fillRect(i * bw, H - h, Math.max(1, bw - 0.5), h);
  });
}

function drawMap(cv, list, s, m, sugg) {
  const p = prep(cv);
  if (!p) return;
  const { W, H, g } = p, c = colors();
  const L = 34, R = 8, T = 10, B = 22, pw = W - L - R, ph = H - T - B;
  const ns = list.map(x => x.n), aps = list.map(x => pnum(x.ap) ?? 0);
  const lo = Math.min(m?.nmin ?? Infinity, ...ns), hi = Math.max(m?.nmax ?? 0, ...ns), pad = 0.04 * (hi - lo || 1000);
  const n0 = lo - pad, n1 = hi + pad;
  const a1 = Math.max(1, ...aps) * 1.2;
  const X = n => L + pw * (n - n0) / (n1 - n0 || 1), Y = a => T + ph * (1 - a / a1);
  g.strokeStyle = c.line; g.fillStyle = c.muted; g.lineWidth = 1;
  g.textAlign = "right"; g.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) { const a = a1 * i / 4; g.beginPath(); g.moveTo(L, Y(a)); g.lineTo(W - R, Y(a)); g.stroke(); g.fillText(num(a, 1), L - 4, Y(a)); }
  g.textAlign = "center"; g.textBaseline = "top";
  for (let i = 0; i <= 4; i++) {
    const n = n0 + (n1 - n0) * i / 4;
    g.textAlign = i === 4 ? "right" : i === 0 ? "left" : "center";
    g.fillText(num(n / 1000, 1) + "k", X(n), T + ph + 6);
  }
  g.save(); g.strokeStyle = c.tooth; g.fillStyle = c.tooth; g.setLineDash([4, 4]); g.textAlign = "left"; g.textBaseline = "top";
  let lastX = Infinity;
  for (const s2 of sugg) {
    const x = X(s2.n);
    g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
    if (lastX - x > 34) { g.fillText(`k=${s2.k}`, x + 3, T); lastX = x; }
  }
  g.restore();
  for (const x of list) {
    const key = x.rating ? RATING_CLS[x.rating] : VERDICT[x.verdict][0];
    g.fillStyle = c[key]; g.beginPath(); g.arc(X(x.n), Y(pnum(x.ap) ?? 0), 5, 0, 7); g.fill();
  }
}

let specMap = null;
function draw() {
  specMap = null;
  const cv = $("#spec");
  if (cv) {
    const src = st.tab === "messen" ? { ...st.res, idleSpec: st.res.idleSpec } : st.meas.find(m => m.id === st.detail);
    if (src?.spec) {
      const fmax = [1000, 2000, 5000, st.cfg.fmax][st.zoom];
      const marks = (src.cands || []).slice(0, 6).map(k => ({ f: k.f, db: k.db ?? src.spec.db[Math.round(k.f / src.spec.df)], col: colors().warn }));
      specMap = drawSpectrum(cv, { db: src.spec.db, df: src.spec.df, idle: src.idleSpec, fmax, log: st.log, fz: src.fz, fc: src.fc, marks });
    }
  }
  if ($("#env") && st.cut) drawEnv($("#env"));
  const mc = $("#map");
  if (mc && st.filter) {
    const s = getSetup(st.filter), list = st.meas.filter(m => m.setupId === st.filter);
    drawMap(mc, list, s, getMachine(s?.machineId), setupSugg(s, list).sugg);
  }
  const lv = $("#live");
  if (lv && !rec.on) drawSpectrum(lv, { db: new Float32Array(2048).fill(-200), df: 24, fmax: st.cfg.fmax, range: 80, top: -20 });
}

/* ---------- Verlauf ---------- */

function setupSugg(s, list) {
  const hits = list.filter(x => x.fc && x.verdict !== "stabil");
  const fcs = hits.map(x => x.fc), med = D.median(fcs), slip = D.median(hits.map(x => x.slip)) ?? 1;
  const m = getMachine(s?.machineId);
  const sugg = med && s ? D.suggest(med, { z: s.z, slip, nmin: m?.nmin ?? 0, nmax: m?.nmax ?? 1e9, n: 1, vf: null }) : [];
  return { fcs, med, sugg };
}

function vVerlauf() {
  if (st.detail) return vDetail();
  const list = st.meas.filter(m => !st.filter || m.setupId === st.filter).sort((a, b) => b.ts - a.ts);
  let sum = "";
  if (st.filter) {
    const s = getSetup(st.filter), { fcs, med, sugg } = setupSugg(s, list);
    const spread = fcs.length > 1 && (Math.max(...fcs) - Math.min(...fcs)) / med > 0.1;
    sum = `<section class="card"><h2>${esc(s?.name ?? "Setup")}</h2>
      <dl class="kv"><div><dt>Messungen</dt><dd>${list.length}</dd></div>
      <div><dt>Ratterfrequenzen</dt><dd>${fcs.length ? fcs.map(f => num(f)).join(", ") + " Hz" : "-"}</dd></div>
      <div><dt>Median f<sub>c</sub></dt><dd>${med ? num(med) + " Hz" : "-"}</dd></div></dl>
      ${spread ? `<p class="hint warn">Die Ratterfrequenzen streuen um mehr als 10 %. Vermutlich sind verschiedene Moden beteiligt, Werte einzeln prüfen.</p>` : ""}
      ${sugg.length ? `<p>Stabile Drehzahlen für dieses Setup:</p><div class="chips">${sugg.map(x => `<span class="chip on">k=${x.k}: ${num(x.n)} ${RPM}</span>`).join("")}</div>` : ""}
      ${list.length ? `<h3>Stabilitätskarte</h3><p class="hint">Schnitttiefe ap in mm über der Soll-Drehzahl. Jeder Punkt ist eine Messung.</p><canvas id="map" class="chart"></canvas>
      <p class="legend"><span><i class="lg good"></i>Sauber</span><span><i class="lg warn"></i>Leichte Marken</span><span><i class="lg bad"></i>Rattermarken</span><span><i class="lg tooth"></i>Vorschläge</span></p>` : ""}
    </section>`;
  }
  return `<section class="card"><h2>Verlauf</h2>
    <label class="fld" for="f-filter"><span>Setup</span><select id="f-filter"><option value="">Alle Setups</option>${st.setups.map(s =>
      `<option value="${s.id}" ${s.id === st.filter ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label></section>
    ${sum}
    ${list.length ? `<ul class="list">${list.map(item).join("")}</ul>` : `<section class="card empty"><h2>Noch keine Messungen</h2>
      <p>Gespeicherte Messungen erscheinen hier mit Befund, Ratterfrequenz und Drehzahlvorschlag.</p>
      <button class="btn pri" data-act="tab" data-tab="messen">Messung starten</button></section>`}`;
}

function item(m) {
  const s = getSetup(m.setupId), cls = m.rating ? RATING_CLS[m.rating] : VERDICT[m.verdict][0];
  return `<li><button class="item" data-act="open" data-id="${m.id}">
    <span class="dot ${cls}"></span>
    <span class="main"><b>${esc(s?.name ?? "Setup gelöscht")}</b><small>${when(m.ts)} · ${num(m.n)} ${RPM} · ap ${num(pnum(m.ap), 1)} · ae ${num(pnum(m.ae), 1)}</small></span>
    <span class="side">${m.fc ? num(m.fc) + " Hz" : "stabil"}<small>${RATINGS[m.rating] ?? ""}</small></span></button></li>`;
}

function vDetail() {
  const m = st.meas.find(x => x.id === st.detail);
  if (!m) { st.detail = null; return vVerlauf(); }
  const s = getSetup(m.setupId), [cls, label] = VERDICT[m.verdict];
  return `<div class="bar top"><button class="btn" data-act="closeDetail">Zurück zur Liste</button></div>
    <section class="verdict ${cls}"><b>${label}</b><span>${esc(s?.name ?? "Setup gelöscht")}, ${when(m.ts)}</span></section>
    <section class="card"><h2>Kennwerte</h2>${kvBlock(m, m.n, m.z)}
      <dl class="kv"><div><dt>Vorschub</dt><dd>${num(pnum(m.vf))} mm/min</dd></div><div><dt>ap / ae</dt><dd>${num(pnum(m.ap), 1)} / ${num(pnum(m.ae), 1)} mm</dd></div>
      <div><dt>Werkstoff</dt><dd>${esc(m.material) || "-"}</dd></div><div><dt>Bearbeitung</dt><dd>${esc(m.op)}</dd></div>
      <div><dt>Oberfläche</dt><dd>${RATINGS[m.rating] ?? "-"}</dd></div><div><dt>f<sub>c</sub></dt><dd>${m.fcManual ? "von Hand" : "automatisch"}</dd></div></dl>
      ${m.note ? `<p class="note">${esc(m.note)}</p>` : ""}</section>
    <section class="card"><div class="head"><h2>Spektrum</h2>${zoomChips()}</div><canvas id="spec" class="chart"></canvas>${legend()}</section>
    ${suggBlock(m.fc, m.sugg, getMachine(s?.machineId), m.id)}
    <section class="card"><h2>Messung</h2><div class="stack">
      <button class="btn" data-act="template" data-id="${m.id}">Als Vorlage für neue Messung</button>
      <button class="btn danger" data-act="delMeas" data-id="${m.id}">${st.confirm === "m" + m.id ? "Wirklich löschen?" : "Messung löschen"}</button></div></section>`;
}

/* ---------- Setups ---------- */

function vSetups() {
  if (st.edit) return setupForm(st.edit);
  const count = id => st.meas.filter(m => m.setupId === id).length;
  return `<section class="card"><h2>Setups</h2><p class="hint">Maschine, Fräser, Halter und Auskragung. Ändert sich eines davon, ändert sich die Ratterfrequenz, also neues Setup anlegen.</p>
    <button class="btn pri" data-act="newSetup">Neues Setup</button></section>
    ${st.setups.length ? `<ul class="list">${st.setups.map(s => `<li><button class="item" data-act="editSetup" data-id="${s.id}">
      <span class="main"><b>${esc(s.name)}</b><small>Ø${num(s.d, 1)} mm · z = ${s.z} · ${num(s.stickout)} mm frei · ${esc(s.holder || "Halter ?")} · ${esc(getMachine(s.machineId)?.name)}</small></span>
      <span class="side">${count(s.id)}<small>Messungen</small></span></button></li>`).join("")}</ul>` : ""}`;
}

function setupForm(s) {
  return `<section class="card"><h2>${s.id ? "Setup bearbeiten" : "Neues Setup"}</h2>
    <label class="fld" for="s-name"><span>Bezeichnung *</span><input id="s-name" value="${esc(s.name)}" placeholder="z. B. VHM 8 mm 3Z Alu"></label>
    <label class="fld" for="s-mach"><span>Maschine</span><select id="s-mach">${st.machines.map(m => `<option value="${m.id}" ${m.id === s.machineId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
    <div class="grid2">
      ${field("s-d", "Durchmesser", "mm", s.d ?? "")}
      ${field("s-z", "Schneiden z", "", s.z ?? "", true)}
      ${field("s-stick", "Auskragung", "mm", s.stickout ?? "")}
      <label class="fld" for="s-holder"><span>Halter</span><input id="s-holder" value="${esc(s.holder)}" placeholder="z. B. HSK-E25 Spannzange"></label>
    </div>
    <label class="fld" for="s-note"><span>Notiz</span><textarea id="s-note" rows="2">${esc(s.note)}</textarea></label></section>
    <div class="bar"><button class="btn" data-act="cancelSetup">Abbrechen</button>
      ${s.id ? `<button class="btn danger" data-act="delSetup">${st.confirm === "s" + s.id ? "Wirklich löschen?" : "Löschen"}</button>` : ""}
      <button class="btn pri" data-act="saveSetup">Speichern</button></div>`;
}

/* ---------- Einstellungen ---------- */

function vEinst() {
  const c = st.cfg;
  return `<section class="card"><h2>Maschinen</h2><p class="hint">Drehzahlbereich der Spindel. Vorschläge außerhalb davon blendet die App aus.</p>
    ${st.machines.map(m => `<div class="mrow" data-id="${m.id}">
      <label class="fld"><span>Name</span><input class="m-name" value="${esc(m.name)}"></label>
      <label class="fld"><span>n min</span><input class="m-min" inputmode="numeric" value="${m.nmin}"></label>
      <label class="fld"><span>n max</span><input class="m-max" inputmode="numeric" value="${m.nmax}"></label>
      ${st.machines.length > 1 ? `<button class="btn sm danger" data-act="delMachine" data-id="${m.id}" aria-label="Maschine löschen">×</button>` : ""}</div>`).join("")}
    <div class="row"><button class="btn" data-act="addMachine">Maschine hinzufügen</button><button class="btn pri" data-act="saveMachines">Speichern</button></div></section>
  <section class="card"><h2>Auswertung</h2><div class="grid2">
    ${field("c-fmin", "Untere Grenze", "Hz", c.fmin)}${field("c-fmax", "Obere Grenze", "Hz", c.fmax)}
    ${field("c-prom", "Mindest-Prominenz", "dB", c.prom)}${field("c-idle", "Abstand zum Leerlauf", "dB", c.idleMin)}
    ${field("c-idur", "Dauer Leerlauf", "s", c.idleDur)}${field("c-maxcut", "Max. Schnittaufnahme", "s", c.maxCut)}</div>
    <div class="row"><button class="btn" data-act="cfgReset">Standardwerte</button><button class="btn pri" data-act="cfgSave">Speichern</button></div></section>
  <section class="card"><h2>Daten</h2><p class="hint">Alles liegt nur auf diesem Handy. Sichere regelmäßig per Export.</p><div class="stack">
    <button class="btn" data-act="exportJson">Sicherung exportieren (JSON)</button>
    <button class="btn" data-act="exportCsv">Tabelle exportieren (CSV)</button>
    <label class="btn">Sicherung importieren<input type="file" accept=".json,application/json" id="file-import" hidden></label>
    <button class="btn danger" data-act="wipe">${st.confirm === "wipe" ? "Wirklich alles löschen?" : "Alle Daten löschen"}</button></div></section>
  <section class="card tip"><h3>So funktioniert die Methode</h3>
    <p>Beim Fräsen erzeugt jeder Zahneingriff eine Anregung mit f<sub>z</sub> = n · z / 60 und deren Vielfachen. Diese Peaks sind normal. Rattern ist eine selbsterregte Schwingung nahe einer Eigenfrequenz von Werkzeug, Halter oder Maschine. Sie erscheint als starker Peak, der kein Vielfaches der Drehfrequenz ist.</p>
    <p>Stabile Zonen liegen dort, wo eine ganze Zahl von Wellen zwischen zwei Zahneingriffe passt: n = 60 · f<sub>c</sub> / (z · k). Je kleiner k, desto größer die stabile Zone. Die Ratterfrequenz liegt etwas über der Eigenfrequenz, daher den Vorschlag bei Bedarf leicht nach oben anpassen.</p>
    <p>Bleibt es bei keinem k ruhig, ist das System zu weich: kürzere Auskragung, Fräser mit ungleicher Teilung, weniger ap oder ae.</p></section>
  <p class="foot">Ratter-Assistent ${VERSION} · Messung mit dem Handymikrofon, Auswertung auf dem Gerät</p>`;
}

/* ---------- Ereignisse ---------- */

function readAufbau() {
  const d = st.draft;
  d.setupId = $("#f-setup")?.value ?? d.setupId;
  d.n = pnum($("#f-n")?.value) ?? "";
  d.vf = pnum($("#f-vf")?.value) ?? "";
  d.ap = pnum($("#f-ap")?.value) ?? "";
  d.ae = pnum($("#f-ae")?.value) ?? "";
  d.material = $("#f-mat")?.value.trim() ?? d.material;
  d.op = $("#f-op")?.value ?? d.op;
}

function startDraft(b) {
  st.draft = newDraft(b);
  st.cut = null; st.res = null; st.saved = null; st.fcManual = null;
  st.tab = "messen"; st.step = 0; st.detail = null;
  render();
}

const actions = {
  tab: a => go(a.dataset.tab),
  newSetup: () => { if (st.tab === "messen") { readAufbau(); st.back = "messen"; } st.tab = "setups"; st.edit = { name: "", machineId: st.machines[0]?.id, z: 3 }; render(); },
  next1: () => {
    const before = `${st.draft.setupId}|${st.draft.n}`;
    readAufbau();
    if (before !== `${st.draft.setupId}|${st.draft.n}`) { st.cut = null; st.res = null; }
    const s = getSetup(st.draft.setupId);
    if (!s) return toast("Bitte ein Setup wählen.");
    if (!(st.draft.n > 0)) return toast("Bitte die Soll-Drehzahl eintragen.");
    st.step = 1; render();
  },
  back: () => { if (st.step === 0) return; if (st.step === 4) st.saved = null; st.step--; render(); },
  recIdle: () => doRecord("Idle"),
  recCut: () => doRecord("Cut"),
  stop: () => recordStop(),
  skipIdle: () => { st.idle = null; st.step = 2; render(); },
  next2: () => { st.step = 2; render(); },
  next3: () => { if (st.res) { st.step = 3; render(); } },
  next4: () => { st.step = 4; render(); },
  zoom: a => { st.zoom = +a.dataset.i; refreshChips(); draw(); },
  log: () => { st.log = !st.log; refreshChips(); draw(); },
  pickFc: a => setFc(+a.dataset.f),
  fcAuto: () => { st.fcManual = null; applyFc(); render(false); },
  rate: a => { st.draft.rating = a.dataset.v; st.draft.note = $("#f-note").value; render(false); },
  save: async () => {
    const d = st.draft, r = st.res, s = getSetup(d.setupId);
    d.note = $("#f-note").value.trim();
    if (!d.rating) return toast("Bitte die Oberfläche bewerten.");
    const m = {
      ...d, ts: Date.now(), z: s.z, seg: st.seg, dur: st.cut.dur, rate: st.cut.rate,
      fs: r.fs, slip: r.slip, rotMeasured: r.rotMeasured, fz: r.fz, fc: r.fc, fcAuto: r.fcAuto, fcManual: st.fcManual != null,
      verdict: r.verdict, sugg: r.sugg,
      cands: r.cands.slice(0, 6).map(k => ({ f: k.f, db: k.db, above: k.above, overIdle: k.overIdle, sideband: k.sideband })),
      spec: r.spec, idleSpec: r.idleSpec,
    };
    try { await S.put("messungen", m); } catch (e) { return toast("Speichern fehlgeschlagen: " + e.message); }
    st.meas.push(m); st.saved = m; render();
  },
  again: a => {
    const m = st.meas.find(x => x.id === a.dataset.id) || st.saved;
    startDraft({ ...m, n: +a.dataset.n, vf: pnum(a.dataset.vf) ?? m.vf, prevId: m.id });
  },
  deeper: () => { const m = st.saved; startDraft({ ...m, prevId: m.id }); },
  fresh: () => startDraft({}),
  open: a => {
    const m = st.meas.find(x => x.id === a.dataset.id);
    autoZoom(Math.max(1.3 * (m.fc ?? 0), 3.2 * m.fz));
    st.detail = m.id; st.confirm = null; render();
  },
  closeDetail: () => { st.detail = null; render(); },
  template: a => { const m = st.meas.find(x => x.id === a.dataset.id); startDraft({ ...m, prevId: m.id }); },
  delMeas: async a => {
    const id = a.dataset.id;
    if (st.confirm !== "m" + id) { st.confirm = "m" + id; return render(false); }
    await S.del("messungen", id);
    st.meas = st.meas.filter(m => m.id !== id); st.detail = null; st.confirm = null; render();
  },
  editSetup: a => { st.edit = { ...getSetup(a.dataset.id) }; st.confirm = null; render(); },
  cancelSetup: () => { st.edit = null; if (st.back) { st.tab = st.back; st.back = null; } render(); },
  saveSetup: async () => {
    const s = {
      ...st.edit, id: st.edit.id || S.uid(), name: $("#s-name").value.trim(), machineId: $("#s-mach").value,
      d: pnum($("#s-d").value), z: Math.round(pnum($("#s-z").value) ?? 0), stickout: pnum($("#s-stick").value),
      holder: $("#s-holder").value.trim(), note: $("#s-note").value.trim(),
    };
    if (!s.name) return toast("Bitte eine Bezeichnung eingeben.");
    if (!(s.z >= 1 && s.z <= 12)) return toast("Schneidenzahl z muss zwischen 1 und 12 liegen.");
    await S.put("setups", s);
    st.setups = st.setups.filter(x => x.id !== s.id).concat(s);
    st.edit = null;
    if (st.back) { st.tab = st.back; st.back = null; st.draft.setupId = s.id; }
    render();
  },
  delSetup: async () => {
    const id = st.edit.id;
    if (st.confirm !== "s" + id) { st.confirm = "s" + id; return render(false); }
    await S.del("setups", id);
    st.setups = st.setups.filter(x => x.id !== id); st.edit = null; st.confirm = null; render();
  },
  addMachine: () => { readMachines(); st.machines.push({ id: S.uid(), name: "Neue Maschine", nmin: 1000, nmax: 24000 }); render(false); },
  delMachine: async a => { readMachines(); st.machines = st.machines.filter(m => m.id !== a.dataset.id); await S.del("maschinen", a.dataset.id); render(false); },
  saveMachines: async () => {
    readMachines();
    if (st.machines.some(m => !(m.nmin > 0 && m.nmax > m.nmin))) return toast("Drehzahlbereich prüfen: n max muss größer als n min sein.");
    for (const m of st.machines) await S.put("maschinen", m);
    toast("Maschinen gespeichert");
  },
  cfgSave: async () => {
    const c = { fmin: pnum($("#c-fmin").value), fmax: pnum($("#c-fmax").value), prom: pnum($("#c-prom").value),
      idleMin: pnum($("#c-idle").value), idleDur: pnum($("#c-idur").value), maxCut: pnum($("#c-maxcut").value) };
    if (Object.values(c).some(v => !(v > 0)) || c.fmax <= c.fmin || c.fmax > 20000) return toast("Werte prüfen: alle positiv, obere Grenze höchstens 20 000 Hz.");
    Object.assign(st.cfg, c);
    await S.kvSet("cfg", st.cfg);
    toast("Einstellungen gespeichert");
  },
  cfgReset: async () => { st.cfg = { ...DEF }; await S.kvSet("cfg", st.cfg); render(false); toast("Standardwerte gesetzt"); },
  exportJson: () => shareFile(`ratter-sicherung-${stamp()}.json`, JSON.stringify(exportData()), "application/json"),
  exportCsv: () => shareFile(`ratter-messungen-${stamp()}.csv`, csv(), "text/csv"),
  wipe: async () => {
    if (st.confirm !== "wipe") { st.confirm = "wipe"; return render(false); }
    for (const s of ["messungen", "setups"]) await S.clear(s);
    st.meas = []; st.setups = []; st.confirm = null; st.draft = newDraft(); st.step = 0;
    render(); toast("Alle Messungen und Setups gelöscht");
  },
};

function readMachines() {
  st.machines = $$(".mrow").map(r => ({ id: r.dataset.id, name: $(".m-name", r).value.trim() || "Maschine", nmin: pnum($(".m-min", r).value), nmax: pnum($(".m-max", r).value) }));
}

function refreshChips() {
  const h = $(".head .chips");
  if (h) h.outerHTML = zoomChips();
}

function setFc(f) {
  if (st.tab !== "messen" || !st.res) return;
  st.fcManual = f;
  applyFc();
  render(false);
}

function onClick(e) {
  const a = e.target.closest("[data-act]");
  if (a && !a.disabled) { actions[a.dataset.act]?.(a, e); return; }
  const cv = e.target.closest("canvas[data-pick]");
  if (cv && specMap && st.res) {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    let best = null, bd = 16;
    for (const k of st.res.peaks) { const d = Math.abs(specMap.X(k.f) - x); if (d < bd) { bd = d; best = k; } }
    if (best) setFc(best.f);
    else toast("Kein Peak an dieser Stelle");
  }
}

function onChange(e) {
  const t = e.target;
  if (t.id === "file-idle" && t.files[0]) loadWav(t.files[0], "idle");
  if (t.id === "file-cut" && t.files[0]) loadWav(t.files[0], "cut");
  if (t.id === "file-import" && t.files[0]) importData(t.files[0]);
  if (t.id === "f-filter") { st.filter = t.value; render(false); }
  if (t.id === "seg0" || t.id === "seg1") { analyseNow(); render(false); }
}

function onInput(e) {
  const t = e.target;
  if (t.id === "seg0" || t.id === "seg1") {
    let a = +$("#seg0").value, b = +$("#seg1").value;
    if (b - a < 1) { if (t.id === "seg0") a = Math.max(0, b - 1); else b = Math.min(st.cut.dur, a + 1); }
    st.seg = [a, b];
    $("#s0").textContent = num(a, 1) + " s";
    $("#s1").textContent = num(b, 1) + " s";
    drawEnv($("#env"));
  }
}

/* ---------- Export / Import ---------- */

const stamp = () => new Date().toISOString().slice(0, 10);
const round1 = a => Array.from(a, v => Math.round(v * 10) / 10);

function exportData() {
  const spec = s => (s ? { df: s.df, db: round1(s.db) } : null);
  return {
    app: "ratter-assistent", version: VERSION, exported: new Date().toISOString(),
    machines: st.machines, setups: st.setups, cfg: st.cfg,
    measurements: st.meas.map(m => ({ ...m, spec: spec(m.spec), idleSpec: spec(m.idleSpec) })),
  };
}

async function importData(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== "ratter-assistent") throw new Error("keine Sicherung dieser App");
    const spec = s => (s ? { df: s.df, db: Float32Array.from(s.db) } : null);
    for (const m of j.machines || []) await S.put("maschinen", m);
    for (const s of j.setups || []) await S.put("setups", s);
    for (const m of j.measurements || []) await S.put("messungen", { ...m, spec: spec(m.spec), idleSpec: spec(m.idleSpec) });
    st.machines = await S.all("maschinen"); st.setups = await S.all("setups"); st.meas = await S.all("messungen");
    render(false);
    toast(`Importiert: ${j.measurements?.length ?? 0} Messungen, ${j.setups?.length ?? 0} Setups`);
  } catch (e) {
    toast("Import fehlgeschlagen: " + e.message);
  }
}

function csv() {
  const dec = (v, d = 1) => (v == null || v === "" || !isFinite(v) ? "" : Number(v).toFixed(d).replace(".", ","));
  const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["Datum", "Setup", "Maschine", "D mm", "z", "Auskragung mm", "Halter", "n soll", "n ist", "Schlupf %", "Vorschub", "ap", "ae", "Werkstoff", "Bearbeitung", "f_z Hz", "f_c Hz", "f_c von Hand", "Befund", "Oberfläche", "Vorschlag k", "Vorschlag n", "Notiz"];
  const rows = [...st.meas].sort((a, b) => a.ts - b.ts).map(m => {
    const s = getSetup(m.setupId) || {}, g = m.sugg?.[0];
    return [new Date(m.ts).toLocaleString("de-DE"), q(s.name), q(getMachine(s.machineId)?.name), dec(s.d), m.z, dec(s.stickout, 0), q(s.holder),
      dec(m.n, 0), dec(m.fs * 60, 0), dec((1 - m.slip) * 100, 2), dec(pnum(m.vf), 0), dec(pnum(m.ap), 2), dec(pnum(m.ae), 2), q(m.material), q(m.op),
      dec(m.fz), dec(m.fc), m.fcManual ? "ja" : "nein", VERDICT[m.verdict][1], RATINGS[m.rating] ?? "", g?.k ?? "", g?.n ?? "", q(m.note)].join(";");
  });
  return "﻿" + [head.join(";"), ...rows].join("\r\n");
}

async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3500);
}

init();
