var server_api = 'https://cibaen.com/api'
var finalToken = ''
var qrcodeKey = ''
var refreshTimer = null
var PRIVACY_KEY = "privacyAgreed"  // 🆕 隐私同意 storage key
var appleLoginEnabledCached = false  // 🆕 Apple 登录开关缓存：登录态切换时供 refreshAppleLoginBtn 重新计算可见性

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
          // 同意后：隐藏告知条，恢复登录卡可见，走完整初始化
          // （initApp 含二维码 / 密码登录 / Apple 登录 / 重登按钮 / 禁用开关等全部逻辑，
          //   否则首次会话这些都不会执行——Apple 按钮不显示的根因）
          notice.style.display = "none";
          document.getElementById("not_logged").classList.remove("hide");
          initApp();
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
  // 配置来源：content script 在 cibaen.com 页面 fetch 同源资源后写入 chrome.storage
  // （这样 popup 不需要向 Safari 申请 cibaen.com 的 host 权限——cbaen.com 完全不出现在 manifest 里）
  // 未访问过 cibaen.com 时 storage 为空，使用 fail-open 默认值（Apple 按钮显示、密码登录区隐藏）
  chrome.storage.local.get('ciba_client_config', function (result) {
    var config = result && result.ciba_client_config || { appleLoginEnabled: true, reviewLoginEnabled: false };
    if (config.reviewLoginEnabled) {
      document.getElementById('password-login-section').style.display = 'flex';
      setupPasswordLogin();
    } else {
      document.getElementById('password-login-section').style.display = 'none';
    }
    // Apple 登录：仅 Safari 扩展 + 服务端开关同时满足才显示
    setupAppleLogin(!!config.appleLoginEnabled);
  });

  document.getElementById('relogin').addEventListener('click', () => {
    finalToken = ''
    qrcodeKey = ''
    stopRefreshQrCode()
    fetchQrCodeKey()
    document.getElementById("logged").classList.add("hide");
    document.getElementById("not_logged").classList.remove("hide");
    chrome.storage.local.remove('ciba_token', function(){});
    refreshAppleLoginBtn()  // 🆕 切回未登录后恢复 Apple 按钮可见
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
  refreshAppleLoginBtn()  // 🆕 切到已登录后隐藏 Apple 按钮
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
  // 🆕 仅缓存开关，刷新由 refreshAppleLoginBtn 完成；这样 handleQrcode / relogin / onChanged
  // 三个登录态切换点都能复用同一份可见性逻辑，避免 initApp 里 config 与 token 两个异步
  // 任务完成顺序不确定导致 Apple 按钮残留显示
  appleLoginEnabledCached = !!appleLoginEnabled;
  refreshAppleLoginBtn();
}

function refreshAppleLoginBtn() {
  var btn = document.getElementById('apple-login-btn');
  if (!btn) return;
  // 仅在 Safari 扩展 + 开关开启 + 当前未登录时显示（已登录态下按钮与"已登录"卡独立，保持隐藏）
  var notLoggedEl = document.getElementById('not_logged');
  var isCurrentlyNotLogged = notLoggedEl && !notLoggedEl.classList.contains('hide');
  if (appleLoginEnabledCached && isSafariExt() && isCurrentlyNotLogged) {
    btn.style.display = 'flex';
    if (!btn._appleBound) {
      btn.addEventListener('click', startAppleLogin);
      btn._appleBound = true;
    }
    // 不再调用 checkAppleBridgeReachable()：去掉所有 cibaen.com host 权限后，
    // chrome.tabs.sendMessage 到 cibaen.com 标签必然失败，ping 永远超时，会误报红条。
    // 登录是否成功由 chrome.storage.onChanged 监听 ciba_token 变化来兜底，更可靠。
  } else {
    btn.style.display = 'none';
  }
}

// ===== Apple 登录入口（Safari）=====

// ===== Apple 登录入口（Safari）=====
// 零 host 权限方案：cibaen.com 完全不在 host_permissions / optional_host_permissions 里。
// bridge 靠 content_scripts matches 自动注入；popup 创建 tab 用 chrome.tabs.create
// （不需要 host 权限）；popup 通过 chrome.storage.onChanged 监听 ciba_token 变化来识别登录。
// 因此用户全程不会遇到任何授权提示，体验与 Immersive Translate 一致。
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

// 🆕 监听 ciba_token 变化：跨 tab 登录、Apple 登录异步写入、被其他组件 clear 等场景下，
// 同步 popup 的登录态与 Apple 按钮可见性（之前 initApp 里那段注释承诺了此兜底，但实际未实现）
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (!changes.ciba_token) return;
  var newVal = changes.ciba_token.newValue;
  if (newVal) {
    handleQrcode(newVal);
  } else {
    // token 被清空：切回未登录态
    finalToken = '';
    document.getElementById("logged").classList.add("hide");
    document.getElementById("not_logged").classList.remove("hide");
    stopRefreshQrCode();
    fetchQrCodeKey();
  }
});