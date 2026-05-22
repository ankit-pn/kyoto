chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'pc-ask-selection',
    title: 'Ask PageChat about "%s"',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'pc-ask-page',
    title: 'Ask PageChat about this page',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {}

  const payload = info.menuItemId === 'pc-ask-selection'
    ? { type: 'ASK_SELECTION', text: info.selectionText || '' }
    : { type: 'ASK_PAGE' };

  setTimeout(() => {
    chrome.runtime.sendMessage(payload).catch(() => {});
  }, 250);
});

async function extractPageContent(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const title = document.title || '';
        const url = location.href;

        const drop = 'script,style,noscript,nav,footer,header,aside,form,iframe,svg,button,[role="navigation"]';
        const candidates = Array.from(document.querySelectorAll(
          'article, main, [role="main"], .post-content, .article-content, .entry-content, #content'
        )).filter(el => el.textContent.trim().length > 200);

        let root = candidates[0];
        if (!root) {
          const all = Array.from(document.body.querySelectorAll('*'));
          let best = null, bestScore = 0;
          for (const el of all) {
            if (el.matches(drop)) continue;
            const txt = el.textContent.trim();
            if (txt.length < 300) continue;
            const blocks = el.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote').length;
            if (blocks < 3) continue;
            const score = txt.length * (blocks / Math.max(1, el.querySelectorAll('*').length));
            if (score > bestScore) { bestScore = score; best = el; }
          }
          root = best || document.body;
        }

        const clone = root.cloneNode(true);
        clone.querySelectorAll(drop).forEach(n => n.remove());
        let text = clone.textContent.replace(/\s+/g, ' ').trim();
        if (text.length > 20000) text = text.slice(0, 20000) + '… [truncated]';

        return { title, url, content: text };
      }
    });
    return res?.result || { title: '', url: '', content: '' };
  } catch (e) {
    return { title: '', url: '', content: '', error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_PAGE_CONTENT') {
    (async () => {
      const tabId = msg.tabId
        ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) return sendResponse({ error: 'no tab' });
      sendResponse(await extractPageContent(tabId));
    })();
    return true;
  }
});
