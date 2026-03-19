/**
 * NEXUS SpeedTest Engine v4
 * - Uses staged fetch timing for download/upload
 * - Upload uses text/plain POST requests so it avoids XHR upload preflight issues
 * - Uses Resource Timing when available, with performance.now() fallback
 */
'use strict';

const CF_DOWN = 'https://speed.cloudflare.com/__down';
const CF_UP = 'https://speed.cloudflare.com/__up';
const CF_TRACE = 'https://speed.cloudflare.com/cdn-cgi/trace';

function stripAS(value) {
  return (value || '').replace(/^AS\d+\s*/i, '').trim() || '-';
}

const GEO = [
  {
    url: 'https://ip-api.com/json/?fields=status,country,regionName,city,isp,org,as,query',
    parse(data) {
      if (!data || data.status !== 'success') return null;
      return {
        ip: data.query || '-',
        isp: stripAS(data.isp),
        org: stripAS(data.org || data.isp),
        city: data.city || '-',
        country: data.country || '-',
      };
    },
  },
  {
    url: 'https://ipinfo.io/json',
    parse(data) {
      if (!data || !data.ip) return null;
      return {
        ip: data.ip || '-',
        isp: stripAS(data.org),
        org: stripAS(data.org),
        city: data.city || '-',
        country: data.country || '-',
      };
    },
  },
  {
    url: 'https://ipwho.is/',
    parse(data) {
      if (!data || !data.success) return null;
      return {
        ip: data.ip || '-',
        isp: stripAS(data.connection && data.connection.isp),
        org: stripAS((data.connection && (data.connection.org || data.connection.isp)) || ''),
        city: data.city || '-',
        country: data.country || '-',
      };
    },
  },
  {
    url: 'https://freeipapi.com/api/json',
    parse(data) {
      if (!data || !data.ipVersion) return null;
      return {
        ip: data.ipAddress || '-',
        isp: stripAS(data.ispName),
        org: stripAS(data.ispName),
        city: data.cityName || '-',
        country: data.countryName || '-',
      };
    },
  },
];

const DL_STEPS = [
  { bytes: 100000, count: 2, bypassMinDuration: true },
  { bytes: 500000, count: 2, bypassMinDuration: true },
  { bytes: 1000000, count: 2 },
  { bytes: 5000000, count: 2 },
  { bytes: 10000000, count: 2 },
  { bytes: 25000000, count: 1 },
];

const UL_STEPS = [
  { bytes: 50000, count: 2, bypassMinDuration: true },
  { bytes: 250000, count: 2, bypassMinDuration: true },
  { bytes: 1000000, count: 2 },
  { bytes: 4000000, count: 2 },
  { bytes: 8000000, count: 2 },
  { bytes: 16000000, count: 1 },
];

const LATENCY_ROUNDS = 10;
const BANDWIDTH_FINISH_MS = 900;
const BANDWIDTH_MIN_SAMPLE_MS = 120;
const REQUEST_TIMEOUT_MS = 12000;
const BETWEEN_REQUESTS_MS = 90;
const SERVER_TIME_FALLBACK_MS = 10;
const PAYLOAD_CHUNK = 'NEXUSUPLOAD0123456789abcdef'.repeat(256);

const uploadPayloadCache = new Map();

function totalRequests(steps) {
  return steps.reduce((sum, step) => sum + step.count, 0);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trimmedMean(values, trimLow = 0.15, trimHigh = trimLow) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const cutLow = Math.floor(sorted.length * trimLow);
  const cutHigh = Math.floor(sorted.length * trimHigh);
  const trimmed = sorted.slice(cutLow, sorted.length - cutHigh || undefined);
  const pool = trimmed.length ? trimmed : sorted;
  return pool.reduce((sum, value) => sum + value, 0) / pool.length;
}

function reduceBandwidthPoints(points) {
  if (!points.length) return 0;
  if (typeof points[0] === 'number') return trimmedMean(points, 0.18, 0.05);

  const usable = points.filter(point => point.durationMs >= BANDWIDTH_MIN_SAMPLE_MS);
  const pool = (usable.length ? usable : points).slice().sort((a, b) => a.bps - b.bps);
  const cutLow = pool.length >= 5 ? Math.floor(pool.length * 0.18) : 0;
  const cutHigh = pool.length >= 8 ? Math.floor(pool.length * 0.05) : 0;
  const trimmed = pool.slice(cutLow, pool.length - cutHigh || undefined);
  const finalPool = trimmed.length ? trimmed : pool;
  const totalWeight = finalPool.reduce((sum, point) => sum + Math.max(point.durationMs, 1), 0);
  if (!totalWeight) return 0;
  return finalPool.reduce((sum, point) => sum + point.bps * Math.max(point.durationMs, 1), 0) / totalWeight;
}

function cleanLatencySamples(samples) {
  if (samples.length < 4) return samples.slice();
  const center = median(samples);
  const deviations = samples.map(sample => Math.abs(sample - center));
  const mad = median(deviations);
  if (!mad) return samples.slice();
  const limit = Math.max(12, mad * 3.5);
  const filtered = samples.filter(sample => Math.abs(sample - center) <= limit);
  return filtered.length >= Math.max(3, Math.ceil(samples.length * 0.6)) ? filtered : samples.slice();
}

function jitterFromSamples(samples) {
  if (samples.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) {
    total += Math.abs(samples[index] - samples[index - 1]);
  }
  return total / (samples.length - 1);
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal && signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function timeoutSig(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function combineSignals(s1, s2) {
  if (!s1) return s2;
  if (!s2) return s1;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([s1, s2]);
  }

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  s1.addEventListener('abort', abort, { once: true });
  s2.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function prepareTimings() {
  if (typeof performance === 'undefined') return;
  performance.setResourceTimingBufferSize && performance.setResourceTimingBufferSize(400);
}

function latestEntry(name) {
  if (typeof performance === 'undefined' || !performance.getEntriesByName) return null;
  const entries = performance.getEntriesByName(name);
  return entries[entries.length - 1] || null;
}

function getServerTimingMs(entry) {
  const metric = entry && entry.serverTiming
    ? entry.serverTiming.find(item => Number.isFinite(item.duration) && item.duration >= 0)
    : null;
  return metric ? metric.duration : SERVER_TIME_FALLBACK_MS;
}

function measuredTransferMs(entry, startedAt, endedAt) {
  const raw = entry && entry.responseEnd > 0 && entry.requestStart > 0
    ? entry.responseEnd - entry.requestStart
    : endedAt - startedAt;
  return Math.max(raw - Math.min(getServerTimingMs(entry), Math.max(raw - 1, 0)), 1);
}

function measuredPingMs(entry, startedAt, endedAt) {
  const raw = entry && entry.responseStart > 0 && entry.requestStart > 0
    ? entry.responseStart - entry.requestStart
    : endedAt - startedAt;
  return Math.max(raw - Math.min(getServerTimingMs(entry), Math.max(raw - 0.1, 0)), 0.1);
}

function getUploadPayload(bytes) {
  if (uploadPayloadCache.has(bytes)) return uploadPayloadCache.get(bytes);
  const repeats = Math.ceil(bytes / PAYLOAD_CHUNK.length);
  const payload = PAYLOAD_CHUNK.repeat(repeats).slice(0, bytes);
  uploadPayloadCache.set(bytes, payload);
  return payload;
}

async function runTransfer(direction, bytes, signal) {
  prepareTimings();
  if (typeof performance !== 'undefined' && performance.clearResourceTimings) {
    performance.clearResourceTimings();
  }

  const isUpload = direction === 'upload';
  const url = isUpload
    ? `${CF_UP}?r=${Math.random().toString(36).slice(2)}`
    : `${CF_DOWN}?bytes=${bytes}&r=${Math.random().toString(36).slice(2)}`;
  const startedAt = performance.now();

  let transferredBytes = bytes;
  if (isUpload) {
    const payload = getUploadPayload(bytes);
    const response = await fetch(url, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      cache: 'no-store',
      signal: combineSignals(signal, timeoutSig(REQUEST_TIMEOUT_MS)),
    });
    if (!response.ok) throw new Error(`upload-${response.status}`);
    await response.text();
    transferredBytes = payload.length;
  } else {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: combineSignals(signal, timeoutSig(REQUEST_TIMEOUT_MS)),
    });
    if (!response.ok) throw new Error(`download-${response.status}`);
    const buffer = await response.arrayBuffer();
    transferredBytes = buffer.byteLength;
  }

  const endedAt = performance.now();
  const entry = latestEntry(url);
  const durationMs = measuredTransferMs(entry, startedAt, endedAt);
  return {
    bytes: transferredBytes,
    durationMs,
    pingMs: measuredPingMs(entry, startedAt, endedAt),
    bps: (transferredBytes * 8) / (durationMs / 1000),
  };
}

async function measureDirection(direction, steps, onSample, onProgress, signal) {
  const points = [];
  let done = 0;
  const total = totalRequests(steps);

  for (const step of steps) {
    const stagePoints = [];

    for (let index = 0; index < step.count; index += 1) {
      if (signal && signal.aborted) return points;

      try {
        const point = await runTransfer(direction, step.bytes, signal);
        if (Number.isFinite(point.bps) && point.bps > 0) {
          points.push(point);
          stagePoints.push(point);
          onSample && onSample(reduceBandwidthPoints(points), points.slice(), point);
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return points;
        if (points.length) {
          done += 1;
          onProgress && onProgress(done, total, reduceBandwidthPoints(points));
          break;
        }
      }

      done += 1;
      onProgress && onProgress(done, total, reduceBandwidthPoints(points));
      await sleep(BETWEEN_REQUESTS_MS, signal);
    }

    const stageDurations = stagePoints.map(point => point.durationMs);
    if (stageDurations.length && !step.bypassMinDuration && points.length >= 3) {
      if (median(stageDurations) >= BANDWIDTH_FINISH_MS) break;
    }
    if (!stagePoints.length && points.length) break;
  }

  return points;
}

async function measureLatency(onProgress, signal) {
  prepareTimings();
  const samples = [];

  for (let index = 0; index < LATENCY_ROUNDS; index += 1) {
    if (signal && signal.aborted) break;
    if (typeof performance !== 'undefined' && performance.clearResourceTimings) {
      performance.clearResourceTimings();
    }

    const url = `${CF_DOWN}?bytes=0&r=${Math.random().toString(36).slice(2)}`;
    const startedAt = performance.now();

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: combineSignals(signal, timeoutSig(5000)),
      });
      await response.arrayBuffer();
    } catch (error) {
      if (error && error.name === 'AbortError') break;
    }

    const endedAt = performance.now();
    const pingMs = measuredPingMs(latestEntry(url), startedAt, endedAt);
    if (Number.isFinite(pingMs) && pingMs > 0) samples.push(pingMs);
    onProgress && onProgress(index + 1, LATENCY_ROUNDS, pingMs);
    await sleep(110, signal);
  }

  const cleaned = cleanLatencySamples(samples);
  return {
    avg: median(cleaned),
    jitter: jitterFromSamples(cleaned),
    samples: cleaned,
  };
}

async function measureDownloadDetailed(onSample, onProgress, signal) {
  return measureDirection('download', DL_STEPS, onSample, onProgress, signal);
}

async function measureUploadDetailed(onSample, onProgress, signal) {
  return measureDirection('upload', UL_STEPS, onSample, onProgress, signal);
}

async function measureDownload(onSample, onProgress, signal) {
  const points = await measureDownloadDetailed(onSample, onProgress, signal);
  return points.map(point => point.bps);
}

async function measureUpload(onSample, onProgress, signal) {
  const points = await measureUploadDetailed(onSample, onProgress, signal);
  return points.map(point => point.bps);
}

async function fetchMeta() {
  const result = { colo: '-', ip: '-', isp: '-', org: '-', city: '-', country: '-' };

  try {
    const trace = await (await fetch(CF_TRACE, {
      cache: 'no-store',
      signal: timeoutSig(4000),
    })).text();
    result.colo = (trace.match(/colo=([A-Z]+)/) || [])[1] || '-';
    result.ip = ((trace.match(/ip=([^\n]+)/) || [])[1] || '').trim() || '-';
  } catch (_) {}

  for (const source of GEO) {
    try {
      const data = await (await fetch(source.url, {
        cache: 'no-store',
        signal: timeoutSig(5000),
      })).json();
      const meta = source.parse(data);
      if (meta) return Object.assign(result, meta);
    } catch (_) {}
  }

  return result;
}

window.NexusEngine = {
  measureLatency,
  measureDownload,
  measureUpload,
  measureDownloadDetailed,
  measureUploadDetailed,
  fetchMeta,
  median,
  trimmedMean,
  reduceBandwidthPoints,
  DL_TOTAL: totalRequests(DL_STEPS),
  UL_TOTAL: totalRequests(UL_STEPS),
};
