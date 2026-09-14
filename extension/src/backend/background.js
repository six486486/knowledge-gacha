importScripts("./provider/provider-transport.js");

function enableActionOpen() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enableActionOpen);
chrome.runtime.onStartup.addListener(enableActionOpen);
enableActionOpen();

const providerHandler = KnowledgeGachaProviderTransport.createBackgroundMessageHandler({
  extensionId: chrome.runtime.id
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== KnowledgeGachaProviderTransport.MESSAGE_TYPE) return false;
  providerHandler(message, sender).then(sendResponse, function (error) {
    sendResponse({ ok: false, error: { code: "MODEL_REQUEST_FAILED", message: error.message || "模型请求失败" } });
  });
  return true;
});
