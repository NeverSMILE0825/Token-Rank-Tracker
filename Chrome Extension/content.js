window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "find-rank-page") return;
  chrome.runtime.sendMessage(data).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  window.postMessage({ source: "find-rank-ext", message }, "*");
  sendResponse({ ok: true });
});

chrome.runtime.sendMessage({ source: "find-rank-content", type: "ready" }).catch(() => {});
