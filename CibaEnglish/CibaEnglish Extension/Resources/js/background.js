// ===== Service Worker =====
// 接收 content script / popup 的消息，统一处理需要 tabs / storage 特权的操作
// （content script 没 tabs 权限，必须经 service worker 中转）

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  if (msg.action === 'appleLoginStart') {
    // 1. 写 relay 到 storage（让 apple_login_bridge.js 在登录页消费）
    if (msg.relay) {
      chrome.storage.local.set({ pending_apple_relay: msg.relay });
    }
    // 2. 创建新 tab 打开 Apple 登录页
    if (msg.url) {
      chrome.tabs.create({ url: msg.url });
    }
    sendResponse({ ok: true });
    return false; // 同步响应，channel 可以关
  }

  return false;
});
