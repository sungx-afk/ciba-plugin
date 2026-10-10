// ===== Apple 登录回调桥（专用 content script，只挂在 cibaen.com/apple-login* 页面）=====
// 方案 1 的"承接者"：popup 打开登录页后会因失焦关闭，本脚本随登录页存活，
// 负责在登录完成后把自家 token 写回扩展 storage。
//
// ── 与登录页的协议（后端/登录页实现方需遵守其中任意一种）──────────────
//   方式 A（推荐，前端 JS 主动通知）：
//     登录成功后页面执行
//       window.postMessage({
//         source: 'ciba-apple-login',
//         token: '<cibaen 自家 token>',
//         relay: '<URL 上的 relay 参数，可选>'
//       }, location.origin)
//   方式 B（兜底，服务端渲染 meta 标签）：
//     页面输出 <meta name="ciba-apple-token" content="<cibaen 自家 token>">
//
// ── 扩展侧行为 ──────────────────────────────────────────────────────
//   收到 token 后写入 chrome.storage.local.ciba_token（与微信/账号密码登录同一 key），
//   清除 pending_apple_relay，并向页面回执：
//       window.postMessage({ source: 'ciba-apple-login-ack', ok: true }, location.origin)
//   登录页收到 ack 后可展示"登录成功，请关闭本页并重新打开扩展"。
(function () {
  var ALLOWED_ORIGINS = ['https://cibaen.com', 'https://www.cibaen.com'];
  var done = false;
  console.log('[ciba-bridge] 注入, href=', location.href, 'origin=', location.origin);

  function saveToken(token) {
    if (done || !token) { console.log('[ciba-bridge] saveToken 跳过, done=', done, 'token 空=', !token); return; }
    done = true;
    console.log('[ciba-bridge] 准备写入 storage, token 长度=', (token || '').length);
    try {
      chrome.storage.local.set({ ciba_token: token }, function () {
        var err = chrome.runtime.lastError;
        console.log('[ciba-bridge] storage.set 完成, lastError=', err && err.message);
        try { chrome.storage.local.remove('pending_apple_relay'); } catch (e) {}
        try {
          window.postMessage({ source: 'ciba-apple-login-ack', ok: true }, window.location.origin);
          console.log('[ciba-bridge] 已回 ack');
        } catch (e) {
          console.log('[ciba-bridge] 回 ack 异常', e);
        }
      });
    } catch (e) {
      console.log('[ciba-bridge] storage.set 同步异常', e);
    }
  }

  // 方式 A：监听页面 postMessage
  window.addEventListener('message', function (e) {
    console.log('[ciba-bridge] 收到 message, origin=', e.origin, 'data=', JSON.stringify(e.data).slice(0, 120));
    if (ALLOWED_ORIGINS.indexOf(e.origin) === -1) {
      console.log('[ciba-bridge] origin 不在白名单, 忽略');
      return;
    }
    var d = e.data;
    if (d && d.source === 'ciba-apple-login' && d.token) saveToken(d.token);
    else console.log('[ciba-bridge] 消息结构不匹配, 期望 source=ciba-apple-login 且有 token');
  });

  // 方式 B：轮询 meta 标签（500ms 一次，最多 5 分钟，覆盖用户慢慢完成登录的场景）
  var pollCount = 0;
  var metaTimer = setInterval(function () {
    if (done || ++pollCount > 600) { clearInterval(metaTimer); return; }
    var meta = document.querySelector('meta[name="ciba-apple-token"]');
    if (meta && meta.content) { clearInterval(metaTimer); saveToken(meta.content); }
  }, 500);

  // 响应 popup 的注入探测：能收到并回执，说明本脚本确实注入到了这个页面
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.action === 'ciba-bridge-ping') {
        sendResponse({ ok: true, from: 'ciba-bridge' });
      }
      return false;
    });
  } catch (e) {
    console.log('[ciba-bridge] onMessage 注册失败', e);
  }
})();
