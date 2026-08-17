// A small client over the Anthropic Messages API, used by extraction (Stage 2)
// and by Q&A. Node's global fetch only — no SDK, no dependency.
//
// Every call is entered because a person triggered a run (Section 0, boundary 1).
// Nothing here schedules, queues or resumes work on its own; the retry loop below
// bounds a single in-flight request and then gives up with a reportable error.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Selectable models, default first. Exact ids — these carry no date suffix. */
export const MODELS = ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5'];
export const DEFAULT_MODEL = MODELS[0];

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_TIMEOUT_MS = 120000;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 20000;

// AbortSignal reason used for our own timeout, so a timeout can be told apart
// from the caller cancelling the run.
const TIMEOUT_REASON = Symbol('anthropic-timeout');

class RequestError extends Error {
  constructor(message, { retryable }) {
    super(message);
    this.name = 'RequestError';
    this.retryable = retryable;
  }
}

/**
 * The API key to use, or null when there isn't one.
 *
 * Returning null rather than throwing lets the caller decide: the pipeline's
 * fixture mode never needs a key, so a missing key is only an error at the point
 * a live call is actually attempted.
 *
 * @param {string} [explicit] Key supplied on the command line or in a config.
 * @returns {string|null}
 */
export function resolveApiKey(explicit) {
  for (const candidate of [explicit, process.env.ANTHROPIC_API_KEY]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * One Messages API call.
 *
 * Never throws: transport, HTTP and refusal failures all come back as
 * `{ ok: false, error }` so a batch run over nine companies can report the one
 * that failed and carry on with the rest.
 *
 * @param {object} options
 * @param {string} [options.apiKey]     Explicit key; falls back to ANTHROPIC_API_KEY.
 * @param {string} [options.model]      One of MODELS, default claude-sonnet-4-6.
 * @param {string} options.system       System prompt.
 * @param {string} options.user         Single user turn.
 * @param {number} [options.maxTokens]  Output budget. 8000 for extraction, 4000 for Q&A.
 * @param {number} [options.timeoutMs]  Per-attempt timeout, default 120000.
 * @param {AbortSignal} [options.signal] Caller cancellation; aborts without retrying.
 * @returns {Promise<{ok:boolean, text:string, stop_reason:(string|null),
 *                    usage:(object|null), model:string, error:(string|null),
 *                    status:(number|null), attempts:number}>}
 */
export async function callMessages({
  apiKey,
  model = DEFAULT_MODEL,
  system,
  user,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null
} = {}) {
  const result = {
    ok: false,
    text: '',
    stop_reason: null,
    usage: null,
    model,
    error: null,
    status: null,
    attempts: 0
  };

  const key = resolveApiKey(apiKey);
  if (!key) {
    result.error =
      'no Anthropic API key — pass apiKey or set ANTHROPIC_API_KEY (run with fixture mode if you meant to stay offline)';
    return result;
  }

  // No temperature/top_p/top_k: newer models reject them. No assistant prefill:
  // it returns 400 on these models, so JSON shape is held by the prompt alone.
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }]
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result.attempts = attempt;

    let res;
    let raw;
    try {
      ({ res, raw } = await sendOnce(body, key, timeoutMs, signal));
    } catch (err) {
      if (!(err instanceof RequestError)) throw err;
      if (!err.retryable || attempt === MAX_ATTEMPTS) {
        result.error = err.message;
        return result;
      }
      if (!(await waitBeforeRetry(backoffMs(attempt), signal))) {
        result.error = 'request cancelled by the caller';
        return result;
      }
      continue;
    }

    result.status = res.status;

    if (!res.ok) {
      const detail = apiErrorMessage(raw, res.status);
      // 400 is a bad request — the same body will fail the same way. Only rate
      // limiting, request timeouts and server-side faults are worth repeating.
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        result.error = `Anthropic API returned HTTP ${res.status}: ${detail}`;
        return result;
      }
      const wait = retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt);
      if (!(await waitBeforeRetry(wait, signal))) {
        result.error = 'request cancelled by the caller';
        return result;
      }
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      result.error = `Anthropic API returned a non-JSON body: ${clip(raw, 200)}`;
      return result;
    }

    result.stop_reason = payload.stop_reason ?? null;
    result.usage = payload.usage ?? null;
    result.model = payload.model || model;

    if (result.stop_reason === 'refusal') {
      result.error = 'the model declined this request (stop_reason "refusal") — its output must not be used';
      return result;
    }

    const text = (Array.isArray(payload.content) ? payload.content : [])
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    if (!text.trim()) {
      result.error = `the response carried no text content (stop_reason ${result.stop_reason ?? 'unknown'})`;
      return result;
    }

    result.text = text;
    result.ok = true;
    return result;
  }

  return result;
}

/* --------------------------------------------------------------- transport -- */

async function sendOnce(body, key, timeoutMs, callerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs);
  const forwardAbort = () => controller.abort(callerSignal.reason);

  if (callerSignal) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION
      },
      body,
      signal: controller.signal
    });
    return { res, raw: await res.text() };
  } catch (err) {
    if (controller.signal.reason === TIMEOUT_REASON) {
      throw new RequestError(`request to the Anthropic API timed out after ${timeoutMs}ms`, { retryable: true });
    }
    if (callerSignal && callerSignal.aborted) {
      throw new RequestError('request cancelled by the caller', { retryable: false });
    }
    const cause = err.cause && err.cause.message ? ` (${err.cause.message})` : '';
    throw new RequestError(`request to the Anthropic API failed: ${err.message}${cause}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
  }
}

function apiErrorMessage(raw, status) {
  try {
    const payload = JSON.parse(raw);
    const message = payload && payload.error && payload.error.message;
    const type = payload && payload.error && payload.error.type;
    if (message) return type ? `${message} (${type})` : message;
  } catch {
    // Gateways and proxies in front of the API answer in HTML; fall through and
    // show whatever came back so the operator can see who actually replied.
  }
  return raw.trim() ? clip(raw, 300) : `no error body (HTTP ${status})`;
}

/* ------------------------------------------------------------------ retry -- */

function backoffMs(attempt) {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), MAX_BACKOFF_MS);
  return null;
}

/** Resolves true after the wait, or false as soon as the caller cancels. */
function waitBeforeRetry(ms, signal) {
  if (signal && signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
