/**
 * NEXUS SpeedTest Engine v2
 * Pure fetch() — no SDK, no build step.
 * Endpoints: speed.cloudflare.com (download/upload/trace) + ip-api.com (ISP/geo)
 */
'use strict';

const CF_DOWN = 'https://speed.cloudflare.com/__down';
const CF_UP   = 'https://speed.cloudflare.com/__up';
const CF_TRACE= 'https://speed.cloudflare.com/cdn-cgi/trace';
const IP_API  = 'http://ip-api.com/json/?fields=status,query,isp,org,city,regionName,country,countryCode,as';

const DL_SIZES       = [100000, 1000000, 10000000, 25000000, 100000000];
const UL_SIZES       = [100000, 1000000, 10000000, 25000000];
const ROUNDS_PER_SIZE = 2;
const LATENCY_ROUNDS  = 8;

/* ── Latency ──────────────────────────────────────────────── */
async function measureLatency(onProgress) {
  const samples = [];
  for (let i = 0; i < LATENCY_ROUNDS; i++) {
    const t0 = performance.now();
    try {
      await fetch(`${CF_DOWN}?bytes=0&r=${Math.random()}`, {
        cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
    } catch (_) {}
    samples.push(performance.now() - t0);
    onProgress && onProgress(i + 1, LATENCY_ROUNDS, samples[samples.length - 1]);
    await sleep(60);
  }
  const avg    = median(samples);
  const jitter = samples.reduce((a, b, i, arr) =>
    i === 0 ? 0 : a + Math.abs(b - arr[i - 1]), 0) / Math.max(1, samples.length - 1);
  return { avg, jitter, samples };
}

/* ── Download ─────────────────────────────────────────────── */
async function measureDownload(onSample, onProgress, signal) {
  const results = [];
  let done = 0;
  const total = DL_SIZES.length * ROUNDS_PER_SIZE;
  for (const size of DL_SIZES) {
    if (signal?.aborted) break;
    for (let r = 0; r < ROUNDS_PER_SIZE; r++) {
      if (signal?.aborted) break;
      const t0 = performance.now();
      try {
        const res = await fetch(`${CF_DOWN}?bytes=${size}&r=${Math.random()}`, {
          cache: 'no-store',
          signal: combineSignals(signal, AbortSignal.timeout(30000)),
        });
        const buf = await res.arrayBuffer();
        const elapsed = (performance.now() - t0) / 1000;
        const bps = (buf.byteLength * 8) / elapsed;
        results.push(bps);
        done++;
        onSample && onSample(bps, buf.byteLength, elapsed);
        onProgress && onProgress(done, total, bps);
      } catch (e) {
        if (e.name === 'AbortError') return results;
        done++;
        onProgress && onProgress(done, total, 0);
      }
      await sleep(80);
    }
  }
  return results;
}

/* ── Upload ───────────────────────────────────────────────── */
async function measureUpload(onSample, onProgress, signal) {
  const results = [];
  let done = 0;
  const total = UL_SIZES.length * ROUNDS_PER_SIZE;
  for (const size of UL_SIZES) {
    if (signal?.aborted) break;
    const payload = new Uint8Array(size);
    crypto.getRandomValues(payload.slice(0, Math.min(size, 65536)));
    for (let r = 0; r < ROUNDS_PER_SIZE; r++) {
      if (signal?.aborted) break;
      const t0 = performance.now();
      try {
        await fetch(CF_UP, {
          method: 'POST', body: payload, cache: 'no-store',
          signal: combineSignals(signal, AbortSignal.timeout(30000)),
        });
        const elapsed = (performance.now() - t0) / 1000;
        const bps = (size * 8) / elapsed;
        results.push(bps);
        done++;
        onSample && onSample(bps, size, elapsed);
        onProgress && onProgress(done, total, bps);
      } catch (e) {
        if (e.name === 'AbortError') return results;
        done++;
        onProgress && onProgress(done, total, 0);
      }
      await sleep(80);
    }
  }
  return results;
}

/* ── Server / IP meta ─────────────────────────────────────── */
async function fetchMeta() {
  const result = { colo: '—', city: '—', isp: '—', org: '—', ip: '—', country: '—', as: '—' };
  // Cloudflare trace for colo
  try {
    const t = await (await fetch(CF_TRACE, { cache: 'no-store', signal: AbortSignal.timeout(4000) })).text();
    result.colo = t.match(/colo=([A-Z]+)/)?.[1] || '—';
    result.cfIp  = t.match(/ip=([^\n]+)/)?.[1]?.trim() || null;
  } catch (_) {}
  // ip-api.com for ISP + city (HTTP only — no HTTPS on free tier)
  try {
    const d = await (await fetch(IP_API, { cache: 'no-store', signal: AbortSignal.timeout(5000) })).json();
    if (d.status === 'success') {
      result.ip      = d.query   || '—';
      result.isp     = d.isp     || '—';
      result.org     = d.org     || d.isp || '—';
      result.city    = d.city    || '—';
      result.region  = d.regionName || '';
      result.country = d.country || '—';
      result.as      = d.as      || '—';
    }
  } catch (_) {}
  return result;
}

/* ── Utils ────────────────────────────────────────────────── */
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function trimmedMean(arr, f = 0.1) {
  if (!arr.length) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const cut = Math.floor(s.length * f);
  const tr  = s.slice(cut, s.length - cut || undefined);
  return tr.reduce((a, b) => a + b, 0) / tr.length;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function combineSignals(s1, s2) {
  if (!s1) return s2;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([s1, s2]);
  return s1; // fallback
}

window.NexusEngine = { measureLatency, measureDownload, measureUpload, fetchMeta, median, trimmedMean };

// Export totals so app.js can reference them
window.NexusEngine.DL_TOTAL = DL_SIZES.length * ROUNDS_PER_SIZE;
window.NexusEngine.UL_TOTAL = UL_SIZES.length * ROUNDS_PER_SIZE;
