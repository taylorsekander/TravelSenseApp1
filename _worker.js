/**
 * _worker.js — Cloudflare Pages
 *
 * A single root-level Worker. Cloudflare Pages runs this for every request:
 * anything under /api/ is handled here, everything else is served from the
 * static files in the same directory (index.html and friends).
 *
 * This keeps the repository completely flat — no folders — which is the
 * layout that uploads cleanly through the GitHub web interface.
 *
 * SETUP (Workers Builds — the current Cloudflare default for Git projects)
 *   1. wrangler.json in this repo declares this file as the entry point and
 *      the repo root as the static asset directory.
 *   2. .assetsignore keeps this file from being published as a public asset.
 *      Without it the deploy fails, which is the correct behaviour: server
 *      code must never be served to browsers.
 *   3. Settings > Variables and Secrets > add for Production:
 *        ANTHROPIC_API_KEY     required
 *        GOOGLE_TTS_API_KEY    optional, enables the natural voice
 *        GOOGLE_TTS_VOICE      optional
 *        GOOGLE_TTS_MODEL      optional
 *        GOOGLE_TTS_STYLE      optional
 *        GA4_MEASUREMENT_ID    optional, server-side cost tracking
 *        GA4_API_SECRET        optional
 *   4. Redeploy after adding variables.
 *
 * Verify:  /api/chat  should return 405 (not 404). 405 means it is live.
 *
 * Logs: Workers & Pages > your project > Deployments > Functions, or run
 * `npx wrangler pages deployment tail`. Filter on ts_metrics and ts_signup.
 */

const UPSTREAM = "https://api.anthropic.com/v1/messages";

// ---- speech defaults ----
// Voice list: Google Cloud docs > Text-to-Speech > Chirp 3 HD voices.
const DEFAULT_VOICE = "en-US-Chirp3-HD-Achernar";
// Gemini-TTS is the model that honours the style prompt below.
const DEFAULT_TTS_MODEL = "gemini-2.5-flash-tts";
// Style instruction, applied to every line the advisor speaks.
const DEFAULT_STYLE =
  "Speak as a warm, confident and friendly travel advisor talking with a " +
  "client you like. Relaxed and natural, never rushed or salesy. Sound " +
  "genuinely interested in their answers, with the easy assurance of someone " +
  "who has planned hundreds of trips.";
const ANTHROPIC_VERSION = "2023-06-01";

const RETRY_ONCE_ON = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAY_MS = 1200;

// Approximate per-million-token pricing, USD. Adjust if your rates differ.
const PRICING = {
  default: { input: 3.0, output: 15.0 },
  haiku: { input: 0.8, output: 4.0 },
  opus: { input: 15.0, output: 75.0 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The native app calls this API cross-origin from capacitor://localhost, so
// every response — not just the OPTIONS preflight — has to carry CORS headers
// or WebKit discards it before the app ever sees the body.
const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const reply = (statusCode, payload) =>
  new Response(JSON.stringify(payload), { status: statusCode, headers: JSON_HEADERS });
const errorReply = (statusCode, message) => reply(statusCode, { error: { message } });

function priceFor(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return PRICING.haiku;
  if (m.includes("opus")) return PRICING.opus;
  return PRICING.default;
}

function estimateCost(model, usage) {
  if (!usage) return 0;
  const p = priceFor(model);
  const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  return Number(((inTok / 1e6) * p.input + (outTok / 1e6) * p.output).toFixed(6));
}

/** One structured line per request. Never sent to the client. */
function logMetrics(m) {
  try {
    console.log("ts_metrics " + JSON.stringify(m));
  } catch (e) {
    /* logging must never break the request */
  }
}

/**
 * Send the same metrics to GA4 via the Measurement Protocol, so cost shows up
 * alongside the browser's events in one property.
 *
 * Requires two Netlify environment variables:
 *   GA4_MEASUREMENT_ID  - e.g. G-32SNHPSVGG
 *   GA4_API_SECRET      - GA4 > Admin > Data streams > your stream >
 *                         Measurement Protocol API secrets > Create
 *
 * If either is missing this quietly does nothing, so the app runs fine
 * without them. Failures here never affect the user's request.
 */
async function sendToGA4(env, clientId, metrics) {
  const id = env.GA4_MEASUREMENT_ID;
  const secret = env.GA4_API_SECRET;
  if (!id || !secret) return;

  const params = {
    kind: metrics.kind || "unknown",
    model: String(metrics.model || ""),
    ok: metrics.ok ? 1 : 0,
    api_cost: Number(metrics.est_cost_usd || 0),
    total_tokens: Number(metrics.total_tokens || 0),
    input_tokens: Number(metrics.input_tokens || 0),
    output_tokens: Number(metrics.output_tokens || 0),
    latency_ms: Number(metrics.ms || 0),
    retries: Number(metrics.retries || 0),
    truncated: metrics.truncated ? 1 : 0,
    error_type: String(metrics.error || "none"),
    engagement_time_msec: 1,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(
      "https://www.google-analytics.com/mp/collect?measurement_id=" +
        encodeURIComponent(id) + "&api_secret=" + encodeURIComponent(secret),
      {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          client_id: String(clientId || "server"),
          non_personalized_ads: true,
          events: [{ name: "claude_api_call", params }],
        }),
      }
    );
  } catch (e) {
    // Analytics must never break the request. Swallow it.
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Anything not under /api/ is a static file served from the same repo.
    if (!url.pathname.startsWith("/api/")) {
      if (!env.ASSETS) {
        return new Response("Static assets are not bound. Check the assets binding in wrangler.json.", { status: 500 });
      }
      const res = await env.ASSETS.fetch(request);
      // The app is one HTML file that changes every deploy. Letting any layer
      // cache it means fixes silently never reach a device — which has now
      // cost several rounds of debugging. Images and icons still cache.
      const isDoc = url.pathname === "/" || url.pathname.endsWith(".html")
        || url.pathname.endsWith(".webmanifest");
      if (!isDoc) return res;
      const headers = new Headers(res.headers);
      headers.set("cache-control", "no-store, must-revalidate");
      headers.set("pragma", "no-cache");
      headers.set("expires", "0");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }

    // Keep the Netlify path working too, so the same build runs on either host.
    if (url.pathname !== "/api/chat" && url.pathname !== "/api/hello") {
      return errorReply(404, "Unknown API route.");
    }

    if (url.pathname === "/api/hello") {
      const key = env.ANTHROPIC_API_KEY || "";
      return reply(200, {
        ok: true,
        runtime: "cloudflare-pages",
        // Report only the length, never the key itself.
        anthropic_key_detected: !!key,
        anthropic_key_length: key.length,
        google_tts_configured: !!env.GOOGLE_TTS_API_KEY,
        ga4_configured: !!(env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET),
        travelpayouts_configured: !!env.TRAVELPAYOUTS_TOKEN,
        travelpayouts_marker_set: !!env.TRAVELPAYOUTS_MARKER,
      });
    }

    return handleChat(request, env);
  },
};

async function handleChat(request, env) {
  const event = {
    httpMethod: request.method,
    body: request.method === "POST" ? await request.text() : "",
  };

  const startedAt = Date.now();

  if (event.httpMethod === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  }
  if (event.httpMethod !== "POST") {
    return errorReply(405, "This endpoint only accepts POST requests.");
  }

  // ---- signup capture -------------------------------------------------
  // Beta signups are POSTed here so they land somewhere the founder can read,
  // rather than sitting in the tester's own browser. Handled before the API
  // key check because collecting a signup must not depend on Anthropic.
  let earlyPayload = null;
  try {
    earlyPayload = JSON.parse(event.body || "{}");
  } catch (err) {
    return errorReply(400, "Request body was not valid JSON.");
  }

  if (earlyPayload && earlyPayload.type === "signup") {
    const s = earlyPayload.signup || {};
    const email = String(s.email || "").trim();
    const name = String(s.name || "").trim();
    if (!email || email.indexOf("@") < 0) {
      return errorReply(400, "A valid email is required.");
    }
    // One line per signup. Retrieve with: Netlify > Logs > Functions,
    // filtering on "ts_signup".
    try {
      console.log(
        "ts_signup " +
          JSON.stringify({
            email,
            name,
            at: s.at || new Date().toISOString(),
            source: s.source || "unknown",
            cid: String(earlyPayload.cid || "unknown"),
          })
      );
    } catch (e) {}
    return reply(200, { ok: true });
  }
  // ---------------------------------------------------------------------

  // ---- travelpayouts affiliate links ------------------------------------
  // Converts plain brand URLs into affiliate links, server-side, so the API
  // token never reaches the browser. Falls back to the original links if the
  // conversion fails, which means booking buttons always work.
  //
  // Requires in Cloudflare:
  //   TRAVELPAYOUTS_TOKEN   Profile > API token in your Travelpayouts account
  //   TRAVELPAYOUTS_MARKER  your partner/marker ID
  //
  // Docs: support.travelpayouts.com > API for Travelpayouts partner links
  if (earlyPayload && earlyPayload.type === "affiliate") {
    const token = env.TRAVELPAYOUTS_TOKEN;
    const marker = env.TRAVELPAYOUTS_MARKER || "";
    const links = Array.isArray(earlyPayload.links) ? earlyPayload.links.slice(0, 10) : [];
    if (!links.length) return errorReply(400, "No links supplied.");

    // Not configured: hand back what we were given so nothing breaks.
    if (!token) {
      return reply(200, { links, converted: false, reason: "not_configured" });
    }

    const started = Date.now();
    try {
      const r = await fetch("https://api.travelpayouts.com/links/v1/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Access-Token": token,
        },
        body: JSON.stringify({ marker, links }),
      });
      const text = await r.text();
      if (!r.ok) {
        let msg = "";
        try { msg = JSON.parse(text).message || JSON.parse(text).error || ""; } catch (e) {}
        logMetrics({
          ok: false, kind: "affiliate", error: "status_" + r.status,
          detail: msg.slice(0, 140), count: links.length, ms: Date.now() - started,
        });
        // Never block a booking on our monetization failing.
        return reply(200, { links, converted: false, reason: "upstream_" + r.status });
      }
      const parsed = JSON.parse(text);
      // The API returns objects keyed by the original URL; normalise to an
      // array in the same order we sent, falling back per-link.
      const out = links.map((orig) => {
        const hit = (parsed.links || parsed || []).find
          ? (parsed.links || []).find((x) => x && (x.original === orig || x.link === orig))
          : null;
        return (hit && (hit.partner_link || hit.partner_url || hit.url)) ||
               (parsed[orig] && (parsed[orig].partner_link || parsed[orig])) ||
               orig;
      });
      logMetrics({
        ok: true, kind: "affiliate", count: links.length,
        converted: out.filter((u, i) => u !== links[i]).length,
        ms: Date.now() - started,
      });
      return reply(200, { links: out, converted: true });
    } catch (err) {
      logMetrics({ ok: false, kind: "affiliate", error: "network", ms: Date.now() - started });
      return reply(200, { links, converted: false, reason: "network" });
    }
  }

  // ---- speech to text ---------------------------------------------------
  // Browser speech recognition is unusable on iOS Safari, so audio is captured
  // in the page and transcribed here instead. Identical behaviour on every
  // platform, because the recognition no longer depends on the browser.
  //
  // Audio arrives as 16 kHz mono LINEAR16 (WAV), base64 encoded.
  //
  // Uses GOOGLE_STT_API_KEY, falling back to GOOGLE_TTS_API_KEY when both
  // live in the same Google Cloud project. The Cloud Speech-to-Text API must
  // be enabled on that project.
  if (earlyPayload && earlyPayload.type === "stt") {
    const sttKey = env.GOOGLE_STT_API_KEY || env.GOOGLE_TTS_API_KEY;
    if (!sttKey) {
      return reply(503, { error: { message: "Speech to text not configured" }, fallback: true });
    }
    const audio = String(earlyPayload.audio || "");
    if (!audio) return errorReply(400, "No audio supplied.");
    // Roughly 20 seconds of 16 kHz mono audio, base64 encoded.
    if (audio.length > 1400000) return errorReply(413, "That recording was too long.");

    const started = Date.now();
    try {
      const r = await fetch(
        "https://speech.googleapis.com/v1/speech:recognize?key=" + encodeURIComponent(sttKey),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            config: {
              encoding: "LINEAR16",
              sampleRateHertz: 16000,
              languageCode: "en-US",
              enableAutomaticPunctuation: true,
              // Tuned for short conversational answers rather than dictation.
              model: "latest_short",
              useEnhanced: true,
            },
            audio: { content: audio },
          }),
        }
      );
      const text = await r.text();
      if (!r.ok) {
        let msg = "";
        try { msg = JSON.parse(text).error.message || ""; } catch (e) {}
        logMetrics({
          ok: false, kind: "stt", error: "status_" + r.status,
          detail: msg.slice(0, 140), ms: Date.now() - started,
        });
        return reply(r.status === 429 ? 429 : 502, {
          error: { message: msg || "Transcription failed." }, fallback: true,
        });
      }
      const parsed = JSON.parse(text);
      const transcript = ((parsed.results || [])
        .map((x) => (((x.alternatives || [])[0] || {}).transcript || ""))
        .join(" ")).trim();
      logMetrics({
        ok: true, kind: "stt", ms: Date.now() - started,
        chars: transcript.length, empty: !transcript,
        // Speech-to-Text is billed per 15 seconds; this is a rough guide only.
        est_cost_usd: Number((((audio.length / 32000) / 15) * 0.006).toFixed(6)),
      });
      return reply(200, { transcript });
    } catch (err) {
      logMetrics({ ok: false, kind: "stt", error: "network", ms: Date.now() - started });
      return reply(502, { error: { message: "Could not reach the speech service." }, fallback: true });
    }
  }

  // ---- tts availability check -------------------------------------------
  // Lets the browser know whether neural speech is configured without
  // synthesizing anything, so no characters are consumed.
  if (earlyPayload && earlyPayload.type === "tts_status") {
    const key = env.GOOGLE_TTS_API_KEY || "";
    return reply(200, {
      available: !!key,
      stt_available: !!(env.GOOGLE_STT_API_KEY || env.GOOGLE_TTS_API_KEY),
      // Enough to diagnose a misconfiguration without exposing the key.
      reason: key ? "ok" : "missing_key",
      key_length: key.length,
      voice: env.GOOGLE_TTS_VOICE || DEFAULT_VOICE,
      model: env.GOOGLE_TTS_MODEL || DEFAULT_TTS_MODEL,
    });
  }

  // ---- text to speech ---------------------------------------------------
  // Google Cloud Text-to-Speech. Uses Gemini-TTS, which accepts a natural
  // language style prompt, and falls back to Chirp 3 HD (no style control) if
  // the Gemini model is unavailable.
  //
  // Requires in Netlify:
  //   GOOGLE_TTS_API_KEY  - Google Cloud console > APIs & Services >
  //                         Credentials, with Cloud Text-to-Speech enabled
  // Optional:
  //   GOOGLE_TTS_VOICE    - default en-US-Chirp3-HD-Achernar
  //   GOOGLE_TTS_MODEL    - default gemini-2.5-flash-tts
  //   GOOGLE_TTS_STYLE    - the style instruction, see DEFAULT_STYLE below
  //
  // Without the key this returns 503 and the browser uses the device voice.
  if (earlyPayload && earlyPayload.type === "tts") {
    const ttsKey = env.GOOGLE_TTS_API_KEY;
    if (!ttsKey) {
      return reply(503, { error: { message: "TTS not configured" }, fallback: true });
    }
    const text = String(earlyPayload.text || "").slice(0, 1200);
    if (!text.trim()) return errorReply(400, "No text supplied.");

    const voiceName = env.GOOGLE_TTS_VOICE || DEFAULT_VOICE;
    const modelName = env.GOOGLE_TTS_MODEL || DEFAULT_TTS_MODEL;
    const style = env.GOOGLE_TTS_STYLE || DEFAULT_STYLE;
    const langCode = voiceName.slice(0, 5);
    const ttsStarted = Date.now();
    const url =
      "https://texttospeech.googleapis.com/v1/text:synthesize?key=" +
      encodeURIComponent(ttsKey);

    // Attempt 1: Gemini-TTS with the style prompt.
    // Attempt 2: plain Chirp 3 HD, which ignores style but is widely available.
    const attempts = [
      {
        label: "gemini",
        body: {
          input: { text, prompt: style },
          voice: { languageCode: langCode, name: voiceName, model_name: modelName },
          audioConfig: { audioEncoding: "MP3" },
        },
      },
      {
        label: "chirp",
        body: {
          input: { text },
          voice: { languageCode: langCode, name: voiceName },
          audioConfig: {
            audioEncoding: "MP3",
            speakingRate: 0.98,
            effectsProfileId: ["headphone-class-device"],
          },
        },
      },
    ];

    let lastStatus = 502;
    let lastMessage = "";
    for (const attempt of attempts) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(attempt.body),
        });
        const bodyText = await r.text();
        if (r.ok) {
          const parsed = JSON.parse(bodyText);
          logMetrics({
            ok: true, kind: "tts", mode: attempt.label, voice: voiceName,
            model: attempt.label === "gemini" ? modelName : "chirp3-hd",
            styled: attempt.label === "gemini",
            ms: Date.now() - ttsStarted, chars: text.length,
            est_cost_usd: Number(((text.length / 1e6) * 30).toFixed(6)),
          });
          return reply(200, {
            audio: parsed.audioContent,
            voice: voiceName,
            styled: attempt.label === "gemini",
          });
        }
        lastStatus = r.status;
        try { lastMessage = JSON.parse(bodyText).error.message || ""; } catch (e) {}
        logMetrics({
          ok: false, kind: "tts", mode: attempt.label,
          error: "status_" + r.status, detail: lastMessage.slice(0, 120),
          ms: Date.now() - ttsStarted,
        });
        // A quota stop won't be fixed by retrying with another model.
        if (r.status === 429) break;
      } catch (err) {
        logMetrics({ ok: false, kind: "tts", mode: attempt.label, error: "network" });
        lastMessage = "Could not reach the speech service.";
      }
    }
    return reply(lastStatus === 429 ? 429 : 502, {
      error: { message: lastMessage || "Speech synthesis failed." },
      fallback: true,
    });
  }
  // ---------------------------------------------------------------------

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logMetrics({ ok: false, error: "missing_key", ms: Date.now() - startedAt });
    return errorReply(
      500,
      "ANTHROPIC_API_KEY is not configured on the server. Add it in Netlify under Site configuration > Environment variables, then redeploy."
    );
  }

  const payload = earlyPayload || {};
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return errorReply(400, "Request must include a non-empty messages array.");
  }

  const model = payload.model;
  const body = JSON.stringify({
    model,
    max_tokens: payload.max_tokens || 2000,
    system: payload.system,
    messages: payload.messages,
  });

  // Rough classification so logs separate conversation turns from
  // recommendation reasoning — they have very different cost profiles.
  const kind = /Why we picked this/.test(payload.system || "") ? "reasons" : "conversation";
  const clientId = payload.cid || "server";

  let retries = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });
    } catch (err) {
      if (attempt === 1) {
        retries++;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      logMetrics({ ok: false, kind, model, error: "network", retries, ms: Date.now() - startedAt });
      return errorReply(502, "Could not reach Claude. Please try again in a moment.");
    }

    const text = await res.text();

    if (res.ok) {
      let usage = null;
      let stopReason = null;
      try {
        const parsed = JSON.parse(text);
        usage = parsed.usage || null;
        stopReason = parsed.stop_reason || null;
      } catch (e) {}
      const metrics = {
        ok: true,
        kind,
        model,
        ms: Date.now() - startedAt,
        retries,
        stop_reason: stopReason,
        input_tokens: usage ? usage.input_tokens : null,
        output_tokens: usage ? usage.output_tokens : null,
        total_tokens: usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) : null,
        est_cost_usd: estimateCost(model, usage),
        truncated: stopReason === "max_tokens",
      };
      logMetrics(metrics);
      await sendToGA4(env, clientId, metrics);
      return new Response(text, { status: 200, headers: JSON_HEADERS });
    }

    if (RETRY_ONCE_ON.has(res.status) && attempt === 1) {
      retries++;
      logMetrics({ ok: false, kind, model, error: "retryable_" + res.status, retries, ms: Date.now() - startedAt });
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    let upstreamMessage = "";
    try {
      const parsed = JSON.parse(text);
      upstreamMessage = (parsed && parsed.error && parsed.error.message) || "";
    } catch (e) {}

    const failMetrics = { ok: false, kind, model, error: "status_" + res.status, retries, ms: Date.now() - startedAt };
    logMetrics(failMetrics);
    await sendToGA4(env, clientId, failMetrics);

    if (res.status === 401 || res.status === 403) {
      return errorReply(res.status, "The server's API key was rejected. Check ANTHROPIC_API_KEY in Netlify.");
    }
    if (res.status === 429) return errorReply(429, "Rate limit reached. Please wait a few seconds and try again.");
    if (res.status === 529) return errorReply(529, "Claude is temporarily overloaded. Please try again shortly.");
    if (res.status === 400) return errorReply(400, upstreamMessage || "Claude rejected that request.");
    if (res.status >= 500) return errorReply(502, "Claude had a server error. Please try again in a moment.");
    return errorReply(res.status, upstreamMessage || `Request failed with status ${res.status}.`);
  }

  logMetrics({ ok: false, kind, model, error: "exhausted", retries, ms: Date.now() - startedAt });
  return errorReply(502, "Request failed after retrying. Please try again.");
}
