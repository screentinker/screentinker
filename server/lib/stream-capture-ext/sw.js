// The renderer's page (lib/stream-out.js, only ever opened on this machine) asks this worker for a capture id of its
// own tab when screens are to show the stream, and lets it go when they stop: chrome.tabCapture hands the tab's
// picture to the page inside it without the "Sharing this tab" bar that getDisplayMedia draws over the picture.
// Asking by message also wakes the worker, which the browser puts to sleep when idle.
const captureId = (tabId) => new Promise((resolve, reject) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId, consumerTabId: tabId }, (id) => (id ? resolve(id) : reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no capture id')))));
self.stTabId = async () => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => /\/stream-render\//.test(t.url || '')) || tabs[0];
  return captureId(tab.id);
};
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (!msg || msg.want !== 'capture' || !sender.tab || !/\/stream-render\//.test(sender.url || '')) { reply({ error: 'not asked for' }); return false; }
  captureId(sender.tab.id).then((id) => reply({ id }), (e) => reply({ error: String(e && e.message || e) }));
  return true;
});
