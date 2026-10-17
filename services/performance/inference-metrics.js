'use strict';

/* services/performance/inference-metrics.js - pure rate math for one physical
 * provider attempt (row 59 checkpoint 6). Fed the coalesced `inference.performance`
 * observations of that attempt, it keeps at most 16 of them and projects the
 * snapshot shape `{observation, live_decode, live_prefill, cache_fraction}`.
 *
 *   rate  = delta tokens / delta provider ms * 1000 between the latest measured
 *           observation and the earliest retained one inside the last 2,000 ms of
 *           provider time; a span under 1,000 ms is `warming`. A missing boundary
 *           is never interpolated.
 *   stale = no new measurement for 2,500 ms on the RECEIVE clock; the metric keeps
 *           its original sampled_at and is never shown as live again.
 *
 * Terminal averages stay inside `observation`; they are never relabelled as live
 * rates. No I/O, no timers: the caller passes the clock.
 */

const { TERMINAL_PHASES, normalizeObservation } = require('./performance-contract');

const MAX_RETAINED = 16;
const WINDOW_MS = 2000;
const MIN_SPAN_MS = 1000;
const STALE_AFTER_MS = 2500;

const DECODE_GROUP = Object.freeze(['generated_tokens', 'decode_interval_tokens', 'decode_elapsed_ms']);
const PREFILL_GROUP = Object.freeze(['processed_prompt_tokens', 'prefill_elapsed_ms']);

const metric = (value, state, sampledAt = null) => ({ value, state, sampled_at: sampledAt });
const known = (value) => value !== null && value !== undefined;

function createAttemptMetrics({ now = Date.now, live = true } = {}) {
  let attemptId = null;
  let lastSequence = -1;
  let terminal = false;
  let latest = null;
  const retained = []; // { decode: {tokens, ms} | null, prefill: {fresh, ms} | null }
  const poisoned = { decode: false, prefill: false };
  const cumulative = new Map();
  let decodeRate = null; // { value, state, sampled_at, recv }
  let prefillRate = null;
  let promptKnown = null; // { prompt, cached, sampled_at } carried across observations

  // `points` are the retained {tokens, ms} readings in order, `current` the latest of them.
  function rateOver(points, current) {
    const earliest = points.find((point) => point.ms >= current.ms - WINDOW_MS) || current;
    const span = current.ms - earliest.ms;
    if (!(span >= MIN_SPAN_MS)) return { value: null, state: 'warming' };
    return { value: ((current.tokens - earliest.tokens) / span) * 1000, state: 'available' };
  }

  // A cumulative field that goes backwards poisons its metric group for the attempt.
  function checkMonotonic(observation, group, name) {
    if (poisoned[name]) return;
    for (const field of group) {
      const value = observation[field];
      if (!known(value)) continue;
      if (cumulative.has(field) && value < cumulative.get(field)) { poisoned[name] = true; break; }
      cumulative.set(field, value);
    }
  }

  function observe(payload, receivedAtMs = now()) {
    let observation;
    try { observation = normalizeObservation(payload); } catch (_error) { observation = null; }
    if (!observation || terminal || observation.sequence <= lastSequence) return false;
    if (attemptId !== null && observation.attempt_id !== attemptId) return false;
    const recv = Number.isFinite(receivedAtMs) ? receivedAtMs : now();
    attemptId = observation.attempt_id;
    lastSequence = observation.sequence;

    // Cached <= processed <= prompt whenever the compared values are known.
    const { cached_prompt_tokens: cached, processed_prompt_tokens: processed, prompt_tokens: prompt } = observation;
    if ((known(cached) && known(processed) && cached > processed)
      || (known(processed) && known(prompt) && processed > prompt)
      || (known(cached) && known(prompt) && cached > prompt)) {
      poisoned.prefill = true;
      observation.cached_prompt_tokens = null;
      observation.processed_prompt_tokens = null;
      observation.prompt_tokens = null;
    }
    checkMonotonic(observation, DECODE_GROUP, 'decode');
    checkMonotonic(observation, PREFILL_GROUP, 'prefill');
    if (poisoned.decode) for (const field of DECODE_GROUP) observation[field] = null;
    if (poisoned.prefill) for (const field of PREFILL_GROUP) observation[field] = null;

    const entry = { decode: null, prefill: null };
    if (!poisoned.decode && known(observation.decode_elapsed_ms) && known(observation.decode_interval_tokens)) {
      entry.decode = { tokens: observation.decode_interval_tokens, ms: observation.decode_elapsed_ms };
    }
    const prefillWindowKnown = known(observation.processed_prompt_tokens) && known(observation.cached_prompt_tokens)
      && known(observation.prefill_elapsed_ms);
    if (!poisoned.prefill && prefillWindowKnown) {
      entry.prefill = {
        tokens: observation.processed_prompt_tokens - observation.cached_prompt_tokens,
        ms: observation.prefill_elapsed_ms,
      };
    }
    const previousDecode = [...retained].reverse().find((item) => item.decode)?.decode || null;
    const previousPrefill = [...retained].reverse().find((item) => item.prefill)?.prefill || null;
    retained.push(entry);
    if (retained.length > MAX_RETAINED) retained.shift();

    // Only an observation that advances the provider clock is a new measurement.
    if (entry.decode && (!previousDecode || entry.decode.ms > previousDecode.ms)) {
      const computed = rateOver(retained.filter((item) => item.decode).map((item) => item.decode), entry.decode);
      decodeRate = { ...computed, sampled_at: observation.sampled_at, recv };
    }
    if (!poisoned.prefill && known(observation.prompt_tokens) && known(observation.cached_prompt_tokens)) {
      promptKnown = {
        prompt: observation.prompt_tokens, cached: observation.cached_prompt_tokens, sampled_at: observation.sampled_at,
      };
      // Zero fresh prompt work: nothing to rate, now or later.
      if (observation.prompt_tokens > 0 && observation.cached_prompt_tokens === observation.prompt_tokens) {
        prefillRate = { value: null, state: 'not_applicable', sampled_at: observation.sampled_at, recv };
      }
    }
    if (entry.prefill && prefillRate?.state !== 'not_applicable'
      && (!previousPrefill || entry.prefill.ms > previousPrefill.ms)) {
      const computed = rateOver(retained.filter((item) => item.prefill).map((item) => item.prefill), entry.prefill);
      prefillRate = { ...computed, sampled_at: observation.sampled_at, recv };
    }

    latest = observation;
    if (TERMINAL_PHASES.includes(observation.phase)) terminal = true;
    return true;
  }

  function projectRate(rate, group, nowMs) {
    if (poisoned[group]) return metric(null, 'unavailable');
    if (!rate) {
      const liveCapable = live && latest?.provider_kind === 'ninfer' && latest?.source === 'provider';
      return liveCapable && !terminal ? metric(null, 'warming') : metric(null, 'unavailable');
    }
    if (rate.state === 'not_applicable') return metric(null, 'not_applicable', rate.sampled_at);
    if (terminal) {
      return rate.state === 'available' ? metric(rate.value, 'stale', rate.sampled_at) : metric(null, 'unavailable');
    }
    if (nowMs - rate.recv >= STALE_AFTER_MS) {
      return metric(rate.state === 'available' ? rate.value : null, 'stale', rate.sampled_at);
    }
    return metric(rate.value, rate.state, rate.sampled_at);
  }

  function projectCacheFraction() {
    if (!promptKnown) return metric(null, 'unavailable');
    if (promptKnown.prompt === 0) return metric(null, 'not_applicable', promptKnown.sampled_at);
    return metric(Math.min(promptKnown.cached / promptKnown.prompt, 1), 'available', promptKnown.sampled_at);
  }

  function project(nowMs = now()) {
    return {
      observation: latest ? { ...latest } : null,
      live_decode: projectRate(decodeRate, 'decode', nowMs),
      live_prefill: projectRate(prefillRate, 'prefill', nowMs),
      cache_fraction: projectCacheFraction(),
    };
  }

  return { observe, project };
}

module.exports = { MAX_RETAINED, MIN_SPAN_MS, STALE_AFTER_MS, WINDOW_MS, createAttemptMetrics };
