window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== window || event.origin !== location.origin || message?.source !== "sift-page" || message.type !== "SIFT_EXTRACT_YOUTUBE") return;
  window.postMessage({ source: "sift-browser-helper", type: "SIFT_HELPER_ACK", requestId: message.requestId }, location.origin);
  chrome.runtime.sendMessage({ type: message.type, url: message.url }, (response) => {
    const error = chrome.runtime.lastError?.message || response?.error;
    window.postMessage({
      source: "sift-browser-helper",
      requestId: message.requestId,
      ...(error ? { error } : { payload: response?.payload })
    }, location.origin);
  });
});
