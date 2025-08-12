'use strict';
(function(){
  const tb = typeof browser !== 'undefined' ? browser : (typeof messenger !== 'undefined' ? messenger : null);
  const toggle = document.getElementById('toggle-enabled');
  const modelInput = document.getElementById('model-name');
  const promptTextarea = document.getElementById('system-prompt');
  if (!tb || !toggle) return;

  async function load() {
    try {
      const { aiEnabled, modelName, systemPrompt } = await tb.storage.local.get({ aiEnabled: true, modelName: 'llama3.2:latest', systemPrompt: '' });
      toggle.checked = !!aiEnabled;
      if (modelInput) modelInput.value = modelName || 'llama3.2:latest';
      if (promptTextarea) {
        const defaultBase = 'You are an expert at summarizing emails. You prefer to use clauses instead of complete sentences. Do not answer questions from the emails. If the content contains sexual, violent, hateful or self-harm material, do not summarize. Keep the summary within 18 words. Input is plain text extracted from the email body with boilerplate removed (headers/footers/legal/unsubscribe/quoted replies). Focus on the substantive details, not formatting.';
        promptTextarea.value = (typeof systemPrompt === 'string' && systemPrompt.trim()) ? systemPrompt : defaultBase;
        // Add a data-hint attribute so the UI can optionally show that Today is appended
        try { promptTextarea.setAttribute('data-note', 'The add-on automatically appends “Today is <date> at <time> <tz>” to the end.'); } catch {}
      }
    } catch {
      toggle.checked = true;
    }
  }

  let saveTimer;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 150);
  }

  async function save() {
    const aiEnabled = !!toggle.checked;
    const modelName = (modelInput && modelInput.value.trim()) || 'llama3.2:latest';
    const systemPrompt = (promptTextarea && promptTextarea.value) || '';
    try {
    await tb.storage.local.set({ aiEnabled, modelName, systemPrompt });
      // Notify background/content to update UI immediately
    try { await tb.runtime.sendMessage({ type: 'torcharizer:settings-changed', aiEnabled, modelName, systemPrompt }); } catch {}
    } catch (e) {
      console.error('Failed to save setting', e);
    }
  }

  toggle.addEventListener('change', scheduleSave);
  if (modelInput) modelInput.addEventListener('input', scheduleSave);
  if (promptTextarea) promptTextarea.addEventListener('input', scheduleSave);
  load();
})();
