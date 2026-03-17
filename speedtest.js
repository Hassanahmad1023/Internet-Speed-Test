/**
 * NEXUS SpeedTest Engine
 * Pure fetch() implementation against Cloudflare's speed.cloudflare.com endpoints.
 * No third-party SDK — works in all environments including sandboxed iframes.
 *
 * Endpoints used (public, no auth):
 *   GET  https://speed.cloudflare.com/__down?bytes=N  — download test
 *   POST https://speed.cloudflare.com/__up            — upload test
 *   GET  https://speed.cloudflare.com/cdn-cgi/trace   — server location
 */

'use strict';

const CF_DOWN = 'https://speed.cloudflare.com/__down';
const CF_UP   = 'https://speed.cloudflare.com/__up';
const CF_META = 'https://speed.cloudflare.com/cdn-cgi/trace';

// Payload sizes for progressive download/upload rounds
const DL_SIZES = [100000, 1000000, 10000000, 25000000, 100000000];
const UL_SIZES = [100000, 1000000, 10000000, 25000000];
const ROUNDS_PER_SIZE = 2;
const LATENCY_ROUNDS  = 8;

/**
 * Measure round-trip latency using lightweight HEAD-like GETs.
 * Returns { avg, jitter, samples } in milliseconds.
 */
async function measureLatency(onProgress) {
  const samples = [];
  for (let i = 0; i < LATENCY_ROUNDS; i++) {
    const t0 = performance.now();
    try {
      await fetch(`${CF_DOWN}?bytes=0&r=${Math.random()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
    } catch (_) { /* skip failed ping */ }
    samples.push(performance.now() - t0);
    onProgress && onProgress(i + 1, LATENCY_ROUNDS, samples[samples.length - 1]);
    await sleep(60);
  }
  const avg    = median(samples);
  const jitter = samples.reduce((a, b, i, arr) =>
    i === 0 ? 0 : a + Math.abs(b - arr[i - 1]), 0) / (samples.length - 1);
  return { avg, jitter, samples };
}

/**
 * Measure download speed progressively across sizes.
 * Calls onSample(bps, sizeBytes, elapsed) for each completed fetch.
 */
async function measureDownload(onSample, onProgress, abortSignal) {
  const results = []; // bps values
  let done = 0;
  const total = DL_SIZES.length * ROUNDS_PER_SIZE;

  for (const size of DL_SIZES) {
    if (abortSignal?.aborted) break;
    for (let r = 0; r < ROUNDS_PER_SIZE; r++) {
      if (abortSignal?.aborted) break;
      const t0 = performance.now();
      try {
        const res = await fetch(`${CF_DOWN}?bytes=${size}&r=${Math.random()}`, {
          cache: 'no-store',
          signal: AbortSignal.any
            ? AbortSignal.any([abortSignal, AbortSignal.timeout(30000)])
            : abortSignal ?? AbortSignal.timeout(30000),
        });
        // Drain the body to measure real throughput
        const buf = await res.arrayBuffer();
        const elapsed = (performance.now() - t0) / 1000; // seconds
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

/**
 * Measure upload speed.
 */
async function measureUpload(onSample, onProgress, abortSignal) {
  const results = [];
  let done = 0;
  const total = UL_SIZES.length * ROUNDS_PER_SIZE;

  for (const size of UL_SIZES) {
    if (abortSignal?.aborted) break;
    const payload = new Uint8Array(size);
    crypto.getRandomValues(payload.slice(0, Math.min(size, 65536))); // randomise start

    for (let r = 0; r < ROUNDS_PER_SIZE; r++) {
      if (abortSignal?.aborted) break;
      const t0 = performance.now();
      try {
        await fetch(CF_UP, {
          method: 'POST',
          body: payload,
          cache: 'no-store',
          signal: AbortSignal.any
            ? AbortSignal.any([abortSignal, AbortSignal.timeout(30000)])
            : abortSignal ?? AbortSignal.timeout(30000),
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

/**
 * Fetch server location from Cloudflare trace.
 */
async function fetchServerMeta() {
  try {
    const res  = await fetch(CF_META, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    const colo = text.match(/colo=([A-Z]+)/)?.[1] || '—';
    const loc  = text.match(/loc=([A-Z]+)/)?.[1]  || '—';
    return { colo, loc };
  } catch (_) {
    return { colo: '—', loc: '—' };
  }
}

// ── Stat helpers ──────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function trimmedMean(arr, trimFrac = 0.1) {
  if (!arr.length) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const cut = Math.floor(s.length * trimFrac);
  const trimmed = s.slice(cut, s.length - cut || undefined);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Public API ────────────────────────────────────────────────

window.NexusEngine = {
  measureLatency,
  measureDownload,
  measureUpload,
  fetchServerMeta,
  median,
  trimmedMean,
};
