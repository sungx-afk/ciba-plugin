// ========== 改动 1：把原脚本全部包进 initCibaPlugin 函数 ==========
function initCibaPlugin() {
// 防重复注入守卫：Safari 在扩展更新/重新启用后可能向同一页面再次注入本脚本，
// 旧实例仍在就会双击弹出两个窗口。window 标记防同 world 重注入，
// <html> 上的 data 属性防跨 world / 双扩展注入（DOM 是共享的）。
if (window.__cibaInjected === true || document.documentElement.hasAttribute('data-ciba-injected')) {
  console.log('[ciba] 检测到重复注入，跳过本次初始化');
  return;
}
window.__cibaInjected = true;
document.documentElement.setAttribute('data-ciba-injected', '1');
var server_api = 'https://cibaen.com/api'
var old_server_api = 'https://www.cibaen.com/api'
var ANKI_DATA_SPLIT = `\x1f` //0x1f为anki数据分隔符

var selectedText = "";
var selectedSentence = "";
var iconHoverTimer = null;
var offsetX = 0;
var offsetY = 0;
var isDragging = false;
var refreshTimer = null;
var qrcodeKey = '';
var packList = [];
var modelList = [];
var templateList = [];
var fields = [];

//检测中文字符个数
function detectCnCount(text){
  let chineseCount = 0;
  let len = text.length;

  for (let i = 0; i < len; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      chineseCount++;
    }
  }
  return chineseCount
}

//检测是否是中文
function detectCnLanguage(text) {
  return detectCnCount(text) > 0;
}
//检测是否是英文单词（仅由英文字母组成，支持中划线/撇号连接的单词，不含数字和特殊符号）
function detectEnglishWord(text) {
  if (!text) return false;
  let trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // 仅允许英文字母及中划线/撇号（如 well-known、don't），不允许数字和其他符号
  return /^[A-Za-z]+([-'A-Za-z]+)?$/.test(trimmed);
}
//检测是否是句子
function detectSentence(text){
  // 纯英文单词不认为是句子
  if (detectEnglishWord(text)) {
    return false;
  }
  // 只要包含中文字符（超过1个），就认为是句子
  if (detectCnCount(text) > 1) {
    return true;
  }
  // 非中文情况：包含空格才认为是句子（英文句子）
  return text.search(/\s/) !== -1;
}
//增加判断标识
document.documentElement.setAttribute('data-ciba-plugin-installed', '1');

//微信登录
var wechatLoginLayer = document.createElement("div");
// fixed 锚定视口：页面滚动时浮层始终居中可见（此前用 absolute + 一次性 scrollY/srollX 偏移，
// 滚动后浮层会留在文档上方，用户点到下方单词时看不到登录提示）
wechatLoginLayer.style.position = "fixed";
wechatLoginLayer.style.zIndex = "9999999999";

wechatLoginLayer.style.top = (window.innerHeight - 320) / 2 + "px";
wechatLoginLayer.style.left = (window.innerWidth - 320) / 2 + "px";
wechatLoginLayer.style.width = "320px";
// wechatLoginLayer.style.height = "320px";
wechatLoginLayer.style.flexDirection = "column";
wechatLoginLayer.style.alignItems = "center";
wechatLoginLayer.style.overflow = "hidden";
wechatLoginLayer.style.border = "1px solid rgba(255,255,255,0.1)";
wechatLoginLayer.style.borderRadius = "8px";
wechatLoginLayer.style.padding = "12px";
wechatLoginLayer.style.backgroundColor = "rgba(15,23,42,0.95)";
wechatLoginLayer.style.boxShadow = "0 20px 40px -10px rgba(0,0,0,0.8)";
wechatLoginLayer.style.display = "none";
wechatLoginLayer.style.resize = "none";
document.body.appendChild(wechatLoginLayer);

var wechatLoginHeader = document.createElement("div");
wechatLoginHeader.style.position = "relative";
wechatLoginHeader.style.marginBottom = "12px";
wechatLoginHeader.style.width = "100%";
wechatLoginHeader.style.textAlign = "center";
wechatLoginLayer.appendChild(wechatLoginHeader)

var qrCodeTitle = document.createElement("div");
qrCodeTitle.innerText = "糍粑记忆卡插件"
qrCodeTitle.style.fontSize = "18px";
qrCodeTitle.style.color = "#f8fafc";
qrCodeTitle.style.fontWeight = "bold";
wechatLoginHeader.appendChild(qrCodeTitle)

var wechatLoginCloseBtn = document.createElement("div");
wechatLoginCloseBtn.innerHTML = "×";
wechatLoginCloseBtn.style.position = "absolute";
wechatLoginCloseBtn.style.right = "0";
wechatLoginCloseBtn.style.top = "-6px";
wechatLoginCloseBtn.style.fontSize = "22px";
wechatLoginCloseBtn.style.color = "#94a3b8";
wechatLoginCloseBtn.style.cursor = "pointer";
wechatLoginCloseBtn.style.lineHeight = "1";
wechatLoginCloseBtn.style.padding = "4px";
wechatLoginCloseBtn.title = "关闭";

// 悬停效果
wechatLoginCloseBtn.onmouseenter = function () {
  wechatLoginCloseBtn.style.color = "#f8fafc";
};
wechatLoginCloseBtn.onmouseleave = function () {
  wechatLoginCloseBtn.style.color = "#94a3b8";
};

// 点击关闭逻辑
wechatLoginCloseBtn.onclick = function () {
  closeWechatLoginLayer()
};

wechatLoginHeader.appendChild(wechatLoginCloseBtn);

var qrcodeText = document.createElement("div");
qrcodeText.innerText = "请先微信扫码登录后再使用"
qrcodeText.style.fontSize = "15px";
qrcodeText.style.color = "#f8fafc";
qrcodeText.style.marginBottom = "12px";
wechatLoginLayer.appendChild(qrcodeText)

var qrcodeLayerWrapper = document.createElement("div");
qrcodeLayerWrapper.style.width = "200px";
qrcodeLayerWrapper.style.height = "200px"
wechatLoginLayer.appendChild(qrcodeLayerWrapper);

var qrcodeLayer = document.createElement("img");
qrcodeLayer.style.width = "200px";
qrcodeLayer.style.height = "200px"
qrcodeLayerWrapper.appendChild(qrcodeLayer);

var qrcodeTextTip = document.createElement("div");
qrcodeTextTip.innerText = "温馨提示：登录后使用取词翻译加单词本等功能"
qrcodeTextTip.style.fontSize = "13px";
qrcodeTextTip.style.color = "#94a3b8";
qrcodeTextTip.style.marginTop = "12px";
wechatLoginLayer.appendChild(qrcodeTextTip)

//通过 Apple 登录入口（仅 Safari + appleLoginEnabled 开启时显示，见 refreshAppleLoginBtn）
//样式对齐 popup.css 的 .apple-login-btn
var appleLoginBtn = document.createElement("div");
appleLoginBtn.innerHTML =
  '<svg viewBox="0 0 384 512" aria-hidden="true" style="width:15px;height:15px;fill:#fff;margin-top:-1px;flex-shrink:0;">' +
  '<path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>' +
  '<span>通过 Apple 登录</span>';
appleLoginBtn.style.display = "none";
appleLoginBtn.style.boxSizing = "border-box";
appleLoginBtn.style.width = "100%";
appleLoginBtn.style.marginTop = "14px";
appleLoginBtn.style.padding = "9px 0";
appleLoginBtn.style.borderRadius = "8px";
appleLoginBtn.style.backgroundColor = "#000";
appleLoginBtn.style.color = "#fff";
appleLoginBtn.style.fontSize = "14px";
appleLoginBtn.style.fontWeight = "500";
appleLoginBtn.style.cursor = "pointer";
appleLoginBtn.style.textAlign = "center";
appleLoginBtn.style.userSelect = "none";
appleLoginBtn.style.display = "none";
appleLoginBtn.style.alignItems = "center";
appleLoginBtn.style.justifyContent = "center";
appleLoginBtn.style.gap = "8px";
appleLoginBtn.style.transition = "opacity 0.2s";
appleLoginBtn.onmouseenter = function () { appleLoginBtn.style.opacity = "0.85"; };
appleLoginBtn.onmouseleave = function () { appleLoginBtn.style.opacity = "1"; };
appleLoginBtn.onclick = function () {
  // 统一走 service worker 创建 tab（与 popup / video_ocr_content 入口保持一致）
  var relay = '';
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (var i = 0; i < 16; i++) relay += chars.charAt(Math.floor(Math.random() * chars.length));
  chrome.runtime.sendMessage({
    action: 'appleLoginStart',
    relay: relay,
    url: 'https://cibaen.com/apple-login.html?relay=' + relay
  });
  // 浮层关闭由 storage.onChanged 监听器在 ciba_token 写入时自动触发（见下方 862-866）
};
wechatLoginLayer.appendChild(appleLoginBtn)

//弹出图标
var floatingIcon = document.createElement("img");
var iconUrl = chrome.runtime.getURL("images/icon.png");
floatingIcon.src = iconUrl;
floatingIcon.style.position = "absolute";
floatingIcon.style.zIndex = "9999999999";
floatingIcon.style.display = "none";
floatingIcon.style.width = "28px";
floatingIcon.style.height = "28px";
floatingIcon.style.cursor = "pointer";
floatingIcon.style.transition = "opacity 0.2s linear";
document.body.appendChild(floatingIcon);

//主体窗口
var layerContainer = document.createElement("div");
layerContainer.style.position = "absolute";
layerContainer.style.zIndex = "9999999999";
layerContainer.style.width = "0px";
layerContainer.style.height = "0px";
layerContainer.style.overflow = "hidden";
layerContainer.style.border = "1px solid rgba(56,189,248,0.4)";
layerContainer.style.borderRadius = "8px";
layerContainer.style.backgroundColor = "rgba(15,23,42,0.95)";
layerContainer.style.boxShadow = "0 20px 40px -10px rgba(0,0,0,0.8)";
layerContainer.style.display = "none";
layerContainer.style.resize = "none";
layerContainer.style.transition = "width 0.3s ease, height 0.3s ease";
document.body.appendChild(layerContainer);

//窗口header
var captionBar = document.createElement("div");
captionBar.style.width = "100%";
captionBar.style.height = "48px";
captionBar.style.borderBottom = "1px solid rgba(255,255,255,0.1)";
captionBar.style.borderTopLeftRadius = "8px";
captionBar.style.borderTopRightRadius = "8px";
captionBar.style.background = "rgba(30,41,59,0.9)";
captionBar.style.display = "flex";
captionBar.style.alignItems = "center";
captionBar.style.justifyContent = "space-between";
captionBar.style.cursor = "move";

var captionLeft = document.createElement("div");
captionLeft.style.display = "flex";
captionLeft.style.alignItems = "center";

var captionRight = document.createElement("div");
captionRight.style.display = "flex";
captionRight.style.alignItems = "center";

var captionTitle = document.createElement("span");
captionTitle.innerText = "糍粑记忆插件";
captionTitle.style.marginLeft = "12px";
captionTitle.style.fontFamily = "Arial, sans-serif";
captionTitle.style.fontSize = "14px";
captionTitle.style.color = "#38bdf8";

var closeIcon = document.createElement("div");
closeIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
closeIcon.style.display = "flex";
closeIcon.style.alignItems = "center";
closeIcon.style.justifyContent = "center";
closeIcon.style.width = "28px";
closeIcon.style.height = "28px";
closeIcon.style.marginLeft = "16px";
closeIcon.style.marginRight = "12px";
closeIcon.style.cursor = "pointer";
closeIcon.style.background = "transparent";
closeIcon.style.border = "none";
closeIcon.style.padding = "4px";
closeIcon.style.borderRadius = "6px";
closeIcon.style.transition = "all 0.2s";

// hover 变白（和插件B一致）
closeIcon.onmouseenter = function() {
  this.style.background = "rgba(255,255,255,0.1)";
  this.querySelector("svg").setAttribute("stroke", "#f8fafc");
};
closeIcon.onmouseleave = function() {
  this.style.background = "transparent";
  this.querySelector("svg").setAttribute("stroke", "#94a3b8");
};

captionLeft.appendChild(captionTitle);
captionRight.appendChild(closeIcon);
captionBar.appendChild(captionLeft);
captionBar.appendChild(captionRight);
layerContainer.appendChild(captionBar);

//窗口body
var mainArea = document.createElement("div");
mainArea.style.width = "100%";
mainArea.style.height = "calc(100% - 48px)";
mainArea.style.padding = "16px";
mainArea.style.fontFamily = "Arial, sans-serif";
mainArea.style.fontSize = "13px";
mainArea.style.color = "#f8fafc";
mainArea.style.boxSizing = "border-box";
layerContainer.appendChild(mainArea);

//单词控件
var wordLayer = document.createElement("div");
wordLayer.style.display = "none";
wordLayer.style.width = "100%";
wordLayer.style.height = "100%";
mainArea.appendChild(wordLayer);

var wordDiv = document.createElement("div");
wordDiv.style.height = "28px";
wordDiv.style.lineHeight = "28px";
wordDiv.style.fontSize = "18px";
wordDiv.style.fontWeight = "bold";
wordDiv.style.color = "#f8fafc";
wordLayer.appendChild(wordDiv);

var translateDiv = document.createElement("div");
translateDiv.style.fontSize = "13px";
translateDiv.style.overflow = "hidden";
translateDiv.style.overflowY = "auto";
translateDiv.style.flexGrow = "1";
translateDiv.style.marginBottom = "20px";

translateDiv.classList.add("ciba_word_translate");

wordLayer.appendChild(translateDiv);

var wordSaveLayer = document.createElement("div");
wordSaveLayer.style.alignSelf = "flex-end";
wordLayer.appendChild(wordSaveLayer);

var wordSaveBtn = document.createElement("span");
wordSaveBtn.style.color = "#ffffff";
wordSaveBtn.style.fontSize = "12px";
wordSaveBtn.style.padding = "6px 12px";
wordSaveBtn.style.borderRadius = "4px";
wordSaveBtn.style.background = "#07c160";
wordSaveBtn.style.cursor = "pointer";
wordSaveBtn.innerText = "添加到单词本"
wordSaveLayer.appendChild(wordSaveBtn);

//记忆卡控件
var cardLayer = document.createElement("div");
cardLayer.style.display = "none";
cardLayer.style.flexDirection = "column";
cardLayer.style.width = "100%";
cardLayer.style.height = "100%";
mainArea.appendChild(cardLayer);

var cardHeaderLayer = document.createElement("div");
cardHeaderLayer.style.display = "flex";
cardHeaderLayer.style.alignItems = "center";
cardLayer.appendChild(cardHeaderLayer);

var cardPackageText = document.createElement("span");
cardPackageText.style.color = "#f8fafc";
cardPackageText.innerText = "卡组：";
cardHeaderLayer.appendChild(cardPackageText);

var cardPackageSelect = document.createElement("select");
cardPackageSelect.style.width = "160px";
cardPackageSelect.style.marginRight = "20px";
cardPackageSelect.style.height = "24px";
cardPackageSelect.style.lineHeight = "24px";
cardPackageSelect.style.fontSize = "12px";
cardPackageSelect.style.background = "rgba(30, 41, 59, 0.8)";
cardPackageSelect.style.color = "#f8fafc";
cardPackageSelect.style.border = "1px solid rgba(255, 255, 255, 0.2)";
cardHeaderLayer.appendChild(cardPackageSelect);

var cardTemplateText = document.createElement("span");
cardTemplateText.style.color = "#f8fafc";
cardTemplateText.innerText = "模版：";
cardHeaderLayer.appendChild(cardTemplateText);

var cardTemplateSelect = document.createElement("select");
cardTemplateSelect.style.width = "160px";
cardTemplateSelect.style.height = "24px";
cardTemplateSelect.style.lineHeight = "24px";
cardTemplateSelect.style.fontSize = "12px";
cardTemplateSelect.style.background = "rgba(30, 41, 59, 0.8)";
cardTemplateSelect.style.color = "#f8fafc";
cardTemplateSelect.style.border = "1px solid rgba(255, 255, 255, 0.2)";
cardHeaderLayer.appendChild(cardTemplateSelect);

//记忆卡主体展示部分
var cardBodyLayer = document.createElement("div");
cardBodyLayer.style.height = "0";
cardBodyLayer.style.flexGrow = "1";
cardBodyLayer.style.overflowY = "auto";
cardBodyLayer.style.margin = "20px 0px";
cardBodyLayer.style.border = "1px solid rgba(255,255,255,0.1)";
cardBodyLayer.style.padding = "10px";
cardBodyLayer.style.boxSizing = "border-box";

cardBodyLayer.classList.add("ciba_card_body");

cardLayer.appendChild(cardBodyLayer)

var cardSaveLayer = document.createElement("div");
cardSaveLayer.style.alignSelf = "flex-end";
cardLayer.appendChild(cardSaveLayer);

var cardSaveBtn = document.createElement("span");
cardSaveBtn.style.color = "#ffffff";
cardSaveBtn.style.fontSize = "12px";
cardSaveBtn.style.padding = "4px 12px";
cardSaveBtn.style.borderRadius = "4px";
cardSaveBtn.style.background = "#07c160";
cardSaveBtn.style.cursor = "pointer";
cardSaveBtn.innerText = "添加卡片"
cardSaveLayer.appendChild(cardSaveBtn);


var audio = document.createElement("audio");
audio.preload = "auto";
audio.hidden = "true";
layerContainer.appendChild(audio)

captionBar.addEventListener("mousedown", function(e) {
  isDragging = true;
  offsetX = e.clientX - layerContainer.offsetLeft;
  offsetY = e.clientY - layerContainer.offsetTop;
});

document.addEventListener("mousemove", function(e) {
  if (isDragging) {
    layerContainer.style.left = (e.clientX - offsetX) + "px";
    layerContainer.style.top = (e.clientY - offsetY) + "px";
  }
});

document.addEventListener("mouseup", function(e) {
  // 点击在弹窗、登录层、浮动图标内部时，不触发取词
  isDragging = false;

  var privacyNode = document.getElementById("ciba-privacy-notice");

  if (layerContainer.contains(e.target) 
    || wechatLoginLayer.contains(e.target) 
    || floatingIcon.contains(e.target)
    || (privacyNode && privacyNode.contains(e.target))) {
    return;
  }
  //如果没有取到内容，就不要做操作
  let content = getSelectContent()
  let text = content.text
  
  if  (!text || text.length === 0){
    //关闭可能显示的图标
    hideFloatingIcon()
    return
  }

  // 🆕 隐私同意门控：未同意前不触发任何可能涉及数据收集的行为
  chrome.storage.local.get('privacyAgreed', function(result) {
    if (!result.privacyAgreed) {
      showPrivacyNoticeCard()
      return
    }
    // 已同意：继续原有逻辑
    getToken().then((value)=>{
      if (value && value.ciba_token){
        tryShowLayer()
      }else{
        showWechatLoginLayer()
      }
    })
  })
});

// floatingIcon.addEventListener("mouseenter", function() {
//   iconHoverTimer = setTimeout(function() {
//     showLayer(parseInt(floatingIcon.style.left), parseInt(floatingIcon.style.top));
//   }, 500);
// });

// floatingIcon.addEventListener("mouseleave", function() {
//   clearTimeout(iconHoverTimer);
// });

floatingIcon.addEventListener("click", function() {
  var rect = this.getBoundingClientRect();
  var iconX = window.scrollX + rect.left;
  var iconY = window.scrollY + rect.top;
  showLayer(iconX, iconY);
});

closeIcon.addEventListener("click", function() {
  //隐藏主窗口
  hideLayer();
  hideFloatingIcon();
  //清除掉选择的文本，防止多次打开
  window.getSelection().removeAllRanges()
});

wordSaveBtn.addEventListener("click", function() {
  addWord()
});

cardSaveBtn.addEventListener("click", function() {
  addCard()
});

cardPackageSelect.addEventListener("change", function() {
   //卡组变化
   chrome.storage.local.set({ 'ciba_package': this.value }, function(){});
});
cardTemplateSelect.addEventListener("change", function() {
  //模版变化
  initFields(this.value);
  chrome.storage.local.set({ 'ciba_template': this.value }, function(){});
});

//显示弹出按钮
function showFloatingIcon(x, y) {
  var scrollLeft = window.scrollX;
  var scrollTop = window.scrollY;
  var rightBoundary = scrollLeft + window.innerWidth;
  var bottomBoundary = scrollTop + window.innerHeight;

  if (x + 28 > rightBoundary) x = rightBoundary - 28 - 20;
  if (y + 28 > bottomBoundary) y = bottomBoundary - 28 - 20;

  floatingIcon.style.display = "block";
  floatingIcon.style.left = x + "px";
  floatingIcon.style.top = y + "px";
  floatingIcon.style.opacity = "1";
}

//显示按钮隐藏
function hideFloatingIcon() {
  floatingIcon.style.display = "none";
  floatingIcon.style.opacity = "0";
}
function getLayerHeight(){
  let height = 550
  
  let isCnlanguage = detectCnLanguage(selectedText);
  let isSentence = detectSentence(selectedText)
  
  if (!isCnlanguage && !isSentence){
    height = 300
  }

  return height
}
//显示主窗口
function showLayer(x, y) {
  var scrollLeft = window.scrollX;
  var scrollTop = window.scrollY;
  var layerWidth = 500;
  var layerHeight = getLayerHeight();
  var rightBoundary = scrollLeft + window.innerWidth;
  var bottomBoundary = scrollTop + window.innerHeight;

  if (x + layerWidth > rightBoundary) x = rightBoundary - layerWidth - 20;
  if (y + layerHeight > bottomBoundary) y = bottomBoundary - layerHeight - 20;

  layerContainer.style.display = "block";
  layerContainer.style.left = x + "px";
  layerContainer.style.top = y + "px";
  layerContainer.style.width = "0px";
  layerContainer.style.height = "0px";
  layerContainer.style.zIndex = 9999999999;
  
  setTimeout(function() {
    layerContainer.style.width = layerWidth + "px";
    layerContainer.style.height = layerHeight + "px";
  }, 10);

  let isCnlanguage = detectCnLanguage(selectedText);
  let isSentence = detectSentence(selectedText)

  //单词（纯英文单词才进入单词查询，避免数字被识别为单词）
  if (detectEnglishWord(selectedText)){
    //隐藏卡片层
    hideCardLayer()
    //显示单词层
    showWordLayer()
  }else{
    //隐藏单词层
    hideWordLayer()
    //显示卡片层
    showCardLayer()
  }
  hideFloatingIcon()
}
//隐藏主窗口
function hideLayer() {
  layerContainer.style.display = "none";
  layerContainer.style.width = "0px";
  layerContainer.style.height = "0px";
  
  //把主要的显示控件清除，防止数据粘连
  cardBodyLayer.innerHTML = "";
  translateDiv.innerHTML = "";
}

//显示单词组件
function showWordLayer(){
  wordDiv.innerText = selectedText
  wordLayer.style.display = "flex";
  wordLayer.style.flexDirection = "column";
  //这里去获取翻译？
  searchWord(selectedText)
}

function hideWordLayer(){
  wordLayer.style.display = "none";
}

//显示卡片组件
function showCardLayer(){
  cardLayer.style.display = "flex";
  //如果本地没有对应的package和template，就去获取
  if (packList.length == 0){
    fetchCardPackage()
    fetchCardTemplate()
  }else{
    //如果获取到了package和template信息，直接找到对应的tempalteId去初始化
    tryFindTemplateId()
  }
}

function hideCardLayer(){
  cardLayer.style.display = "none";
}

function tryShowLayer(){
  let content = getSelectContent()
  let text = content.text
  if  (!text){
    return
  }

  // 🆕 隐私同意门控：未同意前不触发任何可能涉及数据收集的行为
  chrome.storage.local.get('privacyAgreed', function(result) {
    if (!result.privacyAgreed) {
      showPrivacyNoticeCard()
      return
    }

    // 已同意：原有逻辑
    if (text.length > 0) {
      selectedText = text;
      selectedSentence = content.sentence

      var range = window.getSelection().getRangeAt(0);
      var rect = range.getBoundingClientRect();
      var iconX = window.scrollX + rect.left + rect.width + 5;
      var iconY = window.scrollY + rect.top - 30;
      //做判断，是否直接弹出
      chrome.storage.local.get('ciba_options', function(result) {
        let options = null
        if (result && result.ciba_options){
          options = JSON.parse(result.ciba_options)
        }
        let directPopup = false
        let sentence = detectSentence(text)
        let isCnlanguage = detectCnLanguage(text)
        let isEnglishWord = detectEnglishWord(text)
        //英文单词：判断 word_popup（默认弹窗）
        if (isEnglishWord) {
          if (!options || options.word_popup == 0) {
            directPopup = true
          }
        //中文或者句子：判断 sentence_popup
        } else if (isCnlanguage || sentence) {
          if (options && options.sentence_popup == 1){
            directPopup = true
          }
        }
        // 其他情况（纯数字、符号等）：不弹窗，也不显示图标
        if (directPopup){
          showLayer(parseInt(iconX), parseInt(iconY));
        }else{
          hideLayer()
          showFloatingIcon(iconX, iconY);
        }
      })
    } else {
      hideFloatingIcon();
    }
  });
}

function getSelectContent(){
  let result = {}
  try{
    let selecter = window.getSelection()
    let text = selecter.toString()
    if(text != null && text.trim() != ""){
      result.text = text.trim()
      if (selecter.anchorNode && selecter.anchorNode.textContent){
        result.sentence = selecter.anchorNode.textContent
      }
    }
  }catch(err){
    
  }
  return result
}

function getToken(){
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

// 以下请求在用户主动划词后触发，选中文本仅用于向 cibaen.com 查询单词释义
function searchWord(word){
  wordDiv.innerText = word
  getToken().then((value)=>{
    if (value && value.ciba_token){
      let wordCardTemplate = `
          <div style="margin-top: 8px; color:#94a3b8;">
              数据获取中...
          </div>
      `
      translateDiv.innerHTML = wordCardTemplate
      var xhr = new XMLHttpRequest();
      xhr.open("GET", `${old_server_api}/words/search.json?token=${value.ciba_token}&wordName=${word}`, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState == 4) {
          // JSON解析器不会执行攻击者设计的脚本.
          let resp = JSON.parse(xhr.responseText);
          let word = resp.word;
          let pronEN = '[' + word.phEn + ']';
          let enAudioUrl = word.phEnMp3;
          let pronUS = '[' + word.phAm + ']';
          let amAudioUrl = word.phAmMp3;
          let isAdded = word.added; //单词状态  0：未添加到单词本
          let currentWordInterpret = ''
          //解析单词释义
          let exampleText = '';
          let speechParts = word.speechParts;
          let sentences = '';
          for (let i = 0; i < speechParts.length; i++) {
            let speechPart = speechParts[i];
            let partName = speechPart.partName + '  ';
            let means = speechPart.means;
            for (let j = 0; j < means.length; j++) {
              let mean = means[j];
              let wordMean = mean.wordMean + ';';
              partName = partName + wordMean;

              //解析例句
              if (mean.hasOwnProperty("sentences")) {
                let sentencesArray = mean.sentences;
                if (sentencesArray) {
                  let sentence = sentencesArray[0] //目前暂时获取第一个例句
                  if (sentence) {
                    sentences = sentences + sentence.english + "<br/>"
                  }
                }
              }

            }
            partName = partName + "<br/>";
            exampleText = exampleText + partName;
            currentWordInterpret = exampleText;
          }
          wordCardTemplate = `
              <div style="margin-top: 8px;color:#94a3b8;">
                  <span>英 ${pronEN}</span>
                  <span id="enAudio"><img id="enAudioImg" style="display:none;width:22px;height:22px;cursor:pointer;filter:brightness(2);"/></span>
                  <span style="margin-left: 20px;">美 ${pronUS}</span>
                  <span id="amAudio"><img id="amAudioImg" style="display:none;width:22px;height:22px;cursor:pointer;filter:brightness(2);"/></span>
              </div>
              <div style="margin-top: 8px;color:#e2e8f0;">
                  ${currentWordInterpret}
              </div>
          `

          translateDiv.innerHTML = wordCardTemplate

          if (enAudioUrl){
            let enAudioImg = document.getElementById("enAudioImg")
            enAudioImg.style.display = "inline";
            enAudioImg.src = chrome.runtime.getURL("images/sound.png");
            document.getElementById("enAudio").addEventListener("click",function() {
              audio.src = enAudioUrl
              audio.play()
            })
          }

          if (amAudioUrl){
            let amAudioImg = document.getElementById("amAudioImg")
            amAudioImg.style.display = "inline";
            amAudioImg.src = chrome.runtime.getURL("images/sound.png");
            document.getElementById("amAudio").addEventListener("click",function() {
              audio.src = amAudioUrl
              audio.play()
            })
          }
        }
      }
      xhr.send();
    }else{
      showToast("请先微信扫码登录","warning")
    }
  })
}

// 以下请求在用户主动点击"添加到单词本"后触发，选中文本和句子仅用于加入生词本
function addWord() {
  let word = selectedText, sentence = selectedSentence

  getToken().then((value)=>{
    if (value && value.ciba_token){
      var xhr = new XMLHttpRequest();
      xhr.open("POST", `${server_api}/anki/movie2card.json?token=${value.ciba_token}`, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState == 4) {
          let resp = JSON.parse(xhr.responseText);
          if (resp && resp.result == 0){
            //直接关闭窗口？
            hideLayer()
            showToast("添加成功")
          }else if (resp && resp.result == -10001){
            showToast("请先微信扫码登录","warning")
            hideLayer()
            showWechatLoginLayer()
          }else{
            let errorMsg = resp.ex && resp.ex.msg || resp.msg || "发生错误，请稍后重试"
            showToast(errorMsg,"error")
          }
        }
      }
      xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");

      xhr.send(`wordName=${word}&englishCaption=${sentence}`);
    }else{
      showToast("请先微信扫码登录","warning")
      hideLayer()
      showWechatLoginLayer()
    }
  })
}

function showWechatLoginLayer(){
  //这里判断一下，如果已经显示了，直接返回
  if (wechatLoginLayer.style.display == 'flex'){
    return
  }
  wechatLoginLayer.style.display = 'flex';
  refreshAppleLoginBtn()
  fetchQrCodeKey()
}
function closeWechatLoginLayer(){
  wechatLoginLayer.style.display = 'none';
  stopRefreshQrCode()
  tryShowLayer()
}

// ===== 通过 Apple 登录（仅 Safari）：与 popup.js 同一套显隐规则 =====
// Safari 里 chrome.runtime.getURL 的前缀是 safari-web-extension://，Chrome 是 chrome-extension://
function isSafariExt(){
  try { return chrome.runtime.getURL('').indexOf('safari-web-extension://') === 0 } catch (e) { return false }
}
var appleLoginChecked = false  // 只查一次配置，避免每个页面反复请求
function refreshAppleLoginBtn(){
  if (!isSafariExt() || appleLoginChecked) return
  // Safari：读服务端开关，失败 fail-open 显示（App Store 审核要求 Apple 登录常显）
  var xhr = new XMLHttpRequest()
  xhr.open("GET", "https://cibaen.com/client-config.json", true)
  xhr.onreadystatechange = function(){
    if (xhr.readyState != 4) return
    appleLoginChecked = true
    try {
      var config = JSON.parse(xhr.responseText)
      if (config && config.appleLoginEnabled) appleLoginBtn.style.display = "flex"
    } catch (e) {
      appleLoginBtn.style.display = "flex" // 解析失败也按 fail-open 处理
    }
  }
  xhr.onerror = function(){
    appleLoginChecked = true
    appleLoginBtn.style.display = "flex"
  }
  xhr.send()
}

// Apple 登录在别的标签页完成后（apple_login_bridge 写入 token），浮层若还开着则自动收起
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area != 'local' || !changes.ciba_token || !changes.ciba_token.newValue) return
  if (wechatLoginLayer.style.display == 'flex') closeWechatLoginLayer()
})
function showQrcodeLayer(url){
  qrcodeLayer.style.display = 'block';
  qrcodeLayer.src = url
}
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
        showToast(errorMsg,"error")
      }
    }
  }
  xhr.send();
}
function handleQrcodeKey(data){
  qrcodeKey = data.key
  showQrcodeLayer(data.url)
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
        closeWechatLoginLayer()
      }else{
        
      }
    }
  }
  xhr.send();
}
function stopRefreshQrCode() {
  if (refreshTimer){
     clearInterval(refreshTimer)
  }
}

function getPackageLocal(){
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('ciba_package', (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  }); 
}

function getTemplateLocal(){
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('ciba_template', (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  }); 
}

function fetchCardPackage(){
  getToken().then((value)=>{
    if (value && value.ciba_token){
      let xhr = new XMLHttpRequest();
      xhr.open("GET", `${server_api}/anki/pack.json?token=${value.ciba_token}&start=0&limit=1000`, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState == 4) {
          let resp = JSON.parse(xhr.responseText);
          if (resp && resp.result == 0){
            packList = resp.packs || []
            //暂时先隐藏看美剧的卡组
            packList = packList.filter(item=>item.name != '看美剧学英语')
            if (packList.length > 0){
              //这里动态增加组件？
              for (let i = 0; i < packList.length; i++){
                let item = packList[i]
                let optionItem = document.createElement("option");
                optionItem.value = item.id;
                optionItem.innerText = item.name;
                optionItem.style.backgroundColor = "rgba(15, 23, 42, 0.95)";
                optionItem.style.color = "#f8fafc";
                cardPackageSelect.appendChild(optionItem)
              }
              getPackageLocal().then(value=>{
                if (value && value.ciba_package){
                  let options = cardPackageSelect.querySelectorAll("option")
                  for (let i = 0; i < options.length; i++){
                    let option = options[i]
                    if (value.ciba_package == option.value){
                      option.selected = true
                      break
                    }
                  }
                }
              })
            }
          }else if (resp && resp.result == -10001){
            showToast("请先微信扫码登录","warning")
            hideLayer()
            showWechatLoginLayer()
          }else{
            let errorMsg = resp.ex && resp.ex.msg || resp.msg || "发生错误，请稍后重试"
            showToast(errorMsg,"error")
          }
        }
      }
      xhr.send();
    }
  })
}

function fetchCardTemplate(){
  getToken().then((value)=>{
    if (value && value.ciba_token){
      let xhr = new XMLHttpRequest();
      xhr.open("GET", `${server_api}/anki/pack/global.json?token=${value.ciba_token}&start=0&limit=1000`, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState == 4) {
          let resp = JSON.parse(xhr.responseText);
          if (resp && resp.result == 0){
            //处理模版
            initModel(resp.list)
          }else if (resp && resp.result == -10001){
            showToast("请先微信扫码登录","warning")
            hideLayer()
            showWechatLoginLayer()
          }else{
            let errorMsg = resp.ex && resp.ex.msg || resp.msg || "发生错误，请稍后重试"
            showToast(errorMsg,"error")
          }
        }
      }
      xhr.send();
    }
  })
}

function initModel(models){
  //特殊处理，如果是糍粑卡组的，只显示单词模型（为的是添加、编辑单词模型 2），你能看懂吗？
  //判断当前是糍粑卡组
  if (false){
    models = models.filter(model=>model.id == 2)
  }
  models = models.map(model=>{
    let o = {}
    o.id = model.id
    Object.assign(o, JSON.parse(model.data))
    return o
  })
  modelList = models
  initCardTemplateList()
}

function initCardTemplateList(){
  let list = []

  if (modelList && modelList.length > 0){
    modelList.forEach(model=>{
      let tmpls = model.tmpls
      tmpls.map(item=>{
        item.id = `${model.id}_${item.ord}`
        item.modelId = model.id
        return item
      })
      list = list.concat(tmpls)
    })
  }
  templateList = list
  if (list.length > 0){
    //这里动态增加组件？
    for (let i = 0; i < list.length; i++){
      let item = list[i]
      let optionItem = document.createElement("option");
      optionItem.value = item.id;
      optionItem.innerText = item.name;
      optionItem.style.backgroundColor = "rgba(15, 23, 42, 0.95)";
      optionItem.style.color = "#f8fafc";
      cardTemplateSelect.appendChild(optionItem)
    }
    tryFindTemplateId()
  }
}

function tryFindTemplateId(){
  getTemplateLocal().then(value=>{
    let index = 0
    if (value && value.ciba_template){
      let options = cardTemplateSelect.querySelectorAll("option")
      for (let i = 0; i < options.length; i++){
        let option = options[i]
        if (value.ciba_template == option.value){
          option.selected = true
          index = i
          break
        }
      }
    }
    //创建fields
    let templateId = templateList[index].id
    initFields(templateId)
  })
}

function initFields(templateId){
  //一个model里可能有多个模版？
  //先尝试用之前的数据
  let oldContents = []
  let editors = document.querySelectorAll(".ciba_editor")
  if (editors && editors.length){
    for (let i = 0; i < editors.length; i++){
      oldContents.push(editors[i].value)
    }
  }
  //先清除以前的控件
  cardBodyLayer.innerHTML = "";

  let modelId = templateId.split('_')[0]
  let modelIndex = modelList.findIndex(item=>{
    return item.id == modelId
  })
  let currentModel = modelList[modelIndex]
  fields = JSON.parse(JSON.stringify(currentModel.flds))

  for (let i = 0; i < fields.length; i++){
    let item = fields[i]
    let itemWrapper = document.createElement("div");
    itemWrapper.style.margin = "12px 0px";
    cardBodyLayer.appendChild(itemWrapper);
    
    let titleDiv = document.createElement("div");
    titleDiv.style.fontSize = "16px";
    titleDiv.style.color = "#f8fafc";
    titleDiv.style.marginBottom = "12px";
    titleDiv.innerText = item.name;
    itemWrapper.appendChild(titleDiv);
   
    let editor = document.createElement("textarea");
    editor.style.width = "100%";
    editor.style.height = "100px";
    editor.style.resize = "none";
    editor.style.boxSizing = "border-box";
    editor.style.border = "1px solid rgba(255,255,255,0.2)";
    editor.style.background = "rgba(15, 23, 42, 0.5)";
    editor.style.color = "#f8fafc";
    editor.style.padding = "8px";
    editor.classList.add("ciba_editor")
    itemWrapper.appendChild(editor);

    //如果是第1个editor，增加对应的value？
    let content = getSelectContent().text
    if (0 === i && content){
      editor.value = content
    }else{
      if (oldContents.length > 0 && i <= oldContents.length - 1){
        editor.value = oldContents[i]
      }
    }
  }
}

function getPackageId(){
  return cardPackageSelect.value
}
function getTemplateId(){
  return cardTemplateSelect.value
}
function getModelId(){
  let templateId = getTemplateId()
  let modelId = templateId.split('_')[0]
  let modelIndex = modelList.findIndex(item=>{
    return item.id == modelId
  })
  return modelList[modelIndex].id
}
function addCard(){
  getToken().then((value)=>{
    if (value && value.ciba_token){
      //判断是否能添加？
      let package_id = getPackageId()
      let mod_id = getModelId()
      let note = getNoteContent()
      let name = note.name
      let data = note.data
      let extend = ''

      if (!name){
        showToast("请填写笔记标题","warning")
        return
      }
      var xhr = new XMLHttpRequest();
      let url = `${server_api}/anki/note.json?token=${value.ciba_token}`
      let extendType = ''

      if (extendType){
        url += `?extend=${extendType}`
      }
      xhr.open("POST", url, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState == 4) {
          let resp = JSON.parse(xhr.responseText);
          if (resp && resp.result == 0){
            // chrome.storage.local.set({ 'ciba_package': package_id }, function(){});
            // chrome.storage.local.set({ 'ciba_template': getTemplateId() }, function(){});
            //直接关闭窗口
            hideLayer()
            showToast("添加成功")
          }else{
            let errorMsg = resp.ex && resp.ex.msg || resp.msg || "发生错误，请稍后重试"
            showToast(errorMsg,"error")
          }
        }
      }
      xhr.setRequestHeader("Content-Type", "application/json");

      let params = {
        package_id,
        mod_id,
        name
      }
      if (data){
        params.data = data
      }
      if (extend){
        params.extend = extend
      }
      
      xhr.send(JSON.stringify(params));
    }else{
      showToast("请先微信扫码登录","warning")
    }
  })
}

function getNoteContent(){
  let data = noteInitData()
  let note = {
    name:'',
    data
  }
  let editors = document.querySelectorAll(".ciba_editor")

  for (let i = 0; i < fields.length; i++) {
    if (0 === i){
      note.name = editors[0].value
    }
    noteInsertData(note,i,editors[i].value)
  }
  return note
}

function noteInitData(){
  let data = ''

  for (let i = 0; i < fields.length - 1; i++) {
    data += ANKI_DATA_SPLIT
  }
  return data
}

function noteInsertData(note,index,content){
  if (!note){
    return
  }
  if (!note.data){
    note.data = content
  }else{
    let valueArray = note.data.split(ANKI_DATA_SPLIT)
    valueArray[index] = content
    note.data = valueArray.join(ANKI_DATA_SPLIT)
  }
}

function showToast(msg, type = 'success', duration = 2000) {
  let toastNode = `<div id="ciba_toast" class="toast-content toast-${type}">`;

  toastNode += `
      <div class="toast">
        ${msg}
      </div>
    </div>`

    document.body.insertAdjacentHTML('beforeend', toastNode);
    setTimeout(function () {
      let node = document.getElementById("ciba_toast");
      node.parentNode.removeChild(node);
    },duration) 
}


  // 🆕 隐私告知卡片：与 popup / video_ocr_content 同款绿色系 UI，支持勾选《隐私政策》+ 确认同意 + 右上角关闭
  // 同意逻辑与 popup.js 完全一致（写入同一个 chrome.storage.local.privacyAgreed）
  function showPrivacyNoticeCard() {
    if (document.getElementById("ciba-privacy-notice")) return;

    var notice = document.createElement("div");
    notice.id = "ciba-privacy-notice";
    notice.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 90%;
        max-width: 420px;
        min-width: 320px;
        background: #fff;
        border: 1px solid #e2efe6;
        border-left: 4px solid #07c160;
        border-radius: 12px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        padding: 24px;
        box-sizing: border-box;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #333;
        line-height: 1.6;
    `;

    notice.innerHTML = `
        <button id="ciba-privacy-close-btn" title="关闭" aria-label="关闭"
          style="position:absolute; top:10px; right:10px; width:28px; height:28px;
                 display:flex; align-items:center; justify-content:center;
                 background:transparent; border:none; border-radius:6px; cursor:pointer;
                 font-size:20px; line-height:1; color:#94a3b8; transition:all .2s;">×</button>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#07c160;"></span>
            <span style="font-size:18px;font-weight:600;color:#333;">首次使用须知</span>
        </div>
        <div style="font-size:14px;line-height:1.65;color:#555;margin-bottom:20px;">
            本扩展会收集您主动划词/截图的字幕文本用于查词与加卡。
            请先阅读并同意我们的
            <a id="ciba-privacy-link" href="https://cibaen.com/privacy-policy.html" target="_blank" rel="noopener noreferrer" style="color:#07c160;text-decoration:underline;">《隐私政策》</a>
            后再继续使用。
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#374151;cursor:pointer;margin-bottom:24px;">
            <input id="ciba-privacy-checkbox" type="checkbox" style="width:15px;height:15px;accent-color:#07c160;cursor:pointer;">
            <span>我已阅读并同意《隐私政策》</span>
        </label>
        <button id="ciba-privacy-agree-btn" disabled style="width:100%;padding:12px 0;border:none;border-radius:8px;background:#07c160;color:#fff;font-size:14px;font-weight:500;cursor:pointer;opacity:0.5;transition:opacity .2s;line-height:1;">确认并继续使用</button>
    `;

    document.body.appendChild(notice);

    var checkbox = notice.querySelector("#ciba-privacy-checkbox");
    var btn = notice.querySelector("#ciba-privacy-agree-btn");
    var closeBtn = notice.querySelector("#ciba-privacy-close-btn");

    closeBtn.onmouseenter = function() { this.style.background = 'rgba(0,0,0,0.06)'; this.style.color = '#333'; };
    closeBtn.onmouseleave = function() { this.style.background = 'transparent'; this.style.color = '#94a3b8'; };
    closeBtn.addEventListener('click', function() { notice.remove(); });

    checkbox.addEventListener('change', function() {
        btn.disabled = !checkbox.checked;
        btn.style.opacity = checkbox.checked ? "1" : "0.5";
    });

    btn.addEventListener('click', function() {
        if (!checkbox.checked) return;
        chrome.storage.local.set({ privacyAgreed: true }, function() {
            var node = document.getElementById("ciba-privacy-notice");
            if (node && node.parentNode) node.parentNode.removeChild(node);
            getToken().then(function(value) {
                if (value && value.ciba_token) { tryShowLayer(); }
                else { showWechatLoginLayer(); }
            });
        });
    });
  }
}// ========== initCibaPlugin 函数结束 ==========


// ========== 改动 2：黑名单检查，通过才执行 ==========
(function() {
  // 受限页面（chrome:// 等）直接退出
  try {
    if (!window.location || !window.location.hostname) return;
  } catch(e) { return; }

  const hostname = window.location.hostname;
  
  chrome.storage.local.get('disabledSites', function(result) {
    const disabledSites = result.disabledSites || [];
    if (!disabledSites.includes(hostname)) {
      // 不在黑名单，正常初始化插件
      initCibaPlugin();
    }
    // 在黑名单里，啥也不做，插件完全不工作
  });
})();