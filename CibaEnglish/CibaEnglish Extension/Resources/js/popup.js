var server_api = 'https://cibaen.com/api'
var finalToken = ''
var qrcodeKey = ''
var refreshTimer = null
var PRIVACY_KEY = "privacyAgreed"  // 🆕 隐私同意 storage key

function getLocalToken(){
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('ciba_token', (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  // 🆕 隐私同意检查（未同意时只显示告知条，不执行后续逻辑）
  var notice = document.getElementById("privacy-notice");
  chrome.storage.local.get(PRIVACY_KEY, function(result) {
    if (!result[PRIVACY_KEY]) {
      // 未同意：显示告知条，隐藏两个功能 card（用 class 与原有 .hide 体系统一）
      notice.style.display = "block";
      document.getElementById("not_logged").classList.add("hide");
      document.getElementById("logged").classList.add("hide");

      var checkbox = document.getElementById("privacy-agree-checkbox");
      var btn = document.getElementById("privacy-agree-btn");
      checkbox.addEventListener("change", function() {
        btn.disabled = !checkbox.checked;
      });
      btn.addEventListener("click", function() {
        if (!checkbox.checked) return;
        chrome.storage.local.set({[PRIVACY_KEY]: true}, function() {
          // 同意后：隐藏告知条，按当前登录状态显示对应 card
          notice.style.display = "none";
          getLocalToken().then(function(value) {
            if (value && value.ciba_token) {
              // 已有 token：显示已登录卡
              document.getElementById("logged").classList.remove("hide");
              handleQrcode(value.ciba_token);
            } else {
              // 未登录：显示二维码登录卡，并拉取二维码
              document.getElementById("not_logged").classList.remove("hide");
              fetchQrCodeKey();
            }
          });
        });
      });
      return; // 🆕 未同意，不往下执行
    }

    // 已同意：隐藏告知条，正常执行
    notice.style.display = "none";
    initApp();
  });
});

// 🆕 原有初始化逻辑原封不动移到这里
function initApp() {
  // ===== 新增：初始化“在此网站禁用”开关（最少改动，一行调用）=====
  initDisableToggle();

  getLocalToken().then((value)=>{
    if (value && value.ciba_token){
      handleQrcode(value.ciba_token)
    }else{
      fetchQrCodeKey()
    }
  })
  fetch('https://cibaen.com/client-config.json')  // 返回 { "reviewLoginEnabled": true/false, "appleLoginEnabled": true/false }
  .then(r => r.json())
  .then(config => {
    if (config.reviewLoginEnabled) {
      document.getElementById('password-login-section').style.display = 'flex';
      setupPasswordLogin();
    } else {
      document.getElementById('password-login-section').style.display = 'none';
    }
    // Apple 登录：仅 Safari 扩展 + 服务端开关同时满足才显示
    setupAppleLogin(!!config.appleLoginEnabled);
  })
  .catch(() => {
    // 配置拉取失败：Safari 上 fail-open 照常显示（App Store 审核要求 Apple 登录常显），Chrome 不显示
    setupAppleLogin(true);
  });

  document.getElementById('relogin').addEventListener('click', () => {
    finalToken = ''
    qrcodeKey = ''
    stopRefreshQrCode()
    fetchQrCodeKey()
    document.getElementById("logged").classList.add("hide");
    document.getElementById("not_logged").classList.remove("hide");
    chrome.storage.local.remove('ciba_token', function(){});
  })
}

// ===== 新增函数：在此网站禁用（追加在文件末尾，不改动上面任何代码）=====
function initDisableToggle() {
  var toggle = document.getElementById('disableToggle');
  var siteNameEl = document.getElementById('currentSiteName');
  if (!toggle || !siteNameEl) return;

  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (!tabs || !tabs[0] || !tabs[0].url) return;

    var hostname = '';
    try { hostname = new URL(tabs[0].url).hostname; } catch(e) { return; }
    if (!hostname) return;

    siteNameEl.textContent = hostname;

    chrome.storage.local.get('disabledSites', function(result) {
      var disabledSites = result.disabledSites || [];
      // ☑ 在黑名单里 → 开关打开（表示“已禁用”）
      toggle.checked = disabledSites.indexOf(hostname) !== -1;

      toggle.addEventListener('change', function() {
        chrome.storage.local.get('disabledSites', function(res) {
          var sites = res.disabledSites || [];
          if (toggle.checked) {
            // 打开开关 → 加入黑名单
            if (sites.indexOf(hostname) === -1) sites.push(hostname);
          } else {
            // 关闭开关 → 移出黑名单
            sites = sites.filter(function(s) { return s !== hostname; });
          }
          chrome.storage.local.set({ disabledSites: sites }, function() {
            chrome.tabs.reload(tabs[0].id);  // 刷新让 content script 生效
          });
        });
      });
    });
  });
}
// ===================================================================

function fetchQrCodeKey(){
  let xhr = new XMLHttpRequest();
  xhr.open("GET", `${server_api}/wechat/service/follow_qrcode/reg.json`, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState == 4) {
      let resp = JSON.parse(xhr.responseText);
      if (resp && resp.result == 0){
        handleQrcodeKey(resp)
      }else{
        let errorMsg = resp.ex && resp.ex.msg || resp.msg || "发生错误，请稍后重试"
        alert(errorMsg)
      }
    }
  }
  xhr.send();
}
function handleQrcodeKey(data){
  qrcodeKey = data.key
  document.getElementById("qrcode").src = data.url;
  document.getElementById("qrcode").classList.remove("hide");
  refreshTimer = setInterval(()=>{
    checkQrCode()
  },2000)
}
function checkQrCode(){
  if (!qrcodeKey){
    return
  }
  let xhr = new XMLHttpRequest();
  xhr.open("GET", `${server_api}/wechat/service/follow_qrcode/reg/result.json?key=${qrcodeKey}`, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState == 4) {
      let resp = JSON.parse(xhr.responseText);
      if (resp && resp.result == 0 && resp.token){
        let token = resp.token
        chrome.storage.local.set({ 'ciba_token': token }, function(){});
        handleQrcode(token)
      }else{
        
      }
    }
  }
  xhr.send();
}

function handleQrcode(token){
  finalToken = token
  document.getElementById("ciba_main").href = `https://cibaen.com/ciba-pc/index.html#/login?token=${finalToken}`
  document.getElementById("not_logged").classList.add("hide");
  document.getElementById("logged").classList.remove("hide");
  stopRefreshQrCode()
}

function stopRefreshQrCode() {
  if (refreshTimer){
     clearInterval(refreshTimer)
  }
}

// ===== 通过 Apple 登录（仅 Safari）：打开 cibaen.com 托管页完成登录 =====
// Safari 里 chrome.runtime.getURL 的前缀是 safari-web-extension://，Chrome 是 chrome-extension://
function isSafariExt() {
  try { return chrome.runtime.getURL('').indexOf('safari-web-extension://') === 0; } catch (e) { return false; }
}

function setupAppleLogin(appleLoginEnabled) {
  var btn = document.getElementById('apple-login-btn');
  if (!btn) return;
  // 仅在 Safari 扩展 + 开关开启 + 当前未登录时显示（已登录态下按钮与"已登录"卡独立，保持隐藏）
  var notLoggedEl = document.getElementById('not_logged');
  var isCurrentlyNotLogged = notLoggedEl && !notLoggedEl.classList.contains('hide');
  if (appleLoginEnabled && isSafariExt() && isCurrentlyNotLogged) {
    btn.style.display = 'flex';
    if (!btn._appleBound) {
      btn.addEventListener('click', startAppleLogin);
      btn._appleBound = true;
    }
    // 权限诊断：Safari 没有 API 能查"网站访问权限"（chrome.permissions.contains 只反映
    // manifest 声明，不代表用户在偏好设置里的 per-site 授权）。改用实际注入结果反推：
    // 向已存在的 cibaen.com 标签页的 bridge 发 ping，无响应则判定无权限。
    checkAppleBridgeReachable();
  } else {
    btn.style.display = 'none';
  }
}

// 探测扩展对 cibaen.com 是否真的生效（能不能注入 content script）。
// 有 cibaen.com/apple-login 标签页时才可判断；没有标签页则无从判断，保持静默不误报。
//
// 注意两处 Safari 行为，决定了这里不能用 tabs.query 的 url 过滤：
//   1) 站点访问被拒时，url 过滤可能直接匹配不到该标签页 → 会静默失效（正是最该报警的场景）
//   2) 目标页没有 content script 时，sendMessage 可能同步抛错 → 后面的 setTimeout 就注册不上
// 因此改为：取全部标签页自行按 URL 过滤；先注册超时再发 ping；sendMessage 包 try/catch。
function checkAppleBridgeReachable() {
  if (!chrome.tabs || !chrome.tabs.query || !chrome.tabs.sendMessage) return;
  function showWarn() {
    var warn = document.getElementById('apple-permission-warning');
    if (warn) warn.style.display = 'block';
  }
  chrome.tabs.query({}, function (tabs) {
    var targets = (tabs || []).filter(function (t) {
      return typeof t.url === 'string' && /^https:\/\/(www\.)?cibaen\.com\/apple-login/.test(t.url);
    });
    console.log('[ciba-popup] cibaen 登录页标签数 =', targets.length);
    if (!targets.length) return;
    var got = false;
    var timer = setTimeout(function () {
      if (got) return;
      console.log('[ciba-popup] bridge 无响应，显示权限提示条');
      showWarn();
    }, 1200);
    targets.forEach(function (t) {
      try {
        chrome.tabs.sendMessage(t.id, { action: 'ciba-bridge-ping' }, function (resp) {
          if (chrome.runtime.lastError) console.log('[ciba-popup] ping lastError =', chrome.runtime.lastError.message);
          if (resp && resp.ok) { got = true; clearTimeout(timer); }
        });
      } catch (e) {
        console.log('[ciba-popup] ping 同步异常', e);
      }
    });
  });
}

function startAppleLogin() {
  // relay：随机 key，登录页据此向后端关联本次登录
  var relay = '';
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (var i = 0; i < 16; i++) relay += chars.charAt(Math.floor(Math.random() * chars.length));
  // 统一走 service worker 创建 tab（与 video_ocr_content.js 入口保持一致）
  chrome.runtime.sendMessage({
    action: 'appleLoginStart',
    relay: relay,
    url: 'https://cibaen.com/apple-login.html?relay=' + relay
  });
  window.close(); // 打开新标签后 popup 必然失焦，主动关掉更干净
}

// 🆕 账号密码登录逻辑
function setupPasswordLogin() {
  var loginBtn = document.getElementById('login-btn');
  if (!loginBtn) return;

  loginBtn.addEventListener('click', function() {
    var username = document.getElementById('login-username').value.trim();
    var password = document.getElementById('login-password').value.trim();
    var errorEl = document.getElementById('login-error');

    if (!username || !password) {
      errorEl.textContent = '请输入账号和密码';
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = '登录中...';
    errorEl.textContent = '';

    var xhr = new XMLHttpRequest();
    xhr.open("POST", server_api + "/users/login.json", true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function() {
      if (xhr.readyState == 4) {
        loginBtn.disabled = false;
        loginBtn.textContent = '登 录';

        if (xhr.status == 200) {
          var resp = JSON.parse(xhr.responseText);
          if (resp && resp.token) {
            // ✅ 登录成功，复用你现有的 token 流程
            // ✅ 清空输入框
            document.getElementById('login-username').value = '';
            document.getElementById('login-password').value = '';
            chrome.storage.local.set({ 'ciba_token': resp.token }, function() {});
            handleQrcode(resp.token);
          } else {
            errorEl.textContent = (resp && resp.msg) ? resp.msg : '登录失败，请检查账号密码';
          }
        } else {
          errorEl.textContent = '网络错误，请稍后重试';
        }
      }
    };
    xhr.send(JSON.stringify({ loginName: username, password: password }));
  });
}