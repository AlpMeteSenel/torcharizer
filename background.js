console.log("Torcharizer background loaded");

const tb = typeof browser !== "undefined" ? browser : (typeof messenger !== "undefined" ? messenger : null);

// Prefer manifest-based injection via "message_display_scripts".
// Also register programmatically as a fallback for some Thunderbird variants.
(async () => {
  try {
    if (tb?.messageDisplayScripts?.register) {
      await tb.messageDisplayScripts.register({
        js: [{ file: "content.js" }],
        runAt: "document_start",
      });
      try { console.log("messageDisplayScripts.register: programmatic registration ok at document_start"); } catch {}
    } else {
      try { console.log("messageDisplayScripts.register not available; falling back to tabs.executeScript sweep"); } catch {}
    }
  } catch (e) {
    try { console.warn("messageDisplayScripts.register fallback failed:", String(e)); } catch {}
  }

  // Also inject into already-open message display tabs (register only affects new ones).
  try {
    if (tb?.tabs?.query && tb?.tabs?.executeScript) {
      const tabs = await tb.tabs.query({});
      for (const t of tabs || []) {
        try {
          // Only target message display tabs.
          if (!t || t.type !== "messageDisplay") continue;
          await tb.tabs.executeScript(t.id, {
            file: "content.js",
            runAt: "document_start"
          });
          try { console.log("Executed content.js into existing message tab", t.id); } catch {}
        } catch (e) {
          try { console.debug("executeScript failed for tab", t?.id, String(e)); } catch {}
        }
      }
    }
  } catch (e) {
    try { console.debug("Initial executeScript sweep failed:", String(e)); } catch {}
  }
})();

// Utility: small delay
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Utility: wait until the content script in a tab is ready by pinging it.
async function waitForContentReady(tabId, { tries = 10, delay = 150 } = {}) {
  if (!tb?.tabs?.sendMessage) return true;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      // If we've recorded a frameId for this tab, consider it ready
      const knownFrameId = tabToFrameId.get(tabId);
      const resp = knownFrameId != null
  ? await tb.tabs.sendMessage(tabId, { type: "torcharizer:ping" }, { frameId: knownFrameId })
  : await tb.tabs.sendMessage(tabId, { type: "torcharizer:ping" });
      if (resp && resp.ok) return true;
    } catch (e) {
      lastErr = e;
    }
    await sleep(delay);
  }
  try { console.debug("waitForContentReady: giving up for tab", tabId, String(lastErr || "")); } catch {}
  return false;
}

// Utility: robust send to tab without assuming a frameId
async function sendToTab(tabId, message, { tries = 3, delay = 120, quiet = false } = {}) {
  if (!tb?.tabs?.sendMessage) return false;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const frameId = tabToFrameId.get(tabId);
      if (frameId != null) {
        await tb.tabs.sendMessage(tabId, message, { frameId });
      } else {
        await tb.tabs.sendMessage(tabId, message);
      }
      return true;
    } catch (e) {
      lastErr = e;
      await sleep(delay);
    }
  }
  if (!quiet) { try { console.debug("sendToTab failed", message?.type, "tab", tabId, String(lastErr || "")); } catch {} }
  return false;
}

// surface content-script logs in background console
if (tb?.runtime?.onMessage) {
  try {
    tb.runtime.onMessage.addListener((msg, sender) => {
      // Record frameId so we can target the correct message display frame.
      try {
        if (sender?.tab?.id != null && sender?.frameId != null) {
          tabToFrameId.set(sender.tab.id, sender.frameId);
        }
      } catch {}
  if (msg && msg.type === "torcharizer:log") {
        try { console.log("[content]", ...(Array.isArray(msg.args) ? msg.args : [String(msg.args)])); } catch {}
      }
    });
  } catch {}
}

// Simple LRU cache for summaries to avoid re-summarizing when navigating back and forth.
const summaryCache = new Map(); // key: message.id, value: summary
const MAX_CACHE = 200;
// Track in-flight summary promises to coalesce concurrent requests per message
const inflightSummaries = new Map(); // key: message.id, value: Promise<string>
// Track which message is currently displayed in each tab
const tabToMessageId = new Map(); // key: tab.id, value: message.id
// Track last-known content frame per tab for targeted messaging
const tabToFrameId = new Map(); // key: tab.id, value: frameId

function cacheSet(id, summary) {
  if (summaryCache.has(id)) summaryCache.delete(id);
  summaryCache.set(id, summary);
  if (summaryCache.size > MAX_CACHE) {
    // delete oldest (first inserted)
    const firstKey = summaryCache.keys().next().value;
    summaryCache.delete(firstKey);
  }
}

function cacheGet(id) {
  if (!summaryCache.has(id)) return undefined;
  const val = summaryCache.get(id);
  // refresh LRU position
  summaryCache.delete(id);
  summaryCache.set(id, val);
  return val;
}

// Settings: global toggle and model/prompt
let aiEnabled = true;
let modelName = 'llama3.2:latest';
let systemPromptOverride = '';
async function loadSettings() {
  try {
    const tbAny = tb;
  const got = await tbAny?.storage?.local?.get?.({ aiEnabled: true, modelName: 'llama3.2:latest', systemPrompt: '' });
  aiEnabled = (got && typeof got.aiEnabled !== 'undefined') ? !!got.aiEnabled : true;
  modelName = (got && got.modelName) ? String(got.modelName) : 'llama3.2:latest';
  systemPromptOverride = (got && typeof got.systemPrompt === 'string') ? got.systemPrompt : '';
  } catch { aiEnabled = true; }
}
loadSettings();

// Respond to settings changes from popup
tb?.runtime?.onMessage?.addListener?.((msg) => {
  if (msg && msg.type === 'torcharizer:settings-changed') {
    aiEnabled = !!msg.aiEnabled;
  if (typeof msg.modelName === 'string' && msg.modelName.trim()) modelName = msg.modelName.trim();
  if (typeof msg.systemPrompt === 'string') systemPromptOverride = msg.systemPrompt;
  }
});

// Summarize when the user displays (clicks) a message in the preview or a tab.
if (tb?.messageDisplay?.onMessageDisplayed) {
  tb.messageDisplay.onMessageDisplayed.addListener(async (tab, message) => {
    try {
      if (!tab || !message) return;
      try { console.log("onMessageDisplayed:", { tabId: tab?.id, msgId: message?.id, subject: message?.subject }); } catch {}
      // Track mapping for request resolution
      if (tab?.id != null && message?.id != null) tabToMessageId.set(tab.id, message.id);

  // Ensure content script is ready before attempting to message it
  await waitForContentReady(tab.id, { tries: 12, delay: 150 });

  if (!aiEnabled) {
        // If disabled, instruct content to hide panel
  await sendToTab(tab.id, { type: "torcharizer:update", summary: "", done: true }, { tries: 2, delay: 150, quiet: true });
        return;
      }

  // Tell the content script to show loading state
  if (await sendToTab(tab.id, { type: "torcharizer:update", summary: "Generating summary…", done: false }, { tries: 4, delay: 180, quiet: true })) {
        try { console.log("tabs.sendMessage loading state ok -> tab", tab.id); } catch {}
      }

  // Use cache if available
      const cached = cacheGet(message.id);
      if (cached) {
  if (await sendToTab(tab.id, { type: "torcharizer:update", summary: cached }, { tries: 4, delay: 150, quiet: true })) {
          try { console.log("sent cached summary -> tab", tab.id); } catch {}
        }
        return;
      }

      // Fetch full message to extract text
      let full;
      try {
        full = await tb.messages.getFull(message.id);
      } catch (e) {
        console.error("getFull failed for", message.id, e);
        return;
      }

  let html = await getHtmlFromParts(full.parts);
  if (!html || !html.trim()) {
        console.log("No usable body for:", full.headers.subject?.[0] || message.subject || "(no subject)");
  await sendToTab(tab.id, { type: "torcharizer:update", summary: "(no body to summarize)" }, { quiet: true });
        return;
      }

  // Extract main readable content from HTML to aid the model
  const contentText = await extractReadableEmailContent(html);

  // Stream summary and push partial updates while generating
  const currentMsgId = message?.id;
  let summary;
  const compute = async () => await summarizeWithOllamaHtml(
    contentText,
    full?.headers?.subject?.[0] || message?.subject || "",
    async (partial, { done } = {}) => {
      try {
        if (!aiEnabled) return;
        // Only update if this tab is still showing the same message
        if (tabToMessageId.get(tab.id) !== currentMsgId) return;
        // Ensure content is still ready; send quietly to avoid console noise
  await sendToTab(tab.id, { type: "torcharizer:update", summary: partial || "Generating summary…", done: !!done }, { quiet: true });
        // Also notify any extension pages (like popup panel) listening for updates
  try { await tb.runtime?.sendMessage?.({ type: "torcharizer:update", summary: partial || "Generating summary…", done: !!done }); } catch {}
      } catch {}
    }
  );
  if (inflightSummaries.has(currentMsgId)) {
    try { summary = await inflightSummaries.get(currentMsgId); } finally { /* keep inflight until producer clears */ }
  } else {
    const p = compute().then((s) => s).finally(() => { inflightSummaries.delete(currentMsgId); });
    inflightSummaries.set(currentMsgId, p);
    summary = await p;
  }
      const finalSummary = summary && summary.trim() ? summary.trim() : "(no summary generated)";
      cacheSet(message.id, finalSummary);
  if (await sendToTab(tab.id, { type: "torcharizer:update", summary: finalSummary, done: true }, { tries: 4, delay: 180, quiet: true })) {
        try { console.log("sent final summary -> tab", tab.id); } catch {}
      }
    } catch (err) {
      console.error("Error in onMessageDisplayed handler:", err);
    }
  });
} else {
  console.warn("messageDisplay.onMessageDisplayed not available in this Thunderbird version.");
}

// Respond to content-script requests for summaries (race-proofing UI updates).
tb?.runtime?.onMessage?.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "torcharizer:ping") {
    try {
      if (sender?.tab?.id != null && sender?.frameId != null) {
        tabToFrameId.set(sender.tab.id, sender.frameId);
      }
    } catch {}
    return Promise.resolve({ ok: true });
  }
  if (msg.type !== "torcharizer:request") return;

  const messageId = msg.messageId;
  return (async () => {
    try {
      if (!aiEnabled) {
        return { summary: "" };
      }
      let resolvedMessageId = messageId;
      // First try our own mapping
      const senderTabId = sender?.tab?.id;
      if (resolvedMessageId == null && senderTabId != null) {
        const mapped = tabToMessageId.get(senderTabId);
        if (mapped != null) resolvedMessageId = mapped;
      }
      // Fallback to API in case mapping isn't set yet
      if (resolvedMessageId == null && senderTabId != null && tb.messageDisplay?.getDisplayedMessage) {
        try {
          const displayed = await tb.messageDisplay.getDisplayedMessage(senderTabId);
          if (displayed?.id != null) resolvedMessageId = displayed.id;
        } catch {}
      }

      // Serve from cache if present.
  let summary = resolvedMessageId != null ? cacheGet(resolvedMessageId) : undefined;
  if (!summary) {
        // Compute now with streaming updates to the sender tab if available.
        const full = await tb.messages.getFull(resolvedMessageId);
        const html = await getHtmlFromParts(full.parts);
        if (!html || !html.trim()) {
          summary = "(no body to summarize)";
        } else {
          const contentText = await extractReadableEmailContent(html);
          const onProgress = async (partial, { done } = {}) => {
    if (!aiEnabled) return;
            const tabId = sender?.tab?.id;
            try {
              if (tabId != null) {
                const frameId = sender?.frameId ?? tabToFrameId.get(tabId);
                if (frameId != null) {
                  await tb.tabs.sendMessage(tabId, { type: "torcharizer:update", summary: partial || "Generating summary…", done: !!done }, { frameId });
                } else {
                  await tb.tabs.sendMessage(tabId, { type: "torcharizer:update", summary: partial || "Generating summary…", done: !!done });
                }
              }
              // Broadcast so browser_action popup can also reflect streaming content
              try { await tb.runtime?.sendMessage?.({ type: "torcharizer:update", summary: partial || "Generating summary…", done: !!done }); } catch {}
            } catch {}
          };
          const key = resolvedMessageId;
          const compute = async () => {
            const s = await summarizeWithOllamaHtml(contentText, full?.headers?.subject?.[0] || "", onProgress);
            return s && s.trim() ? s.trim() : "(no summary generated)";
          };
          if (inflightSummaries.has(key)) {
            summary = await inflightSummaries.get(key);
          } else {
            const p = compute().finally(() => inflightSummaries.delete(key));
            inflightSummaries.set(key, p);
            summary = await p;
          }
        }
        if (resolvedMessageId != null) cacheSet(resolvedMessageId, summary);
      }
      // Push to tab if available and return for direct response.
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        try {
          const frameId = sender?.frameId ?? tabToFrameId.get(tabId);
          if (frameId != null) {
            await tb.tabs.sendMessage(tabId, { type: "torcharizer:update", summary, done: true }, { frameId });
          } else {
            await tb.tabs.sendMessage(tabId, { type: "torcharizer:update", summary, done: true });
          }
        } catch {}
      }
      return { summary };
    } catch (e) {
      return { summary: "(failed to load summary)" };
    }
  })();
});

// MIME and decoding helpers for robust scraping
function _getHeader(part, name) {
  try {
    const v = part?.headers?.[String(name).toLowerCase()];
    if (Array.isArray(v) && v.length) return v[0];
  } catch {}
  return "";
}

function _parseContentType(ct) {
  const res = { mime: "", params: {} };
  if (!ct) return res;
  const segs = String(ct).split(";");
  res.mime = segs.shift().trim().toLowerCase();
  for (const s of segs) {
    const m = /([A-Za-z0-9_-]+)\s*=\s*("([^"]*)"|[^;]+)/.exec(s);
    if (m) res.params[m[1].toLowerCase()] = (m[3] ?? m[2]).replace(/^"|"$/g, "");
  }
  return res;
}

function _b64ToBytes(b64) {
  try {
    const cleaned = String(b64).replace(/\s+/g, "");
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  } catch { return null; }
}

function _qpToBytes(qp) {
  try {
    let s = String(qp).replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "=") {
        const hex = s.substr(i + 1, 2);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          bytes.push("=".charCodeAt(0));
        }
      } else {
        bytes.push(ch.charCodeAt(0) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  } catch { return null; }
}

function _bytesToString(bytes, charset) {
  try {
    const dec = charset ? new TextDecoder(charset, { fatal: false }) : new TextDecoder();
    return dec.decode(bytes);
  } catch {
    try { return new TextDecoder().decode(bytes); } catch { return ""; }
  }
}

function _decodePartBody(part) {
  try {
    const raw = part?.body;
    if (typeof raw !== "string" || !raw) return "";
    const cte = (_getHeader(part, "content-transfer-encoding") || "").toLowerCase();
    const ct = _getHeader(part, "content-type") || part.contentType || "";
    const { params } = _parseContentType(ct);
    const charset = (params.charset || "").toLowerCase() || undefined;

    if (cte.includes("base64")) {
      const b = _b64ToBytes(raw);
      if (b) return _bytesToString(b, charset);
    }
    if (cte.includes("quoted-printable")) {
      const b = _qpToBytes(raw);
      if (b) return _bytesToString(b, charset);
    }
    // Heuristic base64
    if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s+/g, "").length % 4 === 0) {
      const b = _b64ToBytes(raw);
      if (b) return _bytesToString(b, charset);
    }
    return raw;
  } catch { return part?.body || ""; }
}

function _stripHtmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " ")
    .replace(/<br\s*\/?>(?=\s*<br\s*\/?>(?:\s*<br\s*\/?>(?:\s*<br\s*\/?>)?)?)/gi, "\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function _visibleTextLen(html) { return _stripHtmlToText(html || "").length; }

async function getPlainTextFromParts(parts) {
  let best = "";
  for (const part of parts || []) {
    const ctRaw = part.contentType || _getHeader(part, "content-type") || "";
    const ct = String(ctRaw).toLowerCase();
    const dispo = (_getHeader(part, "content-disposition") || "").toLowerCase();
    if (dispo.startsWith("attachment")) continue;
    if (ct.startsWith("text/plain")) {
      const s = _decodePartBody(part);
      if (s && s.length > best.length) best = s;
    } else if (ct.startsWith("text/html")) {
      const s = _decodePartBody(part);
      const rough = _stripHtmlToText(s);
      if (rough && rough.length > best.length) best = rough;
    } else if (ct.startsWith("multipart/")) {
      const nested = await getPlainTextFromParts(part.parts || []);
      if (nested && nested.length > best.length) best = nested;
    } else if (part.parts) {
      const nested = await getPlainTextFromParts(part.parts);
      if (nested && nested.length > best.length) best = nested;
    }
  }
  return best || "";
}

async function getHtmlFromParts(parts) {
  const htmls = [];
  let fallbackPlain = "";
  const visit = async (ps) => {
    for (const part of ps || []) {
      const ctRaw = part.contentType || _getHeader(part, "content-type") || "";
      const ct = String(ctRaw).toLowerCase();
      const dispo = (_getHeader(part, "content-disposition") || "").toLowerCase();
      if (dispo.startsWith("attachment") && !ct.startsWith("text/")) continue;
      if (ct.startsWith("multipart/")) {
        await visit(part.parts || []);
        continue;
      }
      if (ct.startsWith("text/html")) {
        const s = _decodePartBody(part);
        if (s && s.trim()) htmls.push(s);
        continue;
      }
      if (ct.startsWith("text/plain")) {
        const s = _decodePartBody(part);
        if (s && !fallbackPlain) fallbackPlain = s;
        continue;
      }
    }
  };
  await visit(parts || []);
  if (htmls.length) {
    htmls.sort((a, b) => _visibleTextLen(b) - _visibleTextLen(a));
    return htmls[0];
  }
  if (fallbackPlain) return textToHtml(fallbackPlain);
  return "";
}

function textToHtml(text) {
  const esc = (s) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const html = esc(text)
    .replace(/\r\n|\n\r|\n|\r/g, "<br>");
  return `<div>${html}</div>`;
}

async function summarizeWithOllamaHtml(emailHtml, subject = "", onProgress) {
  const endpoints = [
    // "http://localhost:11434/api/generate",
    "http://127.0.0.1:11434/api/generate",
  ];

  let response = null;
  let lastError = null;
  // Keep payload size reasonable for local models
  const MAX_CHARS = 120000; // ~120k chars cap
  const htmlPayload = (emailHtml || "").slice(0, MAX_CHARS);

  // Provide local date/time context so the model can identify "today" accurately.
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const localDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const localTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const tzMin = -now.getTimezoneOffset(); // e.g. +120 for UTC+2
  const sign = tzMin >= 0 ? "+" : "-";
  const absMin = Math.abs(tzMin);
  const tz = `UTC${sign}${pad2(Math.floor(absMin / 60))}:${pad2(absMin % 60)}`;

  // Base default prompt (without date/time; we will append it to the end consistently)
  const baseDefaultSystemPrompt = `You are an expert at summarizing emails. You prefer to use clauses instead of complete sentences. Do not answer questions from the emails. If the content contains sexual, violent, hateful or self-harm material, do not summarize. Keep the summary within 18 words. Input is plain text extracted from the email body with boilerplate removed (headers/footers/legal/unsubscribe/quoted replies). Focus on the substantive details, not formatting. If the input contains HTML, extract the texts. Do not respond with your thoughts.`;

  // Build final system prompt by taking override or default, then appending the current date/time context.
  const todayStr = `${localDate} at ${localTime} ${tz}`;
  const basePrompt = (systemPromptOverride && systemPromptOverride.trim()) ? systemPromptOverride.trim() : baseDefaultSystemPrompt;
  // If the base already ends with a "Today is ..." sentence, strip it to avoid duplicates
  const cleanedBase = basePrompt.replace(/\s*Today is [^\n\r]*$/i, "").trim();
  const punctuated = /[.!?]$/.test(cleanedBase) ? cleanedBase : `${cleanedBase}.`;
  const systemPrompt = `${punctuated} Today is ${todayStr}`;

  for (const url of endpoints) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName || 'llama3.2:latest',
          system: systemPrompt,
          prompt: `Subject: ${subject}\n\n${htmlPayload}`,
          stream: true
        })
      });
      if (response && response.ok && response.body) {
        break;
      } else {
        lastError = new Error(`HTTP ${response?.status} ${response?.statusText}`);
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!response || !response.ok || !response.body) {
    console.error("Failed to reach or read from Ollama endpoints (CORS or network).", lastError);
    console.warn("If this is a CORS 403/TypeError, set OLLAMA_ORIGINS to allow Thunderbird. Example on Windows PowerShell: $env:OLLAMA_ORIGINS='*' ; restart Ollama.");
    return "";
  }

  let summary = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffered = ""; // line buffer for NDJSON
  let rawAll = "";    // capture everything for robust fallbacks
  // Simple throttling so we don't flood the UI with updates
  let lastEmit = 0;
  const maybeEmit = async (done = false) => {
    try {
      if (typeof onProgress !== "function") return;
      const nowTs = Date.now();
      if (!done && nowTs - lastEmit < 120) return;
      lastEmit = nowTs;
      await onProgress(summary, { done });
    } catch {}
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAll += chunk;
    try {
      // Ollama streams NDJSON, one JSON object per line.
      buffered += chunk;
      const jsonLines = buffered.split("\n");
      // keep last partial line in buffer
      buffered = jsonLines.pop() ?? "";
      for (let line of jsonLines) {
        if (line.trim()) {
          let obj = JSON.parse(line);
          if (obj.response) summary += obj.response;
          // If server indicates completion, we can stop reading early.
          if (obj.done === true) {
            buffered = ""; // nothing more expected, but drain reader gracefully
            await maybeEmit(true);
          } else {
            await maybeEmit(false);
          }
        }
      }
    } catch (e) {
      console.error("Error parsing Ollama response chunk", e);
    }
  }

  // flush any remaining valid line
  if (buffered.trim()) {
    try {
      const obj = JSON.parse(buffered);
      if (obj.response) summary += obj.response;
    } catch {}
  }
  await maybeEmit(true);

  // If nothing was accumulated, attempt robust fallbacks based on the example provided.
  if (!summary.trim() && rawAll && rawAll.trim()) {
    try {
      // 1) Sometimes responses come as concatenated JSON objects without newlines: `}{`
      //    Normalize by injecting newlines between boundaries and parse again.
      const normalized = rawAll.replace(/}\s*{/g, "}\n{");
      let tmp = "";
      for (const line of normalized.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.response) tmp += obj.response;
        } catch {}
      }
      if (tmp.trim()) return tmp.trim();
    } catch {}

    // 2) If the payload is actually base64 of the NDJSON stream, decode and repeat.
    try {
      const b64 = rawAll.replace(/\s+/g, "");
      // Heuristic: base64 strings are typically A–Z, a–z, 0–9, +, /, =
      if (/^[A-Za-z0-9+\/]+=*$/.test(b64)) {
        // atob -> binary string -> Uint8Array -> UTF-8 string
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const decoded = new TextDecoder("utf-8").decode(bytes);
        const normalized = decoded.replace(/}\s*{/g, "}\n{");
        let tmp = "";
        for (const line of normalized.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try {
            const obj = JSON.parse(t);
            if (obj.response) tmp += obj.response;
          } catch {}
        }
        if (tmp.trim()) return tmp.trim();
      }
    } catch (e) {
      console.warn("Fallback base64 decode failed:", e);
    }

    // 3) Single JSON object (non-stream) with full response.
    try {
      const obj = JSON.parse(rawAll);
      if (obj && typeof obj.response === "string") {
        return obj.response.trim();
      }
    } catch {}
  }

  const out = summary.trim();
  return out;
}

// Convert raw email HTML into the main readable text content.
// Prefers DOM-based parsing when available, with safe fallbacks.
async function extractReadableEmailContent(html) {
  if (!html || typeof html !== "string") return "";
  try {
    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      // Remove non-content and noisy nodes
      const removeSelectors = [
        "script", "style", "noscript", "template", "svg", "math",
        "iframe", "object", "embed", "canvas", "form",
        "nav", "header", "footer", "aside",
        // quoted replies and forwards
        "blockquote", "blockquote[type=cite]",
        ".gmail_quote", "#gmail_quote", ".moz-cite-prefix", "#isForwardContent", "#isReplyContent",
        // common signatures
        ".moz-signature", ".gmail_signature", "div.Signature", "div.signature"
      ];
      for (const sel of removeSelectors) {
        for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();
      }
      // Heuristic removal by role/class/id for typical boilerplate
  const noisyMatch = /banner|nav|menu|footer|header|sidebar|aside|ads?|advert|promo|sponsor|social|unsubscribe|preferences|manage\s+preferences|disclaimer|legal|copyright|tracking|view\s+in\s+browser/i;
      for (const el of Array.from(doc.querySelectorAll("*[role], *[class], *[id]"))) {
        const sig = `${el.getAttribute("role") || ""} ${el.className || ""} ${el.id || ""}`;
        if (noisyMatch.test(sig)) el.remove();
      }

      // Normalize links: keep text and URL if helpful
      const absolutize = (url) => {
        try { return new URL(url, doc.baseURI || "about:blank").href; } catch { return url; }
      };

      // Walk and build plain text with structural hints
      const pieces = [];
      const push = (s) => { if (s) pieces.push(s); };
      const isBlock = (el) => {
        const tag = (el.tagName || "").toLowerCase();
        return [
          "p","div","section","article","main","ul","ol","li",
          "h1","h2","h3","h4","h5","h6","pre","table","tr","td","th"
        ].includes(tag);
      };
      const visit = (node) => {
        if (!node) return;
        if (node.nodeType === 3) { // text
          const t = node.nodeValue.replace(/\s+/g, " ");
          if (t.trim()) push(t);
          return;
        }
        if (node.nodeType !== 1) return; // element
        const el = node;
        const tag = el.tagName.toLowerCase();
        // Skip hidden
        const style = el.getAttribute("style") || "";
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return;
        if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return;

        // Block-level spacing
        if (["h1","h2","h3","h4","h5","h6"].includes(tag)) push("\n\n");
        if (tag === "li") push("\n- ");
        if (["p","div","section","article","main"].includes(tag)) push("\n\n");
        if (tag === "br") { push("\n"); return; }

        if (tag === "a") {
          const href = el.getAttribute("href") || "";
          const beforeLen = pieces.length;
          for (const child of Array.from(el.childNodes)) visit(child);
          const text = pieces.slice(beforeLen).join("").trim();
          const url = href && !/^\s*(javascript:|mailto:|tel:)/i.test(href) ? absolutize(href) : "";
          if (url && text && !text.includes(url)) push(` (${url})`);
          return;
        }
        if (tag === "img") {
          const alt = el.getAttribute("alt");
          if (alt && alt.trim()) push(` [${alt.trim()}] `);
          return;
        }
        if (tag === "table") {
          // Rough table -> lines
          for (const tr of Array.from(el.querySelectorAll("tr"))) {
            const cells = Array.from(tr.querySelectorAll("th,td")).map(td => td.textContent.trim()).filter(Boolean);
            if (cells.length) push("\n" + cells.join(" | "));
          }
          push("\n");
          return;
        }
        if (tag === "pre" || tag === "code") {
          push("\n\n" + el.textContent.replace(/\s+$/g, "") + "\n\n");
          return;
        }

        for (const child of Array.from(el.childNodes)) visit(child);
      };
      visit(doc.body || doc.documentElement);

  let text = pieces.join("");
  text = postProcessPlainEmailText(text);
  if (text.trim()) return text.length > 120000 ? text.slice(0, 120000) : text;
    }
  } catch {}

  // Fallback: regex-based stripping
  try {
    let t = html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " ")
      .replace(/<(?:nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>(?=\s*<br\s*\/?>(?:\s*<br\s*\/?>)?)/gi, "\n")
      .replace(/<br\s*\/?>(?!\n)/gi, "\n")
      .replace(/<\/(?:p|div)>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\n\s+/g, "\n");
    t = postProcessPlainEmailText(t);
    return t;
  } catch {}
  return html;
}

function postProcessPlainEmailText(text) {
  if (!text) return "";
  let out = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Drop common boilerplate lines
  const dropRe = /(unsubscribe|manage\s+preferences|view\s+in\s+browser|privacy\s+policy|terms\s+of\s+service|do\s+not\s+reply|confidentiality\s+notice|copyright\s+\d{4}|all\s+rights\s+reserved|click\s+here\s+to\s+unsubscribe)/i;
  const lines = out.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l) { kept.push(""); continue; }
    if (dropRe.test(l)) continue;
  // Filter very long tracking-like URLs-only lines
  if (/^https?:\/\//i.test(l) && l.length > 200) continue;
  // Drop common reply headers
  if (/^on\s+\w{3},?\s+\w{3}\s+\d{1,2},\s+\d{4}.*wrote:$/i.test(l)) continue;
  if (/^(from|sent|to|subject):/i.test(l)) continue;
    kept.push(l);
  }
  // Remove leading/trailing empties after filtering
  while (kept.length && !kept[0]) kept.shift();
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return kept.join("\n");
}
