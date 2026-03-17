/**
 * NEXUS — App Controller
 * Handles arc gauge, smooth animation, phase transitions, and test orchestration.
 */

'use strict';

// ── Arc geometry ──────────────────────────────────────────────
const CX = 150, CY = 165, R = 128, A0 = 215, A1 = 505, ASWEEP = 290;

function polar(deg, r) {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}
function arcD(s, e) {
  const p1 = polar(s, R), p2 = polar(e, R);
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${R} ${R} 0 ${(e - s) > 180 ? 1 : 0} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}
function buildArc() {
  const isLight = document.documentElement.classList.contains('light');
  const track = document.getElementById('arc-track');
  const prog  = document.getElementById('arc-prog');
  const full  = arcD(A0, A1);
  track.setAttribute('d', full);
  track.setAttribute('stroke', isLight ? '#ccc' : '#1e1e1e');
  prog.setAttribute('d', full);
  const len = Math.PI * R * ASWEEP / 180;
  prog.style.strokeDasharray = len;
  prog.style.strokeDashoffset = len;
  prog._len = len;
}
function arcProg(frac, color) {
  const prog = document.getElementById('arc-prog');
  prog.style.strokeDashoffset = (prog._len || 1) * (1 - Math.min(1, Math.max(0, frac)));
  if (color) prog.style.stroke = color;
}
function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

// ── State ─────────────────────────────────────────────────────
let running   = false;
let abortCtrl = null;
let liveTarget = 0, liveVal = 0, rafId = null;
let phase = 'idle';

// ── Smooth animation loop ─────────────────────────────────────
function startLoop() {
  if (rafId) return;
  let last = performance.now();
  function tick(now) {
    const dt   = Math.min((now - last) / (1000 / 60), 4);
    last = now;
    const diff = liveTarget - liveVal;
    liveVal   += diff * (1 - Math.pow(1 - (diff > 0 ? 0.10 : 0.04), dt));
    if (Math.abs(diff) < 0.001) liveVal = liveTarget;

    const bn = document.getElementById('big-num');
    if (phase === 'download' || phase === 'upload') {
      bn.textContent = fmtMbps(liveVal);
      arcProg(Math.min(1, liveVal / 1000), cssVar(phase === 'download' ? '--dl' : '--ul'));
    } else if (phase === 'latency') {
      bn.textContent = liveVal < 0.5 ? '—' : liveVal.toFixed(0);
      arcProg(Math.min(1, liveVal / 200), cssVar('--accent'));
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}
function stopLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ── Format helpers ────────────────────────────────────────────
function fmtMbps(v) {
  if (v == null || isNaN(v)) return '—';
  if (v >= 100) return v.toFixed(0);
  if (v >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}
function fmtMs(v) { return (v == null || isNaN(v)) ? '—' : v.toFixed(1); }

// ── UI helpers ────────────────────────────────────────────────
function flash(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className   = 'sv' + (cls ? ' ' + cls : '');
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}
function setPhase(p, label) {
  phase = p;
  const cls = p === 'download' ? 'dl' : p === 'upload' ? 'ul' : p === 'latency' ? 'ping' : '';
  document.getElementById('phase-lbl').className   = 'phase-lbl ' + cls;
  document.getElementById('phase-lbl').textContent = label || p.toUpperCase();
  document.getElementById('big-num').className     = 'big-num '  + cls;
  document.getElementById('unit-lbl').className    = 'unit-lbl ' + cls;
  document.getElementById('unit-lbl').textContent  = p === 'latency' ? 'MS' : 'MBPS';
}
function setProg(pct, label, cls) {
  const fill = document.getElementById('prog-fill');
  fill.style.width  = pct + '%';
  fill.className    = 'prog-fill ' + (cls || '');
  document.getElementById('prog-pct').textContent = Math.round(pct) + '%';
  if (label) document.getElementById('prog-lbl').textContent = label;
}
function setBadge(state) {
  document.getElementById('status-badge').className = 'status-badge ' + state;
  document.getElementById('sbdot').className        = 'sbdot ' + (state === 'running' ? 'pulse' : '');
  document.getElementById('status-lbl').textContent =
    state === 'running' ? 'TESTING' : state === 'done' ? 'COMPLETE' : 'READY';
}
function setBtn(label, isRunning) {
  const btn = document.getElementById('run-btn');
  btn.classList.toggle('running', isRunning);
  btn.innerHTML = `<span class="rdot ${isRunning ? 'on' : ''}" id="rdot"></span>${label}`;
}
function resetStats() {
  ['sv-dl','sv-ul','sv-ping','sv-jitter'].forEach(id => {
    document.getElementById(id).textContent = '—';
    document.getElementById(id).className = 'sv';
  });
  document.getElementById('srv-loc').textContent = '—';
  document.getElementById('big-num').textContent = '—';
  document.getElementById('err-msg').textContent = '';
}

// ── Main test ─────────────────────────────────────────────────
function toggleTest() {
  if (running) abortTest(); else startTest();
}

function abortTest() {
  abortCtrl && abortCtrl.abort();
  running = false;
  stopLoop();
  setPhase('idle', 'ABORTED');
  arcProg(0);
  setProg(0, 'IDLE');
  setBadge('idle');
  setBtn('RUN TEST', false);
}

async function startTest() {
  running   = true;
  abortCtrl = new AbortController();
  liveTarget = 0; liveVal = 0;

  resetStats();
  setPhase('latency', 'MEASURING PING');
  setProg(0, 'PING');
  buildArc();
  setBadge('running');
  setBtn('STOP TEST', true);
  startLoop();

  // Kick off server meta in parallel
  NexusEngine.fetchServerMeta().then(({ colo }) => {
    document.getElementById('srv-loc').textContent = colo;
  });

  try {
    // ── PHASE 1: Latency ──────────────────────────────────
    const latency = await NexusEngine.measureLatency((done, total, last) => {
      liveTarget = last;
      flash('sv-ping', fmtMs(last));
      setProg((done / total) * 100, 'PING');
    });
    flash('sv-ping',   fmtMs(latency.avg));
    flash('sv-jitter', fmtMs(latency.jitter));

    if (abortCtrl.signal.aborted) return cleanup();

    // ── PHASE 2: Download ─────────────────────────────────
    setPhase('download', 'DOWNLOAD');
    setProg(0, 'DOWNLOAD', 'dl');
    liveTarget = 0; liveVal = 0;

    const dlSamples = [];
    await NexusEngine.measureDownload(
      (bps) => {
        dlSamples.push(bps);
        liveTarget = bps / 1e6;
        flash('sv-dl', fmtMbps(NexusEngine.trimmedMean(dlSamples) / 1e6), 'dl');
      },
      (done, total) => setProg((done / total) * 100, 'DOWNLOAD', 'dl'),
      abortCtrl.signal
    );

    if (abortCtrl.signal.aborted) return cleanup();
    const dlFinal = NexusEngine.trimmedMean(dlSamples) / 1e6;
    flash('sv-dl', fmtMbps(dlFinal), 'dl');
    liveTarget = dlFinal;

    // ── PHASE 3: Upload ───────────────────────────────────
    setPhase('upload', 'UPLOAD');
    setProg(0, 'UPLOAD', 'ul');
    liveTarget = 0; liveVal = 0;

    const ulSamples = [];
    await NexusEngine.measureUpload(
      (bps) => {
        ulSamples.push(bps);
        liveTarget = bps / 1e6;
        flash('sv-ul', fmtMbps(NexusEngine.trimmedMean(ulSamples) / 1e6), 'ul');
      },
      (done, total) => setProg((done / total) * 100, 'UPLOAD', 'ul'),
      abortCtrl.signal
    );

    if (abortCtrl.signal.aborted) return cleanup();
    const ulFinal = NexusEngine.trimmedMean(ulSamples) / 1e6;
    flash('sv-ul', fmtMbps(ulFinal), 'ul');

    // ── DONE ──────────────────────────────────────────────
    stopLoop();
    running = false;
    setPhase('download', 'DOWNLOAD');
    document.getElementById('big-num').textContent = fmtMbps(dlFinal);
    arcProg(Math.min(1, dlFinal / 1000), cssVar('--dl'));
    setProg(100, 'DONE');
    setBadge('done');
    setBtn('RUN AGAIN', false);

    // Final flash
    flash('sv-dl',     fmtMbps(dlFinal), 'dl');
    flash('sv-ul',     fmtMbps(ulFinal), 'ul');
    flash('sv-ping',   fmtMs(latency.avg));
    flash('sv-jitter', fmtMs(latency.jitter));

  } catch (e) {
    if (e.name === 'AbortError') return;
    document.getElementById('err-msg').textContent = 'TEST FAILED — CHECK CONNECTION';
    cleanup();
  }
}

function cleanup() {
  stopLoop();
  running = false;
  setBadge('idle');
  setBtn('RUN TEST', false);
}

// ── Theme ─────────────────────────────────────────────────────
function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  try { localStorage.setItem('nexus-theme', isLight ? 'light' : 'dark'); } catch(e) {}
  buildArc();
}

// ── Init ──────────────────────────────────────────────────────
(function init() {
  try {
    if (localStorage.getItem('nexus-theme') === 'light')
      document.documentElement.classList.add('light');
  } catch(e) {}
  buildArc();
  arcProg(0);
})();
