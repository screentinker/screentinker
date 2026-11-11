// Nothing runs here by itself. lib/stream-out.js asks this worker (over the browser's debugging
// channel) for a capture id of the renderer's own tab: chrome.tabCapture hands the tab's picture to
// the page inside it without the "Sharing this tab" bar that getDisplayMedia draws over the picture.
self.stTabId = async () => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => /\/stream-render\//.test(t.url || '')) || tabs[0];
  return new Promise((resolve, reject) => chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: tab.id }, (id) => (id ? resolve(id) : reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no capture id')))));
};
