// Inject a visible summary section directly into the email view and fetch summary on load.
(function () {
  // Only run in Thunderbird message display documents. Those are moz-extension injected into about:message and similar.
  // Basic guard: avoid running in top-level chrome pages or duplicate frames.
  if (window.__torcharizerInit__) { try { console.log("torcharizer content script already initialized"); } catch {}; return; }
  window.__torcharizerInit__ = true;
  try { console.log("torcharizer content script loaded"); } catch {}
  function bgLog(...args) {
    try {
  (typeof browser !== 'undefined' ? browser : messenger)?.runtime?.sendMessage({ type: "torcharizer:log", args: args.map(String) });
    } catch {}
  }
  bgLog("content: loaded at", new Date().toISOString());
  const tb = typeof browser !== "undefined" ? browser : (typeof messenger !== "undefined" ? messenger : null);
  if (!tb) return;

  // State
  let aiEnabled = true;

  // Create or return the host container (isolated as much as possible from email CSS)
  function ensurePanel() {
  let panel = document.getElementById("torcharizer-panel");
    if (panel) return panel;

    panel = document.createElement("div");
  panel.id = "torcharizer-panel";
  panel.setAttribute(
      "style",
      [
        // Try to isolate from mail content CSS
        "all: initial",
        "box-sizing: border-box",
        "display: block",
        // Spacing and visuals
    // Add comfortable space on left/right sides
    "margin: 10px 8px 14px 8px",
        "padding: 12px 14px",
        "border: 1px solid #1f2937",
        "border-radius: 10px",
        "background: #0f172a",
        "color: #e5e7eb",
        "font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji'",
        "line-height: 1.5",
        "box-shadow: 0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.02)"
      ].join("; ")
    );

  const header = document.createElement('div');
  header.id = 'torcharizer-header';
  header.setAttribute('style', "all: initial; display:flex; align-items:center; gap:8px; margin-bottom:6px; font: 600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial; color:#e5e7eb;");
  const iconSlot = document.createElement('span');
  iconSlot.id = 'torcharizer-icon-slot';
  iconSlot.setAttribute('style', 'all: initial; width:22px; height:22px; display:inline-block; border-radius:6px; background:#1e293b; box-shadow:0 2px 6px rgba(0,0,0,0.4);');
  const title = document.createElement('div');
  title.setAttribute('style', "all: initial; font: 600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial; color:#e5e7eb;");
  title.textContent = 'Summary';
  header.appendChild(iconSlot);
  header.appendChild(title);
  panel.appendChild(header);
  const contentDiv = document.createElement('div');
  contentDiv.id = 'torcharizer-content';
  contentDiv.setAttribute('style', "all: initial; white-space:pre-wrap; color:#e5e7eb; font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial;");
  panel.appendChild(contentDiv);

    // Programmatically insert the icon image (runtime URL sometimes resolves better this way in message display docs)
    try {
      const iconSlot = panel.querySelector('#torcharizer-icon-slot');
      if (iconSlot) {
        const img = document.createElement('img');
        try { img.src = tb.runtime.getURL('icons/icon-32.png'); }
        catch { img.src = 'icons/icon-32.png'; }
        img.alt = 'Torcharizer';
        img.setAttribute('style', 'all: initial; width:22px; height:22px; display:inline-block; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,0.45); image-rendering:auto;');
        iconSlot.replaceWith(img);
      }
    } catch (e) { bgLog('content: icon inject failed', (e && e.message) || String(e)); }

  const container = document.body || document.documentElement;
  if (container?.firstChild) container.insertBefore(panel, container.firstChild);
  else if (container) container.appendChild(panel);
  bgLog("content: panel ensured");
  return panel;
  }

  function renderMarkdownToHtml(md) {
    // Minimal, safer Markdown to HTML (escape then format)
    if (!md) return "";
    const esc = (s) => s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
    // Emphasize the Today heading if present
    let txt = md.replace(/^\s*##\s*Today\s*$/gim, "## Today");
    let html = esc(txt)
      .replace(/^######\s+(.+)$/gim, '<h6>$1</h6>')
      .replace(/^#####\s+(.+)$/gim, '<h5>$1</h5>')
      .replace(/^####\s+(.+)$/gim, '<h4>$1</h4>')
      .replace(/^###\s+(.+)$/gim, '<h3>$1</h3>')
      .replace(/^##\s+Today\s*$/gim, '<h2 style="background:linear-gradient(135deg,#1e293b,#0ea5e9); color:#e5e7eb; padding:6px 8px; border-radius:6px; display:inline-block;">Today</h2>')
      .replace(/^##\s+(.+)$/gim, '<h2>$1</h2>')
      .replace(/^#\s+(.+)$/gim, '<h1>$1</h1>')
      // List handling: group consecutive list items
      .replace(/^(\s*[-*]\s+.+(?:\r?\n\s*[-*]\s+.+)*)/gim, (m) => {
        const items = m.split(/\r?\n/).map(l => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
        return '<ul>' + items.map(i => `<li>${i}</li>`).join('') + '</ul>';
      })
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener" style="color:#93c5fd; text-decoration:underline;">$1<\/a>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    // Merge adjacent ULs created by grouping
    html = html.replace(/<\/ul>\s*<ul>/g, '');
    return `<p style=\"all: initial; font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial; color:#e5e7eb;\">${html}</p>`;
  }

  function setSummary(text, done) {
    const host = ensurePanel();
  const content = host && host.querySelector('#torcharizer-content');
    if (content) {
      const safe = (text || "(no summary)");
      try {
        const htmlString = renderMarkdownToHtml(safe);
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        const frag = document.createDocumentFragment();
        Array.from(doc.body.childNodes).forEach(n => frag.appendChild(n));
        content.replaceChildren(frag);
      } catch (e) {
        content.textContent = safe;
      }
      content.style.opacity = done ? "1" : (text ? "0.98" : "0.8");
      bgLog("content: setSummary length", String((text||"").length));
    }
  }

  function hidePanel() {
    const el = document.getElementById('torcharizer-panel');
    if (el) el.remove();
  }

  // Listen for background push updates and pings.
  tb.runtime?.onMessage?.addListener((msg) => {
    if (!msg) return;
  if (msg.type === "torcharizer:update") {
      if (!aiEnabled) { hidePanel(); return; }
      setSummary(msg.summary || "(no summary)", !!msg.done);
  } else if (msg.type === "torcharizer:ping") {
      try { return Promise.resolve({ ok: true }); } catch {}
  } else if (msg.type === 'torcharizer:settings-changed') {
      aiEnabled = !!msg.aiEnabled;
      if (!aiEnabled) {
        hidePanel();
      } else {
        // Recreate and request if enabled again
        try { ensurePanel(); requestSummary(); } catch {}
      }
    }
  });

  // Test banner removed; we rely on the summary panel for visible injection.

  // Helper: request summary from background without needing privileged APIs.
  async function requestSummary() {
    if (!aiEnabled) { hidePanel(); return; }
    ensurePanel();
    try { await tb.runtime.sendMessage({ type: "torcharizer:ping" }); bgLog("content: ping ok"); } catch { bgLog("content: ping failed"); }
    try {
      const resp = await tb.runtime.sendMessage({ type: "torcharizer:request" });
      bgLog("content: request responded keys", resp ? Object.keys(resp).join(",") : "<no resp>");
      if (resp && typeof resp.summary === "string") setSummary(resp.summary, true);
      else setSummary("Generating summary…", false);
    } catch { bgLog("content: request failed"); setSummary("Generating summary…", false); }
  }

  // Initial creation: insert panel and request summary shortly after DOM begins.
  // Load setting and then initialize
  (async () => {
    try {
      const { aiEnabled: stored } = await tb.storage?.local?.get?.({ aiEnabled: true }) || { aiEnabled: true };
      aiEnabled = stored !== false; // default true
    } catch { aiEnabled = true; }
    setTimeout(() => { try { if (aiEnabled) { ensurePanel(); requestSummary(); } } catch {} }, 50);
  })();
  bgLog("content: initial wiring done");

  // Keep panel present even if message view rerenders.
  const mo = new MutationObserver(() => {
    if (!aiEnabled) { hidePanel(); return; }
  if (!document.getElementById("torcharizer-panel")) {
      ensurePanel();
      requestSummary();
    }
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });

  setTimeout(() => { if (aiEnabled) requestSummary(); }, 400);
  setTimeout(() => { if (aiEnabled) requestSummary(); }, 1200);
  bgLog("content: observers and timers set");
})();
