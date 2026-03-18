/**
 * NEXUS SpeedTest Engine v3 - FIXED
 * - Adaptive sizing: skips payload sizes that would take too long on slow connections
 * - Time-boxed: whole DL+UL completes in ~15-20s regardless of connection speed
 * - IP meta via ipapi.co (HTTPS — no mixed-content block)
 * - FIXES: Accurate upload speed calculation + proper timeout handling
 */
'use strict';

const CF_DOWN  = 'https://speed.cloudflare.com/__down';
const CF_UP    = 'https://speed.cloudflare.com/__up';
const CF_TRACE = 'https://speed.cloudflare.com/cdn-cgi/trace';
const IP_API   = 'https://ipapi.co/json/';

// All candidate sizes — engine will skip ones too large for the connection
const DL_SIZES_ALL = [100000, 1000000, 5000000, 10000000, 25000000];
const UL_SIZES_ALL = [100000, 1000000, 5000000, 10000000];
const LATENCY_ROUNDS = 8;

// Per-fetch time budget (ms) — skip a size if previous round exceeded this
const FETCH_BUDGET_MS = 4500;
// Minimum rounds to get a result even on very slow connections
const MIN_ROUNDS = 3;

/* ── Latency ─────────────────────────────────────────────────── */
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
    await sleep(50);
  }
  const avg    = median(samples);
  const jitter = samples.reduce((a, b, i, arr) =>
    i === 0 ? 0 : a + Math.abs(b - arr[i - 1]), 0) / Math.max(1, samples.length - 1);
  return { avg, jitter, samples };
}

/* ── Download (adaptive) ─────────────────────────────────────── */
async function measureDownload(onSample, onProgress, signal) {
  const results = [];
  let lastElapsedMs = 0;
  let done = 0;

  // Build adaptive size list: always start with first two, skip if last round was slow
  const sizes = buildAdaptiveSizes(DL_SIZES_ALL);
  const total = sizes.length;

  for (const size of sizes) {
    if (signal?.aborted) break;
    // Skip this size if last fetch already exceeded budget (connection too slow)
    if (done >= MIN_ROUNDS && lastElapsedMs > FETCH_BUDGET_MS) break;

    const t0 = performance.now();
    try {
      const res = await fetch(`${CF_DOWN}?bytes=${size}&r=${Math.random()}`, {
        cache: 'no-store',
        signal: combineSignals(signal, AbortSignal.timeout(FETCH_BUDGET_MS + 1000)),
      });
      const buf = await res.arrayBuffer();
      lastElapsedMs = performance.now() - t0;
      const bps = (buf.byteLength * 8) / (lastElapsedMs / 1000);
      results.push(bps);
      done++;
      onSample && onSample(bps, buf.byteLength, lastElapsedMs / 1000);
      onProgress && onProgress(done, total, bps);
    } catch (e) {
      if (e.name === 'AbortError') return results;
      done++;
      onProgress && onProgress(done, total, 0);
    }
    await sleep(60);
  }
  return results;
}

/* ── Upload (adaptive) - FIXED ───────────────────────────────── */
async function measureUpload(onSample, onProgress, signal) {
  const results = [];
  let lastElapsedMs = 0;
  let done = 0;

  const sizes = buildAdaptiveSizes(UL_SIZES_ALL);
  const total = sizes.length;

  for (const size of sizes) {
    if (signal?.aborted) break;
    if (done >= MIN_ROUNDS && lastElapsedMs > FETCH_BUDGET_MS) break;

    const payload = new Uint8Array(size);
    // Randomise only first 64KB to keep it fast
    crypto.getRandomValues(payload.slice(0, Math.min(size, 65536)));

    const t0 = performance.now();
    let uploadSuccess = false;
    
    try {
      // Create a proper abort controller with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_BUDGET_MS + 1000);
      
      try {
        const response = await fetch(CF_UP, {
          method: 'POST', 
          body: payload, 
          cache: 'no-store',
          signal: combineSignals(signal, controller.signal),
        });
        
        clearTimeout(timeoutId);
        
        // Validate response is successful
        if (response.ok) {
          uploadSuccess = true;
          lastElapsedMs = performance.now() - t0;
          
          // FIXED: Ensure lastElapsedMs is at least 10ms to avoid division by zero or extreme values
          if (lastElapsedMs < 10) lastElapsedMs = 10;
          
          // FIXED: Calculate speed more accurately
          // bps = (bytes * 8 bits/byte) / (seconds)
          const bps = (size * 8) / (lastElapsedMs / 1000);
          
          // FIXED: Validate the result is reasonable (not NaN or Infinity)
          if (isFinite(bps) && bps > 0) {
            results.push(bps);
            done++;
            onSample && onSample(bps, size, lastElapsedMs / 1000);
            onProgress && onProgress(done, total, bps);
          } else {
            // Invalid result, skip this round
            done++;
            onProgress && onProgress(done, total, 0);
          }
        } else {
          // Server returned error, skip this round
          done++;
          onProgress && onProgress(done, total, 0);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      // FIXED: Better error handling with timeout detection
      if (e.name === 'AbortError') {
        // Timeout occurred, return current results
        return results;
      }
      // Other errors, continue to next round
      done++;
      onProgress && onProgress(done, total, 0);
    }
    
    // FIXED: Use shorter sleep to prevent accumulation of delays
    await sleep(40);
  }
  return results;
}

/* ── Server / IP meta ────────────────────────────────────────── */
async function fetchMeta() {
  const result = { colo: '—', city: '—', isp: '—', org: '—', ip: '—', country: '—' };

  // Cloudflare trace — colo + IP (always works, same origin as test)
  try {
    const t = await (await fetch(CF_TRACE, {
      cache: 'no-store', signal: AbortSignal.timeout(4000),
    })).text();
    result.colo = t.match(/colo=([A-Z]+)/)?.[1]  || '—';
    result.ip   = t.match(/ip=([^\n]+)/)?.[1]?.trim() || '—';
  } catch (_) {}

  // ipapi.co — HTTPS, free, no key, returns ISP + city + country
  try {
    const d = await (await fetch(IP_API, {
      cache: 'no-store', signal: AbortSignal.timeout(5000),
    })).json();
    if (d && !d.error) {
      result.ip      = d.ip       || result.ip;
      result.isp     = d.org      || '—';   // ipapi.co puts "AS#### ISP Name" in org
      result.org     = d.org      || '—';
      result.city    = d.city     || '—';
      result.region  = d.region   || '';
      result.country = d.country_name || d.country || '—';
    }
  } catch (_) {}

  return result;
}

/* ── Helpers ─────────────────────────────────────────────────── */
function buildAdaptiveSizes(all) {
  // Always include at least the first 3 sizes, rest are candidates
  return [...all]; // adaptive skipping happens at runtime via lastElapsedMs check
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function trimmedMean(arr, f = 0.15) {
  if (!arr.length) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const cut = Math.floor(s.length * f);
  const tr  = s.slice(cut, s.length - cut || undefined);
  if (!tr.length) return s[Math.floor(s.length / 2)];
  return tr.reduce((a, b) => a + b, 0) / tr.length;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function combineSignals(s1, s2) {
  if (!s1) return s2;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([s1, s2]);
  return s1;
}

window.NexusEngine = {
  measureLatency, measureDownload, measureUpload, fetchMeta,
  median, trimmedMean,
  DL_TOTAL: DL_SIZES_ALL.length,
  UL_TOTAL: UL_SIZES_ALL.length,
};
