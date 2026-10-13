(function () {
  console.log("视频字幕自动 OCR 助手 Content Script 已装载");

  // 防重复注入守卫：Safari 扩展更新/重新启用后可能向同一页面再次注入，
  // 会造成双份悬浮工具栏（同因 content_script.js 的双窗口问题）。
  // window 标记防同 world 重注入；<html> 的 data 属性防跨 world/双扩展注入。
  if (window.__cibaVideoInjected === true || document.documentElement.hasAttribute('data-ciba-video-injected')) {
    console.log("[ciba-video] 检测到重复注入，跳过本次初始化");
    return;
  }
  window.__cibaVideoInjected = true;
  document.documentElement.setAttribute('data-ciba-video-injected', '1');

  // ===== 配置 & 全局状态 =====
  const SERVER_API = 'https://www.cibaen.com/api';

  // ===== HTML 净化：所有含远程数据（OCR 文本 / 接口 JSON）的 HTML 赋值统一经 DOMPurify 净化 =====
  // DOMPurify 为打包在扩展内的本地库（js/vendor/purify.min.js），不加载任何远程代码
  function setHtml(el, html) {
    el.innerHTML = DOMPurify.sanitize(html);
  }

  let audioElement = null;
  let currentWord = '';
  let currentSentence = '';
  let bodyLoginPollTimer = null;
  let ocrEnabled = true; // 🆕 OCR 开关状态，默认开启
  let emptyTextHideTimer = null; // 🆕 未检测到字幕自动关闭的定时器
  let ocrSessionId = 0; // 🆕 识别会话号：用户恢复播放后自增，用于作废在途的识别结果

  function getToken() {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) {
        reject(new Error('Extension context invalidated'));
        return;
      }
      chrome.storage.local.get('ciba_token', (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(result);
        }
      });
    });
  }

  // ===== 原有变量 =====
  let toastElement = null;
  let cardElement = null;
  let triggerBtnElement = null;
  let triggerBtnMorphTimer = null; // 🆕 触发按钮变形为圆形图标的定时器
  let triggerBtnIsIcon = false; // 🆕 触发按钮是否已变形为圆形图标
  let triggerBtnLogoTimer = null; // 🆕 收拢动画结束后再替换成 logo 的定时器
  let lastCapturedBlob = null;
  let lastFullVideoBlob = null; // 🆕 全视频截图

  // 🔧 allowScreenshotUpload 加入 DEFAULT_SETTINGS，与 cropPixelHeight/enabled 统一管理
  const DEFAULT_SETTINGS = {
    enabled: true,
    cropPixelHeight: 120,
    allowScreenshotUpload: false
  };

  // ===== 🆕 辅助函数（七牛上传用） =====
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(blob);
    });
  }
  function generateUuid(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  }
  function base64EncodeUrlSafe(str) {
    const base64 = btoa(unescape(encodeURIComponent(str)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_');
  }

  // ===== 🆕 更新加词按钮的可用状态（所有 .ciba-video-ocr-add-btn：OCR 卡 + YouTube 覆盖层） =====
  function updateAddButtonState() {
    const btns = document.querySelectorAll('.ciba-video-ocr-add-btn');
    if (!btns.length) return;
    chrome.storage.local.get('ciba_token', (result) => {
      btns.forEach((addBtn) => {
        if (result.ciba_token) {
          addBtn.disabled = false;
          addBtn.title = "添加到单词本";
        } else {
          addBtn.disabled = true;
          addBtn.title = "请先登录后使用";
        }
      });
    });
  }

  // 初始化 DOM
  function initOverlayElements() {
    if (!document.getElementById("ciba-video-ocr-toast")) {
      toastElement = document.createElement("div");
      toastElement.id = "ciba-video-ocr-toast";
      toastElement.innerHTML = `<div class="ciba-video-ocr-spinner"></div><span id="ciba-video-ocr-toast-msg">正在识别字幕...</span>`;
      (document.body || document.documentElement).appendChild(toastElement);
    } else {
      toastElement = document.getElementById("ciba-video-ocr-toast");
    }

    if (!document.getElementById("ciba-video-ocr-card")) {
      cardElement = document.createElement("div");
      cardElement.id = "ciba-video-ocr-card";
      cardElement.innerHTML = `
        <div class="ciba-video-ocr-header" id="ciba-video-ocr-drag-handle">
          <div class="ciba-video-ocr-title">
            <span>糍粑 OCR 识别结果</span>
          </div>
          <div class="ciba-video-ocr-actions">
            <button class="ciba-video-ocr-btn-icon" id="ciba-video-ocr-refresh-btn" title="重新识别">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            </button>
            <button class="ciba-video-ocr-btn-icon" id="ciba-video-ocr-close-btn" title="关闭">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
        <div class="ciba-video-ocr-body" style="height:250px; overflow-y:scroll;">
          <div class="ciba-video-ocr-text-box" id="ciba-video-ocr-result-text" contenteditable="true">尚未识别</div>
          <div class="ciba-video-ocr-word-detail" id="ciba-video-ocr-word-detail" style="height:180px; overflow-y:auto; color:#94a3b8; display:flex; align-items:center; justify-content:center; font-size:13px;">点击单词翻译</div>
        </div>
        <div class="ciba-video-ocr-footer">
          <button class="ciba-video-ocr-toggle-btn" id="ciba-video-ocr-toggle-btn" title="临时关闭/开启 OCR 识别">
            <span id="ciba-video-ocr-toggle-text" style="color:#ffffff !important;">⏸ 暂停识别</span>
          </button>
          <button class="ciba-video-ocr-add-btn" id="ciba-video-ocr-add-btn" title="添加到单词本">
            <span style="color:#ffffff !important;">添加到单词本</span>
          </button>
        </div>
      `;
      (document.body || document.documentElement).appendChild(cardElement);
      bindCardEvents();
    } else {
      cardElement = document.getElementById("ciba-video-ocr-card");
    }

    injectGlobalTriggerButton();
  }

  function showToast(message, isLoading = true, duration = 4000) {
    if (!toastElement) initOverlayElements();
    const msgEl = document.getElementById("ciba-video-ocr-toast-msg");
    const spinner = toastElement.querySelector(".ciba-video-ocr-spinner");
    if (msgEl) msgEl.innerText = message;
    if (spinner) spinner.style.display = isLoading ? "block" : "none";

    if (cardElement && cardElement.classList.contains("show")) {
      const cardRect = cardElement.getBoundingClientRect();
      toastElement.style.position = 'fixed';
      toastElement.style.top = (cardRect.bottom + 24) + 'px';
      toastElement.style.left = (cardRect.left + cardRect.width / 2) + 'px';
      toastElement.style.transform = 'translateX(-50%)';
      // 🆕 强制宽度由内容决定，不受卡片宽度影响
      toastElement.style.width = 'max-content';
      toastElement.style.maxWidth = '300px';
      toastElement.style.whiteSpace = 'normal';
    } else {
      toastElement.style.position = '';
      toastElement.style.top = '';
      toastElement.style.left = '';
      toastElement.style.transform = '';
      // 🆕 清除宽度限制，恢复 CSS 接管
      toastElement.style.width = '';
      toastElement.style.maxWidth = '';
      toastElement.style.whiteSpace = '';
    }

    toastElement.classList.add("show");
    if (!isLoading) setTimeout(() => toastElement.classList.remove("show"), duration);
  }

  function hideToast() {
    if (toastElement) toastElement.classList.remove("show");
  }

  // 展示 OCR 结果，单词可点击
  function showResultCard(text, elapse, details = [], isFullPage = false) {
    if (!cardElement) initOverlayElements();
    hideToast();

    // 🆕 清除之前的自动关闭定时器，防止多次识别导致误关
    if (emptyTextHideTimer) { clearTimeout(emptyTextHideTimer); emptyTextHideTimer = null; }

    const textEl = document.getElementById("ciba-video-ocr-result-text");
    const detailEl = document.getElementById("ciba-video-ocr-word-detail");

    if (detailEl) {
      detailEl.style.display = 'flex';
      detailEl.innerHTML = '点击单词翻译';
      detailEl.style.height = '180px';
      detailEl.style.overflowY = 'auto';
      detailEl.style.color = '#94a3b8';
      detailEl.style.alignItems = 'center';
      detailEl.style.justifyContent = 'center';
      detailEl.style.fontSize = '13px';
    }
    const bodyEl = document.querySelector('.ciba-video-ocr-body');
    if (bodyEl) {
      const existingQr = bodyEl.querySelector('.ciba-video-ocr-login-qr');
      if (existingQr) existingQr.remove();
    }

    currentWord = '';
    currentSentence = text ? text.trim() : '';

    if (textEl) {
      if (text && text.trim()) {
        const html = text.trim().replace(/\b([a-zA-Z]+(?:[''][a-zA-Z]+)?)\b/g,
          '<span class="ciba-video-ocr-word" data-word="$1">$1</span>'
        );
        setHtml(textEl, html);
        textEl.addEventListener('click', (e) => {
          const span = e.target.closest('.ciba-video-ocr-word');
          if (!span) return;
          const word = span.textContent.trim();
          currentWord = word;
          currentSentence = textEl.innerText;
          searchWordInCard(word, currentSentence);
        });
        textEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') e.preventDefault();
        });
      } else {
        const emptyMsg = "(未检测到字幕，有可能是跨域或广告引起，请到其他平台观看)";
        textEl.innerHTML = `<div class="ciba-video-ocr-empty">${emptyMsg}</div>`;
        // 🆕 2 秒后自动关闭卡片
        emptyTextHideTimer = setTimeout(() => hideResultCard(), 3000);
      }
    }

    cardElement.classList.add("show");

    updateAddButtonState();
  }

  function hideResultCard() {
    if (cardElement) cardElement.classList.remove("show");
  }

  function downloadBlobImage(blob) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const now = new Date();
    a.href = url;
    a.download = `ciba_video_subtitle_${now.getHours()}${now.getMinutes()}${now.getSeconds()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bindCardEvents() {
    const closeBtn = document.getElementById("ciba-video-ocr-close-btn");
    const refreshBtn = document.getElementById("ciba-video-ocr-refresh-btn");
    const addBtn = document.getElementById("ciba-video-ocr-add-btn");
    const dragHandle = document.getElementById("ciba-video-ocr-drag-handle");
    const toggleBtn = document.getElementById("ciba-video-ocr-toggle-btn");
    const toggleText = document.getElementById("ciba-video-ocr-toggle-text");

    if (closeBtn) closeBtn.addEventListener("click", hideResultCard);

    updateAddButtonState();

    // 🆕 开关按钮事件
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        ocrEnabled = !ocrEnabled;
        const detailEl = document.getElementById("ciba-video-ocr-word-detail");
        if (ocrEnabled) {
          toggleText.textContent = "⏸ 暂停识别";
          showToast("OCR 已恢复 ✅", false, 1500);
          // 🆕 只有当前显示的是暂停提示，才恢复为"点击单词翻译"；有释义则保留
          if (detailEl && detailEl.innerHTML === '已暂停字幕识别') {
            detailEl.style.display = 'flex';
            detailEl.innerHTML = '点击单词翻译';
          }
        } else {
          toggleText.textContent = "▶ 开启识别";
          hideToast();
          showToast("OCR 已暂停 ⏸️", false, 1500);
          // 🆕 暂停时显示提示，强制 flex 居中
          if (detailEl) {
            detailEl.style.display = 'flex';
            detailEl.innerHTML = '已暂停字幕识别';
          }
        }
        if (triggerBtnElement) {
          setTriggerBtnText(ocrEnabled ? "暂停键识别字幕" : "开启识别字幕");
        }
      });
    }

    if (addBtn) {
      addBtn.addEventListener("click", () => {
        addWordToNotebook();
      });
    }

    if (refreshBtn) refreshBtn.addEventListener("click", () => {
      if (!ocrEnabled) { showToast("OCR 已暂停，请先开启", false); return; }
      captureAndRecognize();
    });

    if (dragHandle && cardElement) {
      let isDragging = false, startX, startY, initialLeft, initialTop;
      dragHandle.addEventListener("mousedown", (e) => {
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = cardElement.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
        cardElement.style.right = "auto";
        cardElement.style.bottom = "auto";
        cardElement.style.left = `${initialLeft}px`;
        cardElement.style.top = `${initialTop}px`;
        cardElement.style.width = `${rect.width}px`;
        cardElement.style.height = `${rect.height}px`;
      });
      window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        cardElement.style.left = `${initialLeft + e.clientX - startX}px`;
        cardElement.style.top = `${initialTop + e.clientY - startY}px`;
      });
      window.addEventListener("mouseup", () => { isDragging = false; });
    }
  }

  // 🆕 设置触发按钮文案（按钮已变形为图标时 span 不存在，需容错）
  function setTriggerBtnText(text) {
    if (!triggerBtnElement) return;
    const span = triggerBtnElement.querySelector("span");
    if (span) span.textContent = text;
    triggerBtnElement.setAttribute("title", text);
  }

  // 🆕 与 CSS 中 --icon 的尺寸过渡时长保持一致
  const TRIGGER_BTN_SHRINK_MS = 320;
  // 🆕 logo 不等收拢结束，提前到收拢进行到约 44% 时就插入：
  //    让 logo 的淡入/放大与文字淡出、按钮收拢交叉进行（真正的交叉淡化，消除"空拍"）
  const TRIGGER_BTN_LOGO_LEAD_MS = Math.round(TRIGGER_BTN_SHRINK_MS * 0.44);

  // 🆕 两段式变形：① 按钮带文字淡出、收拢成圆形 ② 收拢进行中就把 logo 放进来交叉淡入弹出
  function morphTriggerBtnToIcon() {
    if (!triggerBtnElement || triggerBtnIsIcon) return;
    triggerBtnIsIcon = true;

    const btn = triggerBtnElement;
    const rect = btn.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;

    // 1) 先把当前尺寸锁成确定的 px，让 width/height 具备可过渡的起始值
    //    （auto 无法参与过渡，必须先固定再切换）
    if (hasSize) {
      btn.style.setProperty('width', `${rect.width}px`, 'important');
      btn.style.setProperty('height', `${rect.height}px`, 'important');
      void btn.offsetWidth; // 强制重排，确立起始尺寸
    }

    btn.setAttribute("title", ocrEnabled ? "暂停键识别字幕" : "开启识别字幕");

    // 2) 第一阶段：只收拢尺寸 + 圆角，文字随过渡淡出；此阶段不放 logo
    btn.classList.add("ciba-video-ocr-trigger-btn--icon");
    if (hasSize) {
      btn.style.removeProperty('width');
      btn.style.removeProperty('height');
    }

    // 3) 第二阶段：不等收拢走完就插入 logo（CSS 里 logo 是绝对居中的，能与文字重叠），
    //    这样 logo 的淡入放大与文字的淡出、按钮的收拢交叉进行，中间不会出现"空拍"
    const logo = document.createElement("img");
    logo.className = "ciba-video-ocr-trigger-logo";
    logo.src = chrome.runtime.getURL("icons/icon-128.png"); // 提前赋值 src，先把图片加载起来，避免插入瞬间还是空白
    logo.alt = "糍粑记忆卡";
    logo.draggable = false;

    if (triggerBtnLogoTimer) clearTimeout(triggerBtnLogoTimer);
    triggerBtnLogoTimer = setTimeout(() => {
      triggerBtnLogoTimer = null;
      const el = triggerBtnElement;
      if (!el || el.querySelector(".ciba-video-ocr-trigger-logo")) return;
      el.replaceChildren(logo);
    }, hasSize ? TRIGGER_BTN_LOGO_LEAD_MS : 0);
  }

  // 🆕 从按钮出现时开始计时，3 秒后变形
  function scheduleTriggerBtnMorph() {
    if (triggerBtnIsIcon || triggerBtnMorphTimer) return;
    triggerBtnMorphTimer = setTimeout(() => {
      triggerBtnMorphTimer = null;
      morphTriggerBtnToIcon();
    }, 3000);
  }

  function injectGlobalTriggerButton() {
    // 🆕 YouTube：字幕由视频内覆盖层接管，OCR 触发按钮不再出现
    if (IS_YOUTUBE) return;
    triggerBtnElement = document.getElementById("ciba-video-ocr-trigger-btn");
    if (triggerBtnElement) {
      // 已注入过：若还没到时间则继续计时，避免重复注入后永远停在文案态
      if (triggerBtnIsIcon) {
        triggerBtnElement.classList.add("ciba-video-ocr-trigger-btn--icon");
      } else {
        scheduleTriggerBtnMorph();
      }
      triggerBtnElement.style.setProperty('display', 'none', 'important'); // 🔧 先藏，防闪现
      chrome.storage.sync.get({ enabled: true }, (result) => {
        if (result.enabled) { triggerBtnElement.style.removeProperty('display'); } else { triggerBtnElement.style.setProperty('display', 'none', 'important'); }
      });
      return;
    }
    triggerBtnElement = document.createElement("button");
    triggerBtnElement.id = "ciba-video-ocr-trigger-btn";
    triggerBtnElement.innerHTML = `<span>暂停键识别字幕</span>`;
    triggerBtnElement.setAttribute("title", "暂停键识别字幕");
    triggerBtnElement.style.setProperty('display', 'none', 'important'); // 🔧 先藏，防闪现
    triggerBtnElement.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!ocrEnabled) {
        ocrEnabled = true;
        document.getElementById("ciba-video-ocr-toggle-text").textContent = "⏸ 暂停识别";
        setTriggerBtnText("暂停键识别字幕");
        showToast("OCR 已恢复 ✅", false, 1500);
        const detailEl = document.getElementById("ciba-video-ocr-word-detail");
        if (detailEl && detailEl.innerHTML === '已暂停字幕识别') {
          detailEl.style.display = 'flex';
          detailEl.innerHTML = '点击单词翻译';
        }
        return;
      }
      captureAndRecognize();
    });
    (document.body || document.documentElement).appendChild(triggerBtnElement);
    scheduleTriggerBtnMorph(); // 🆕 加载后 3 秒变形为圆形 logo
    chrome.storage.sync.get({ enabled: true }, (result) => {
      if (result.enabled) { triggerBtnElement.style.removeProperty('display'); } else { triggerBtnElement.style.setProperty('display', 'none', 'important'); }
    });
  }

  // ===== 🔑 改动 1：通用 findVideoElement（适配所有视频网站）=====
  function findVideoElement() {
    // 通用：收集所有 video，按"正在播放 + 尺寸最大 + 可见"排序，返回最可能是主视频的那个
    const allVideos = Array.from(document.querySelectorAll('video'));
    if (allVideos.length === 0) {
      // 兜底：尝试从 shadow DOM 里找
      let found = null;
      function search(node) {
        if (!node || found) return;
        if (node.tagName === "VIDEO") { found = node; return; }
        if (node.shadowRoot) search(node.shadowRoot);
        if (node.children) { for (let i = 0; i < node.children.length; i++) search(node.children[i]); }
      }
      search(document.body || document.documentElement);
      return found;
    }
    // 过滤掉隐藏或尺寸极小的（广告、背景视频等）
    const visibleVideos = allVideos.filter(v => {
      const rect = v.getBoundingClientRect();
      return rect.width > 200 && rect.height > 100 && v.offsetWidth > 0;
    });
    const candidates = visibleVideos.length > 0 ? visibleVideos : allVideos;
    // 排序：正在播放的优先，其次尺寸最大的优先
    candidates.sort((a, b) => {
      if (a.paused !== b.paused) return a.paused ? 1 : -1;
      return (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight);
    });
    return candidates[0];
  }

  // ===== 🔑 改动 2：两层 hideControlBar（适配所有网站控制栏）=====
  function hideControlBar() {
    // 第一层：按 class 名匹配（腾讯 + 通用模糊）
    const named_selectors = [
      '.txp_controls', '.plugin_ctrl_txp_bottom', '.plugin_ctrl_txp_gradient_bottom',
      '[class*="controlbar"]', '[class*="control_bar"]', '[class*="video-controls"]',
      '[class*="controls"]', '[class*="player-control"]'
    ];
    named_selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 5 && rect.height < 150) {
          el.dataset.cibaHidden = '1';
          el.style.display = 'none'; el.style.visibility = 'hidden'; el.style.opacity = '0';
        }
      });
    });

    // 第二层：按位置特征兜底（不管 class 叫什么，B站/YouTube/爱奇艺/优酷…都能命中）
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    document.querySelectorAll('*').forEach(el => {
      if (el.dataset.cibaHidden) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const pos = style.position;
      if (pos !== 'fixed' && pos !== 'absolute') return;
      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.2 || rect.height < 30 || rect.height > 150) return;
      // 底部附近
      if (rect.bottom > vh - 10 && rect.top > vh * 0.6) {
        el.dataset.cibaHidden = '1';
        el.style.display = 'none'; el.style.visibility = 'hidden'; el.style.opacity = '0';
      }
    });
  }

  // ===== 🔑 改动 3：showControlBar 改为按标记恢复 =====
  function showControlBar() {
    document.querySelectorAll('[data-ciba-hidden="1"]').forEach(el => {
      delete el.dataset.cibaHidden;
      el.style.display = ''; el.style.visibility = ''; el.style.opacity = '';
    });
  }

  function captureAndRecognizeVideo(settings, sessionId) {
    return new Promise((resolve) => {
      hideControlBar();
      const video = findVideoElement();
      if (!video) { showToast("❌ 未定位到播放器视频元素", false); showControlBar(); resolve(); return; }
      showToast("正在截取字幕并识别...", true);
      try {
        const vw = video.videoWidth || video.clientWidth;
        const vh = video.videoHeight || video.clientHeight;
        if (!vw || !vh) { showToast("❌ 视频未加载或格式不受支持", false); showControlBar(); resolve(); return; }
        const cropPixelHeight = Math.min(settings.cropPixelHeight || 120, vh);
        const sy = vh - cropPixelHeight;
        const sh = cropPixelHeight;
        const canvas = document.createElement("canvas");
        canvas.width = vw * 2;
        canvas.height = sh * 2;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(video, 0, sy, vw, sh, 0, 0, vw * 2, sh * 2);
        canvas.toBlob(async (blob) => {
          if (!blob) { showToast("❌ 画面截取失败", false); showControlBar(); resolve(); return; }
          lastCapturedBlob = blob;
          const fullCanvas = document.createElement("canvas");
          fullCanvas.width = vw;
          fullCanvas.height = vh;
          const fullCtx = fullCanvas.getContext("2d");
          fullCtx.drawImage(video, 0, 0, vw, vh);
          fullCanvas.toBlob((fullBlob) => { lastFullVideoBlob = fullBlob; }, "image/png");
          const formData = new FormData();
          formData.append("file", blob, "subtitle.png");
          const apiUrl = "https://www.cibaen.com/ocr-service/ocr";
          try {
            const response = await fetch(apiUrl, { method: "POST", body: formData, headers: { "Accept": "*/*" } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const res = await response.json();
            // 🆕 用户在识别期间已恢复播放，作废本次结果，不再弹窗
            if (sessionId !== undefined && sessionId !== ocrSessionId) { hideToast(); return; }
            if (res.code === 200) {
              showResultCard(res.data.text || "", res.data.elapse || 0, res.data.details || [], false);
            } else {
              showToast(`❌ OCR 识别异常: ${res.msg || "识别失败"}`, false);
              showResultCard(`[服务器异常] ${res.msg || "识别失败"}`, 0, [], false);
            }
          } catch (err) {
            // 🆕 会话已作废（用户恢复播放）时不再提示失败
            if (sessionId !== undefined && sessionId !== ocrSessionId) { hideToast(); return; }
            showToast(`❌ 接口调用失败: ${err.message}`, false);
            showResultCard(`[请求失败]\n${err.message}`, 0, [], false);
          } finally {
            showControlBar(); resolve();
          }
        }, "image/png");
      } catch (err) {
        showToast(`❌ 截图失败: ${err.message}`, false);
        showControlBar(); resolve();
      }
    });
  }

  // 🆕 隐私同意门控：未同意时弹可勾选同意卡片，不触发 OCR 截图/识别
  async function captureAndRecognize() {
    if (!ocrEnabled) return;
    const agreed = await new Promise(res => chrome.storage.local.get('privacyAgreed', r => res(!!r.privacyAgreed)));
    if (!agreed) { showPrivacyNoticeCard(); return; }
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    if (settings.enabled === false) return;
    const sessionId = ++ocrSessionId; // 🆕 本次识别会话号
    await captureAndRecognizeVideo(settings, sessionId);
  }

  // ===== 查词 =====
  // targetEl：释义渲染目标（默认 OCR 卡详情区；YouTube 覆盖层传自己的卡片容器）
  function searchWordInCard(word, sentence, targetEl) {
    const detailEl = targetEl || document.getElementById('ciba-video-ocr-word-detail');
    if (!detailEl) return;

    // 🆕 隐私同意门控：未同意时不弹登录二维码，改弹同意卡片
    chrome.storage.local.get('privacyAgreed', function(result) {
      if (!result.privacyAgreed) {
        if (detailEl) { detailEl.style.display = 'none'; detailEl.style.height = ''; detailEl.style.overflowY = ''; }
        showPrivacyNoticeCard();
        return;
      }

      // 已同意：继续原有逻辑
      currentWord = word;
      currentSentence = sentence || '';

      const isYtOverlay = !!(detailEl.closest && detailEl.closest('.ciba-yt-overlay-card'));
      detailEl.style.display = 'block';
      if (!isYtOverlay) {
        detailEl.style.height = '180px';
        detailEl.style.overflowY = 'auto';
        detailEl.innerHTML = `<div class="ciba-video-ocr-word-detail__loading">数据获取中...</div>`;
      } else {
        // YT 覆盖层：未登录时要弹二维码，先不显示"数据获取中"
        detailEl.innerHTML = '';
      }

      getToken().then((value) => {
        if (!value || !value.ciba_token) {
          // YouTube 覆盖层释义卡：二维码直接渲染进卡内释义区
          if (isYtOverlay) {
            detailEl.innerHTML = '';
            detailEl.style.height = '';
            detailEl.style.overflowY = '';
            // 放开 CSS 里的 200px 限高，保证二维码 + Apple 登录按钮完整显示
            detailEl.style.setProperty('max-height', '440px', 'important');
            showLoginQR(detailEl, word, sentence, detailEl);
          } else {
            detailEl.style.display = 'none';
            detailEl.style.height = '';
            detailEl.style.overflowY = '';
            showLoginQRInBody(word, sentence);
          }
          return;
        }

        // 已登录：恢复默认限高；YT 覆盖层此时才显示加载态
        detailEl.style.removeProperty('max-height');
        if (isYtOverlay) {
          detailEl.innerHTML = `<div class="ciba-video-ocr-word-detail__loading">数据获取中...</div>`;
        }

        const token = value.ciba_token;
        const url = `${SERVER_API}/words/search.json?token=${encodeURIComponent(token)}&wordName=${encodeURIComponent(word)}`;

        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          try {
            const resp = JSON.parse(xhr.responseText);
            const w = resp.word;
            if (!w) { setHtml(detailEl, `<div class="ciba-video-ocr-word-detail__error">未找到该单词</div>`); return; }

            const pronEN = w.phEn ? `[${w.phEn}]` : '';
            const enAudio = w.phEnMp3 || '';
            const pronUS = w.phAm ? `[${w.phAm}]` : '';
            const amAudio = w.phAmMp3 || '';
            const isAdded = w.added;

            let interpretHtml = '';
            if (w.speechParts) {
              for (const sp of w.speechParts) {
                interpretHtml += `<div class="ciba-video-ocr-word-detail__part"><span class="ciba-video-ocr-word-detail__pos">${sp.partName}</span> `;
                if (sp.means) for (const m of sp.means) interpretHtml += `<span class="ciba-video-ocr-word-detail__mean">${m.wordMean};</span>`;
                interpretHtml += `</div>`;
              }
            }

            setHtml(detailEl, `
              <div class="ciba-video-ocr-word-detail__word">${w.name || word}</div>
              <div class="ciba-video-ocr-word-detail__pron">
                ${pronEN ? `<span>英 ${pronEN}</span> <span class="ciba-video-ocr-word-detail__audio" data-url="${enAudio}">🔊</span>` : ''}
                ${pronUS ? `<span style="margin-left:12px;">美 ${pronUS}</span> <span class="ciba-video-ocr-word-detail__audio" data-url="${amAudio}">🔊</span>` : ''}
              </div>
              <div class="ciba-video-ocr-word-detail__interpret">${interpretHtml}</div>
              ${isAdded ? `<div class="ciba-video-ocr-word-detail__added">✅ 已在生词本</div>` : ''}
            `);

            detailEl.querySelectorAll('.ciba-video-ocr-word-detail__audio').forEach(el => {
              el.addEventListener('click', () => {
                const u = el.getAttribute('data-url');
                if (u) { if (!audioElement) audioElement = new Audio(); audioElement.src = u; audioElement.play(); }
              });
            });
          } catch (e) {
            setHtml(detailEl, `<div class="ciba-video-ocr-word-detail__error">解析失败</div>`);
          }
        };
        xhr.send();
      }).catch(err => {
        setHtml(detailEl, `<div class="ciba-video-ocr-word-detail__error">获取token失败: ${err.message}</div>`);
      });
    });
  }

  // ===== 🆕 独立出来的保存单词函数（改为接收 wordName + caption 参数，避免竞态读到空值） =====
  function saveWordToServer(token, picFileUrl, wordName, caption) {
    showToast('正在保存...', true);
    const xhrSave = new XMLHttpRequest();
    xhrSave.open("POST", `${SERVER_API}/anki/movie2card.json?token=${encodeURIComponent(token)}`, true);
    xhrSave.setRequestHeader("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    xhrSave.onreadystatechange = function () {
      if (xhrSave.readyState !== 4) return;
      hideToast();
      try {
        const saveResp = JSON.parse(xhrSave.responseText);
        if (saveResp && saveResp.result == 0) {
          showToast(`"${wordName}" 已添加到单词本 ✅`, false);
          hideResultCard();
          // YouTube 覆盖层：添加成功即关闭释义卡并继续播放视频
          if (IS_YOUTUBE) ytCloseOverlayCard(true);
        } else if (saveResp && saveResp.result == -10001) {
          showToast('登录已过期，请重新扫码登录', false);
        } else {
          const errorMsg = (saveResp.ex && saveResp.ex.msg) || saveResp.msg || '添加失败，请稍后重试';
          showToast(errorMsg, false);
        }
      } catch (e) {
        showToast('保存失败：响应解析错误', false);
      }
    };
    let params = `wordName=${encodeURIComponent(wordName)}` +
      `&englishCaption=${encodeURIComponent(caption || '')}`;
    if (picFileUrl) {
      params += `&picFileUrl=${encodeURIComponent(picFileUrl)}`;
    }
    xhrSave.send(params);
  }

  // ===== 🆕 加词（受 allowScreenshotUpload 开关控制，默认值从 DEFAULT_SETTINGS 统一读取）=====
  function addWordToNotebook() {
    if (!currentWord || !currentWord.trim()) {
      showToast('请先选择单词', false);
      return;
    }

    // 🆕 捕获当前值到局部变量，防止异步期间全局被重置导致发空白单词
    const wordToSave = currentWord.trim();
    const captionToSave = currentSentence || '';

    // 🆕 隐私同意门控
    chrome.storage.local.get('privacyAgreed', function(result) {
      if (!result.privacyAgreed) { showPrivacyNoticeCard(); return; }

      getToken().then((value) => {
        if (!value || !value.ciba_token) {
          showToast('请先登录糍粑账户', false);
          return;
        }

        const token = value.ciba_token;

        // 🔧 从 DEFAULT_SETTINGS 统一读取配置（含 allowScreenshotUpload 默认值）
        chrome.storage.sync.get(DEFAULT_SETTINGS, function(uploadSettings) {
          if (!uploadSettings.allowScreenshotUpload || !lastFullVideoBlob) {
            // 未开启上传或没有截图，直接保存（不带图）
            saveWordToServer(token, '', wordToSave, captionToSave);
            return;
          }

          // 允许上传且有截图，走七牛上传流程
          showToast('正在上传截图...', true);
          blobToBase64(lastFullVideoBlob).then((base64Data) => {
            const base64Str = base64Data.replace(/^data:.*;base64,/, '');
            const fileName = generateUuid(16) + '.png';

            const xhrToken = new XMLHttpRequest();
            xhrToken.open("POST", `${SERVER_API}/anki/file/token.json`, true);
            xhrToken.setRequestHeader("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
            xhrToken.onreadystatechange = function () {
              if (xhrToken.readyState !== 4) return;
              try {
                const resp = JSON.parse(xhrToken.responseText);
                if (resp.result !== 0) {
                  hideToast();
                  saveWordToServer(token, '', wordToSave, captionToSave); // 获取凭证失败，跳过截图
                  return;
                }

                const { url: picFileUrl, token: uptoken, fileKey } = resp;
                const base64Key = base64EncodeUrlSafe(fileKey);
                const uploadUrl = `https://upload.qiniup.com/putb64/-1/key/${base64Key}`;

                const xhrUpload = new XMLHttpRequest();
                xhrUpload.open("POST", uploadUrl, true);
                xhrUpload.setRequestHeader("Authorization", `UpToken ${uptoken}`);
                xhrUpload.setRequestHeader("Content-Type", "application/octet-stream");
                xhrUpload.onreadystatechange = function () {
                  if (xhrUpload.readyState !== 4) return;
                  hideToast();
                  try {
                    JSON.parse(xhrUpload.responseText);
                    saveWordToServer(token, picFileUrl, wordToSave, captionToSave); // 上传成功，带图保存
                  } catch (e) {
                    saveWordToServer(token, '', wordToSave, captionToSave); // 上传失败，跳过截图
                  }
                };
                xhrUpload.send(base64Str);
              } catch (e) {
                hideToast();
                saveWordToServer(token, '', wordToSave, captionToSave); // 异常，跳过截图
              }
            };
            xhrToken.send(`name=${encodeURIComponent(fileName)}&token=${encodeURIComponent(token)}`);
          }).catch(() => {
            hideToast();
            saveWordToServer(token, '', wordToSave, captionToSave); // 图片处理失败，跳过截图
          });
        });
      }).catch(err => { showToast(`添加失败: ${err.message}`, false); });
    });
  }

  // ===== 通过 Apple 登录（仅 Safari）：与 popup/content_script 同套显隐规则 =====
  // pendingLoginRetry：Apple 路径在别的标签页完成登录后，由 storage.onChanged 监听重试查词
  // WeChat 路径自己已在 setTimeout 里处理重试，故不写入此变量，避免双重重试
  let pendingLoginRetry = null;
  let appleLoginOcrChecked = false;
  function isSafariExt(){
    try { return chrome.runtime.getURL('').indexOf('safari-web-extension://') === 0 } catch (e) { return false }
  }
  function refreshAppleLoginOcrBtn(btn) {
    if (!isSafariExt() || !btn) return;
    if (appleLoginOcrChecked) {
      // 之前已查过配置；按缓存结果决定显隐
      if (btn.dataset.cibaAppleShow === '1') btn.style.display = 'flex';
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://cibaen.com/client-config.json", true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState != 4) return;
      appleLoginOcrChecked = true;
      try {
        const config = JSON.parse(xhr.responseText);
        if (config && config.appleLoginEnabled) {
          btn.dataset.cibaAppleShow = '1';
          btn.style.display = 'flex';
        }
      } catch (e) {
        // 解析失败 fail-open
        btn.dataset.cibaAppleShow = '1';
        btn.style.display = 'flex';
      }
    };
    xhr.onerror = function () {
      appleLoginOcrChecked = true;
      btn.dataset.cibaAppleShow = '1';
      btn.style.display = 'flex';
    };
    xhr.send();
  }

  // ===== 登录二维码 =====
  // container：二维码渲染容器；searchTargetEl：登录成功后重新查词的释义渲染目标（YT 覆盖层传卡内释义区）
  function showLoginQR(container, word, sentence, searchTargetEl) {
    if (!container) return;
    if (container.querySelector('.ciba-video-ocr-login-qr')) return;

    const qrWrap = document.createElement('div');
    qrWrap.className = 'ciba-video-ocr-login-qr';
    qrWrap.innerHTML = `
      <div class="ciba-video-ocr-login-qr__title">微信扫码登录后可使用查词功能</div>
      <div class="ciba-video-ocr-login-qr__img-wrap">
        <img class="ciba-video-ocr-login-qr__img" src="" alt="加载中..." />
      </div>
      <div class="ciba-video-ocr-login-qr__status">正在获取二维码...</div>
      <div class="ciba-video-ocr-login-qr__hint">微信扫一扫，自动继续查词</div>
    `;
    container.appendChild(qrWrap);

    const imgEl = qrWrap.querySelector('.ciba-video-ocr-login-qr__img');
    const statusEl = qrWrap.querySelector('.ciba-video-ocr-login-qr__status');

    // 通过 Apple 登录（仅 Safari + appleLoginEnabled 开启时显示）
    const appleBtn = document.createElement('div');
    appleBtn.className = 'ciba-video-ocr-login-qr__apple';
    appleBtn.style.cssText = 'display:none;margin-top:10px;padding:6px 12px;background:#000;color:#fff;border-radius:6px;font-size:12px;cursor:pointer;text-align:center;user-select:none;align-items:center;justify-content:center;gap:6px;';
    appleBtn.innerHTML = '<svg viewBox="0 0 384 512" style="width:11px;height:11px;fill:#fff;margin-bottom:1px;" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg><span>通过 Apple 登录</span>';
    appleBtn.onmouseenter = function () { appleBtn.style.opacity = '0.85'; };
    appleBtn.onmouseleave = function () { appleBtn.style.opacity = '1'; };
    appleBtn.onclick = function () {
      // 记住本次待重试的查词请求，登录成功后由 storage.onChanged 监听重试
      pendingLoginRetry = { word: word, sentence: sentence, searchTargetEl: searchTargetEl };
      let relay = '';
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      for (let i = 0; i < 16; i++) relay += chars.charAt(Math.floor(Math.random() * chars.length));
      // content script 没 tabs 权限，sendMessage 让 service worker 创建新 tab
      chrome.runtime.sendMessage({
        action: 'appleLoginStart',
        relay: relay,
        url: 'https://cibaen.com/apple-login.html?relay=' + relay
      });
    };
    qrWrap.appendChild(appleBtn);
    refreshAppleLoginOcrBtn(appleBtn);

    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${SERVER_API}/wechat/service/follow_qrcode/reg.json`, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      try {
        const resp = JSON.parse(xhr.responseText);
        // 二维码 URL 由服务器下发：仅接受 https 链接，拒绝其它协议
        if (resp && resp.result == 0 && typeof resp.url === 'string' && /^https:\/\//i.test(resp.url)) {
          imgEl.src = resp.url;
          imgEl.style.display = 'block';
          statusEl.textContent = '请使用微信扫码';
          startLoginPoll(resp.key, word, sentence, qrWrap, searchTargetEl);
        } else {
          const errorMsg = (resp.ex && resp.ex.msg) || resp.msg || '获取二维码失败';
          statusEl.textContent = errorMsg;
        }
      } catch (e) {
        statusEl.textContent = '获取二维码失败，请刷新重试';
      }
    };
    xhr.send();
  }

  // OCR 卡片：二维码嵌到卡片 body 内
  function showLoginQRInBody(word, sentence) {
    showLoginQR(document.querySelector('.ciba-video-ocr-body'), word, sentence, null);
  }

  function startLoginPoll(qrcodeKey, word, sentence, qrWrap, searchTargetEl) {
    if (bodyLoginPollTimer) clearInterval(bodyLoginPollTimer);

    const statusEl = qrWrap.querySelector('.ciba-video-ocr-login-qr__status');

    bodyLoginPollTimer = setInterval(() => {
      if (!qrcodeKey) return;

      const xhr = new XMLHttpRequest();
      xhr.open("GET", `${SERVER_API}/wechat/service/follow_qrcode/reg/result.json?key=${qrcodeKey}`, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        try {
          const resp = JSON.parse(xhr.responseText);
          if (resp && resp.result == 0 && resp.token) {
            clearInterval(bodyLoginPollTimer);
            chrome.storage.local.set({ ciba_token: resp.token }, () => {
              updateAddButtonState();
              statusEl.textContent = '登录成功！';
              setTimeout(() => {
                qrWrap.remove();
                // 登录成功后回到原释义容器继续查词（YT 覆盖层会传自己的释义区）
                if (word) searchWordInCard(word, sentence, searchTargetEl || undefined);
              }, 600);
            });
          }
        } catch (e) { /* 静默等待 */ }
      };
      xhr.send();
    }, 2000);
  }

  // ===== 🆕 广告/轮播视频识别 & 用户操作追踪（避免首页轮播广告反复触发 OCR）=====
  let lastUserGestureTs = 0;
  const USER_GESTURE_WINDOW = 3000; // 暂停前 3s 内需有用户点击/按键，才认为是有意暂停

  function markUserGesture() { lastUserGestureTs = Date.now(); }
  function hasRecentUserGesture() { return Date.now() - lastUserGestureTs <= USER_GESTURE_WINDOW; }

  function initUserGestureTracking() {
    // pointerdown 已覆盖鼠标/触摸/触控笔，keydown 覆盖键盘操作
    ['pointerdown', 'keydown'].forEach((type) => {
      window.addEventListener(type, markUserGesture, true);
    });
  }

  // 判断一个 video 是否像"轮播广告宣传片"，这类视频的 play/pause 不该触发 OCR
  // 注意：只认"静音 + 循环"这种强特征，避免误伤 muted/autoplay 的正常播放器
  function isLikelyAdVideo(video) {
    if (!video || video.tagName !== 'VIDEO') return true;
    if (video.muted && video.loop) return true;
    return false;
  }

  // 判断这次 pause 是否由用户主动发起
  function isUserInitiatedPause(video) {
    if (!video) return false;
    if (video.ended) return false; // 播放自然结束，不算用户暂停
    return hasRecentUserGesture(); // 无近期用户操作，视为自动暂停
  }

  function setupGlobalListeners() {
    initUserGestureTracking();

    window.addEventListener("pause", (e) => {
      const video = e.target;
      if (!video || video.tagName !== 'VIDEO') return;
      // 🆕 YouTube：字幕由视频内覆盖层接管，"暂停→OCR 识别"不再触发
      if (IS_YOUTUBE) return;
      // 🔧 忽略轮播广告/自动播放视频的 pause
      if (isLikelyAdVideo(video)) return;
      // 🔧 只响应主视频的 pause，忽略其它 video 的 pause
      if (video !== findVideoElement()) return;
      // 🔧 必须是用户主动暂停（播放结束、无用户操作触发的自动暂停都不算）
      if (!isUserInitiatedPause(video)) return;
      if (!ocrEnabled) return; // 🆕 关了不识别
      captureAndRecognize();
    }, true);

    window.addEventListener("play", (e) => {
      const video = e.target;
      if (!video || video.tagName !== 'VIDEO') return;
      // 🔧 忽略轮播广告/自动播放视频的 play，不因其跳动而关闭结果卡片
      if (isLikelyAdVideo(video)) return;
      // 🔧 只响应主视频的 play，忽略其它 video 的 play
      if (video !== findVideoElement()) return;
      // 🆕 主视频恢复播放：作废在途的识别会话，避免 OCR 结果晚到又弹窗
      ocrSessionId++;
      setTimeout(() => {
        hideResultCard();
        hideToast();
        showControlBar();
      }, 800);
    }, true);
  }

  // ===== 🆕 监听 options 配置变化 =====
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled) {
      const btn = triggerBtnElement || document.getElementById("ciba-video-ocr-trigger-btn");
      if (btn) { if (changes.enabled.newValue) { btn.style.removeProperty('display'); } else { btn.style.setProperty('display', 'none', 'important'); } }
    }
  });

  // ===== 🆕 监听 Apple 登录（local 写 token）：收起登录 QR 并重试查词 =====
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.ciba_token || !changes.ciba_token.newValue) return;
    if (pendingLoginRetry) {
      const r = pendingLoginRetry;
      pendingLoginRetry = null;
      if (r.word) searchWordInCard(r.word, r.sentence, r.searchTargetEl || undefined);
    }
    // 兜底收起登录 QR（WeChat 路径自己的 setTimeout 也会 remove，这里幂等再 remove 一次）
    document.querySelectorAll('.ciba-video-ocr-login-qr').forEach(el => el.remove());
    if (bodyLoginPollTimer) { clearInterval(bodyLoginPollTimer); bodyLoginPollTimer = null; }
  });


  // ===== 🆕 隐私告知卡片（与 popup 同绿色系，可勾选同意，右上角可关闭）=====
  function showPrivacyNoticeCard() {
    // 防止重复弹出
    if (document.getElementById('privacy-notice-card')) return;

    const card = document.createElement('div');
    card.id = 'privacy-notice-card';
    card.style.cssText = `
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

    card.innerHTML = `
        <button id="privacy-close-btn" title="关闭" aria-label="关闭"
          style="position:absolute; top:10px; right:10px; width:28px; height:28px;
                 display:flex; align-items:center; justify-content:center;
                 background:transparent; border:none; border-radius:6px; cursor:pointer;
                 font-size:20px; line-height:1; color:#94a3b8; transition:all .2s;">×</button>
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
            <span style="display: inline-block; width: 8px; height: 8px; background: #07c160; border-radius: 50%; margin-right: 8px;"></span>
            <strong style="font-size: 18px; color: #333;">首次使用须知</strong>
        </div>
        <div style="color: #555; margin-bottom: 20px; font-size: 14px;">
            本扩展会收集您主动暂停视频时截取的字幕画面用于本地 OCR 识别，识别文本及字幕截图（如已开启）仅用于向 cibaen.com 查词和加入生词本。使用前请先阅读并同意我们的<a href="https://cibaen.com/privacy-policy.html" target="_blank" rel="noopener noreferrer" style="color: #07c160; text-decoration: underline;">《隐私政策》</a>。
        </div>
        <div style="display: flex; align-items: center; margin-bottom: 24px;">
            <input type="checkbox" id="privacy-checkbox" style="width: 16px; height: 16px; margin-right: 8px; accent-color: #07c160; cursor: pointer;">
            <label for="privacy-checkbox" style="font-size: 14px; color: #333; cursor: pointer;">我已阅读并同意《隐私政策》</label>
        </div>
        <button id="privacy-confirm-btn" style="
            width: 100%;
            padding: 12px 0;
            background: #07c160;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            opacity: 0.5;
            transition: opacity 0.2s;
            line-height:1;
        ">确认并继续使用</button>
    `;

    document.body.appendChild(card);

    const checkbox = document.getElementById('privacy-checkbox');
    const btn = document.getElementById('privacy-confirm-btn');
    const closeBtn = document.getElementById('privacy-close-btn');

    // 关闭按钮 hover（变白）
    closeBtn.onmouseenter = function() { this.style.background = 'rgba(0,0,0,0.06)'; this.style.color = '#333'; };
    closeBtn.onmouseleave = function() { this.style.background = 'transparent'; this.style.color = '#94a3b8'; };
    // 关闭：仅移除卡片，不做同意
    closeBtn.addEventListener('click', function() { card.remove(); });

    checkbox.addEventListener('change', () => {
        btn.style.opacity = checkbox.checked ? '1' : '0.5';
        btn.style.cursor = checkbox.checked ? 'pointer' : 'not-allowed';
    });

    btn.addEventListener('click', () => {
        if (!checkbox.checked) return;
        chrome.storage.local.set({ privacyAgreed: true }, () => {
            card.remove();
            if (currentWord) {
                searchWordInCard(currentWord);
            } else {
                captureAndRecognize();
            }
        });
    });
  }

  // ===================== 🆕 YouTube 视频内字幕（LR 风格） =====================
  // 从播放器已加载的字幕轨（人工/ASR）取内容，画在视频画面里，
  // 点击单词查词 + 加入单词本；有字幕显示期间视觉隐藏原生 CC。
  const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(location.hostname || '');

  let ytCues = [];          // [{start, dur, text}]
  let ytLastNavUrl = '';
  let ytLoadingToken = 0;
  let ytVideoEl = null;     // 缓存的主 video（timeupdate 监听挂它身上）
  let ytOverlayCurIdx = -1; // 当前渲染的字幕行索引，避免重复渲染
  let ytSubsLoading = false; // 字幕轨获取中（在字幕区显示"获取字幕中..."）

  // ---- 桥接通信（隔离世界 ↔ MAIN world） ----
  function ytBridgeRequest(action, payload) {
    return new Promise((resolve, reject) => {
      const id = 'ytciba_' + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('桥接脚本无响应'));
      }, 15000);
      function onMsg(e) {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.type !== 'CIBA_YT_SUBS_RESP' || d.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        if (d.ok) resolve(d.data);
        else reject(new Error((d.data && d.data.reason) || '桥接失败'));
      }
      window.addEventListener('message', onMsg);
      window.postMessage(Object.assign({ type: 'CIBA_YT_SUBS_REQ', id: id, action: action }, payload || {}), '*');
    });
  }

  // ---- 选轨：人工英文轨 > 人工轨 > 自动英文轨 > 自动轨 ----
  function ytPickTrack(tracks) {
    const isEn = (t) => /^en/i.test(t.languageCode || '');
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const asr = tracks.filter((t) => t.kind === 'asr');
    return manual.find(isEn) || manual[0] || asr.find(isEn) || asr[0] || tracks[0];
  }

  // ---- json3 → 简化 cue 列表 ----
  function ytBuildCues(json3) {
    const cues = [];
    for (const ev of (json3.events || [])) {
      if (!ev.segs && !ev.utf8) continue;
      let text = ev.segs ? ev.segs.map((s) => s.utf8 || '').join('') : (ev.utf8 || '');
      text = (text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // 跳过纯换行/空白事件
      const start = ev.tStartMs / 1000;
      const dur = (ev.dDurationMs || 0) / 1000;
      cues.push({ start, dur, text });
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  function ytEscapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- 关闭释义卡：清二维码/轮询，可选恢复播放 ----
  function ytCloseOverlayCard(resumeVideo) {
    const cardEl = document.getElementById('ciba-yt-overlay-card');
    if (cardEl) cardEl.classList.remove('ciba-yt-overlay-card--show');
    // 关卡时清掉卡内登录二维码与轮询
    const ytDetail = document.getElementById('ciba-yt-overlay-detail');
    const ytQr = ytDetail && ytDetail.querySelector('.ciba-video-ocr-login-qr');
    if (ytQr) ytQr.remove();
    if (bodyLoginPollTimer) { clearInterval(bodyLoginPollTimer); bodyLoginPollTimer = null; }
    // 关卡后恢复播放（点词时暂停过）
    if (resumeVideo !== false) {
      const video = findVideoElement();
      if (video && video.paused) video.play();
    }
  }

  // ---- 覆盖层注入（挂在 #movie_player 里，全屏天然支持） ----
  function ytInjectOverlay() {
    if (document.getElementById('ciba-yt-video-overlay')) return true;
    const player = document.getElementById('movie_player');
    if (!player || !player.querySelector('video')) return false;
    const overlay = document.createElement('div');
    overlay.id = 'ciba-yt-video-overlay';
    overlay.className = 'ciba-yt-video-overlay';
    overlay.innerHTML = `
      <div class="ciba-yt-overlay-card" id="ciba-yt-overlay-card">
        <div class="ciba-yt-overlay-card__close" id="ciba-yt-overlay-card-close" title="关闭">×</div>
        <div class="ciba-video-ocr-word-detail ciba-yt-overlay-detail" id="ciba-yt-overlay-detail"></div>
        <button class="ciba-video-ocr-add-btn ciba-yt-overlay-add-btn" id="ciba-yt-overlay-add-btn" title="添加到单词本">
          <span style="color:#ffffff !important;">添加到单词本</span>
        </button>
      </div>
      <div class="ciba-yt-overlay-line" id="ciba-yt-overlay-line"></div>
    `;
    player.appendChild(overlay);

    // 点词：暂停 + 查词 + 弹释义卡
    document.getElementById('ciba-yt-overlay-line').addEventListener('click', (e) => {
      const span = e.target.closest('.ciba-video-ocr-word');
      if (!span) return;
      const word = span.textContent.trim();
      const lineEl = document.getElementById('ciba-yt-overlay-line');
      const sentence = lineEl.getAttribute('data-raw') || word;
      currentWord = word;
      currentSentence = sentence;
      const video = findVideoElement();
      if (video && !video.paused) video.pause(); // 暂停便于细看释义
      document.getElementById('ciba-yt-overlay-card').classList.add('ciba-yt-overlay-card--show');
      searchWordInCard(word, sentence, document.getElementById('ciba-yt-overlay-detail'));
    });
    document.getElementById('ciba-yt-overlay-card-close').addEventListener('click', () => {
      ytCloseOverlayCard(true);
    });
    document.getElementById('ciba-yt-overlay-add-btn').addEventListener('click', addWordToNotebook);
    updateAddButtonState();
    // 悬停快显释义（气泡只显示一条释义，不打断播放，未登录不弹）
    ytSetupHoverTip();
    return true;
  }

  // ===================== 🆕 悬停快显释义 =====================
  // LR 式 hover 小气泡：只显示一条中文释义；内存缓存 + 请求序号防竞态。
  const ytHoverDictCache = new Map(); // word -> 释义字符串 | null（null = 已查过无释义）
  let ytHoverTipEl = null;
  let ytHoverReqNum = 0;
  let ytHoverHideTimer = null;
  let ytHoverPaused = false; // 本次悬停触发过自动暂停（滑出时据此恢复播放）

  function ytHideHoverTip() {
    if (ytHoverTipEl) ytHoverTipEl.classList.remove('ciba-yt-hover-tip--show');
  }

  function ytShowHoverTip(anchorEl, text) {
    if (!ytHoverTipEl) return;
    if (!text) return;
    ytHoverTipEl.textContent = text;
    // 定位到单词上方
    const r = anchorEl.getBoundingClientRect();
    const player = document.getElementById('movie_player');
    const pr = player ? player.getBoundingClientRect() : { left: 0, top: 0 };
    let x = r.left - pr.left + r.width / 2;
    let y = r.top - pr.top - 16; // 距单词再留大一点的间隙
    // 限制在播放器内
    const tipW = Math.min(280, (player ? player.clientWidth : 400) - 16);
    x = Math.max(tipW / 2 + 8, Math.min(x, (player ? player.clientWidth : 400) - tipW / 2 - 8));
    if (y < 4) y = r.bottom - pr.top + 16; // 上方放不下就放下方
    ytHoverTipEl.style.left = x + 'px';
    ytHoverTipEl.style.top = y + 'px';
    ytHoverTipEl.classList.add('ciba-yt-hover-tip--show');
  }

  // ---- 词形还原：小规则表 + 常见不规则动词 ----
  const YT_IRREGULAR = {
    was: 'be', were: 'be', been: 'be', is: 'be', are: 'be', am: 'be',
    went: 'go', gone: 'go', made: 'make', got: 'get', gotten: 'get',
    took: 'take', taken: 'take', came: 'come', saw: 'see', seen: 'see',
    knew: 'know', known: 'know', thought: 'think', found: 'find',
    told: 'tell', said: 'say', ran: 'run', run: 'run', began: 'begin',
    begun: 'begin', felt: 'feel', left: 'leave', kept: 'keep',
    held: 'hold', brought: 'bring', bought: 'buy', taught: 'teach',
    wrote: 'write', written: 'write', spoke: 'speak', spoken: 'speak',
    gave: 'give', given: 'give', grew: 'grow', grown: 'grow',
    became: 'become', fell: 'fall', fallen: 'fall', broke: 'break',
    broken: 'break', chose: 'choose', chosen: 'choose', drove: 'drive',
    driven: 'drive', ate: 'eat', eaten: 'eat', wore: 'wear', worn: 'wear',
    won: 'win', lost: 'lose', met: 'meet', paid: 'pay', sent: 'send',
    built: 'build', sat: 'sit', stood: 'stand', understood: 'understand',
    meant: 'mean'
  };
  function ytLemmatize(word) {
    const w = word.toLowerCase();
    if (YT_IRREGULAR[w] !== undefined && YT_IRREGULAR[w]) return YT_IRREGULAR[w];
    if (/ies$/.test(w)) return w.slice(0, -3) + 'y';      // studies -> study
    if (/([^aeiou])\1ing$/.test(w)) return w.slice(0, -4); // running -> run（双写去一）
    if (/[^aeiou]ing$/.test(w)) {
      const stem = w.slice(0, -3); // making -> make（辅音结尾补 e）；going -> go
      if (/^[a-z]{2,}[bcdfgklmnprstvz]$/.test(stem)) return stem + 'e';
      return stem;
    }
    if (/ied$/.test(w)) return w.slice(0, -3) + 'y';      // studied -> study
    if (/([^aeiou])\1ed$/.test(w)) return w.slice(0, -3); // stopped -> stop
    if (/ed$/.test(w)) return w.slice(0, -2);             // walked -> walk
    if (/(sh|ch|ss|x|z)es$/.test(w)) return w.slice(0, -2); // watches -> watch
    if (/oes$/.test(w)) return w.slice(0, -2);             // goes -> go, does -> do
    if (/s$/.test(w)) return w.slice(0, -1);               // cats/makes -> cat/make
    return w;
  }

  // ---- 从 words/search_simple.json 响应取第一条释义 ----
  // 格式：{ wordName, speechPart: { partName, means: [{ wordMean }] }, result, msg }
  function ytExtractMeaning(resp) {
    try {
      const sp = resp && resp.speechPart;
      const m = sp && sp.means && sp.means[0];
      return (m && m.wordMean) || null;
    } catch (e) { return null; }
  }

  // ---- 查词：缓存 → 网络请求（竞态防护），返回 Promise<string|null> ----
  function ytLookupMeaning(word) {
    const key = word.toLowerCase();
    if (ytHoverDictCache.has(key)) {
      return Promise.resolve(ytHoverDictCache.get(key));
    }
    return getToken().then((value) => {
      if (!value || !value.ciba_token) {
        return undefined; // 未登录：不弹气泡（getToken 每次都查 storage，登录后自动恢复）
      }
      const url = `${SERVER_API}/words/search_simple.json?token=${encodeURIComponent(value.ciba_token)}&wordName=${encodeURIComponent(word)}`;
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          let meaning = null;
          try { meaning = ytExtractMeaning(JSON.parse(xhr.responseText)); } catch (e) {}
          ytHoverDictCache.set(key, meaning);
          resolve(meaning);
        };
        xhr.send();
      });
    }).catch(() => undefined);
  }

  function ytHandleHover(span) {
    clearTimeout(ytHoverHideTimer);
    const word = span.textContent.trim();
    if (!word) return;
    const reqNum = ++ytHoverReqNum;
    ytLookupMeaning(word).then((meaning) => {
      if (reqNum !== ytHoverReqNum) return; // 过期响应丢弃
      // 查不到原形，试词形还原（如 running -> run）
      if (meaning === null) {
        const lemma = ytLemmatize(word);
        if (lemma !== word.toLowerCase()) {
          const reqNum2 = reqNum; // 同一悬停，序号不变
          ytLookupMeaning(lemma).then((m2) => {
            if (reqNum2 !== ytHoverReqNum) return;
            if (m2) ytShowHoverTip(span, m2); else ytHideHoverTip();
          });
          return;
        }
      }
      if (meaning) ytShowHoverTip(span, meaning); else ytHideHoverTip();
    });
  }

  function ytSetupHoverTip() {
    const player = document.getElementById('movie_player');
    if (!player) return;
    // 气泡挂播放器内（全屏可用）
    if (!ytHoverTipEl || !ytHoverTipEl.isConnected) {
      ytHoverTipEl = document.createElement('div');
      ytHoverTipEl.id = 'ciba-yt-hover-tip';
      ytHoverTipEl.className = 'ciba-yt-hover-tip';
      player.appendChild(ytHoverTipEl);
    }
    const lineEl = document.getElementById('ciba-yt-overlay-line');
    if (!lineEl || lineEl.dataset.hoverTipBound) return;
    lineEl.dataset.hoverTipBound = '1';
    // 事件委托：mouseenter 到词上触发（mouseover+relatedTarget 判换词）
    lineEl.addEventListener('mouseover', (e) => {
      const span = e.target.closest('.ciba-video-ocr-word');
      if (!span) return;
      // 悬停单词自动暂停（仅当前在播放时；滑出字幕行后恢复）
      const video = findVideoElement();
      if (video && !video.paused) { video.pause(); ytHoverPaused = true; }
      ytHandleHover(span);
    });
    lineEl.addEventListener('mouseout', (e) => {
      const span = e.target.closest('.ciba-video-ocr-word');
      if (!span) return;
      // 移出词后 100ms 再隐藏（防快速划过闪烁）
      clearTimeout(ytHoverHideTimer);
      ytHoverHideTimer = setTimeout(ytHideHoverTip, 100);
    });
    // 滑出整条字幕行：恢复播放（若暂停是悬停触发的）
    lineEl.addEventListener('mouseleave', () => {
      if (!ytHoverPaused) return;
      ytHoverPaused = false;
      // 大卡打开期间不抢恢复权，由关卡/加词成功逻辑负责续播
      const cardEl = document.getElementById('ciba-yt-overlay-card');
      if (cardEl && cardEl.classList.contains('ciba-yt-overlay-card--show')) return;
      const video = findVideoElement();
      if (video && video.paused) video.play();
    });
    // 点击词时气泡立即让位给大卡；接管续播权（悬停滑出不再恢复播放）
    lineEl.addEventListener('click', (e) => {
      if (e.target.closest('.ciba-video-ocr-word')) { ytHideHoverTip(); ytHoverPaused = false; }
    }, true);
  }

  // ---- 播放器控制栏按钮 + 弹出菜单（字幕开关 / 下载原字幕） ----
  let ytSubsEnabled = true; // 糍粑字幕开关（storage.local: ciba_yt_subs_enabled）

  function ytUpdateToolbarBtn() {
    const btn = document.getElementById('ciba-yt-toolbar-btn');
    if (!btn) return;
    const badge = btn.querySelector('.ciba-yt-toolbar-btn__badge');
    if (badge) {
      badge.textContent = ytSubsEnabled ? 'ON' : 'OFF';
      badge.classList.toggle('ciba-yt-toolbar-btn__badge--off', !ytSubsEnabled);
    }
    btn.classList.toggle('ciba-yt-toolbar-btn--off', !ytSubsEnabled);
    const switchEl = document.getElementById('ciba-yt-menu-switch');
    if (switchEl) switchEl.classList.toggle('ciba-yt-menu__switch--on', ytSubsEnabled);
    const mtSwitchEl = document.getElementById('ciba-yt-menu-mt-switch');
    if (mtSwitchEl) mtSwitchEl.classList.toggle('ciba-yt-menu__switch--on', ytMtEnabled);
  }

  function ytSetSubsEnabled(v) {
    ytSubsEnabled = !!v;
    chrome.storage.local.set({ ciba_yt_subs_enabled: ytSubsEnabled }, () => {});
    ytUpdateToolbarBtn();
    ytOverlayTick();
  }

  function ytToggleMenu(force) {
    const menu = document.getElementById('ciba-yt-menu');
    if (!menu) return;
    const show = typeof force === 'boolean' ? force : !menu.classList.contains('ciba-yt-menu--show');
    menu.classList.toggle('ciba-yt-menu--show', show);
  }

  // cues → SRT 文本
  function ytCuesToSrt(cues) {
    const fmt = (sec) => {
      const ms = Math.round((sec - Math.floor(sec)) * 1000);
      const s = Math.floor(sec) % 60;
      const m = Math.floor(sec / 60) % 60;
      const h = Math.floor(sec / 3600);
      const p = (n, w) => String(n).padStart(w, '0');
      return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
    };
    return cues.map((c, i) =>
      `${i + 1}\n${fmt(c.start)} --> ${fmt(c.start + (c.dur > 0 ? c.dur : 2))}\n${c.text}\n`
    ).join('\n');
  }

  function ytDownloadSubs() {
    if (!ytCues.length) { showToast('暂无字幕可下载', false); return; }
    const title = (document.title || '').replace(/\s*-\s*YouTube.*$/i, '').trim() || 'subtitles';
    // 加 BOM，保证部分播放器识别 UTF-8
    const blob = new Blob(['\ufeff' + ytCuesToSrt(ytCues)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function ytInjectToolbarButton() {
    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return false;
    if (document.getElementById('ciba-yt-toolbar-btn')) return true;

    const btn = document.createElement('button');
    btn.id = 'ciba-yt-toolbar-btn';
    btn.className = 'ytp-button ciba-yt-toolbar-btn';
    btn.title = '糍粑英语字幕';
    // 使用插件图标（icons/* 已声明为 web_accessible_resources）
    btn.innerHTML = `
      <img class="ciba-yt-toolbar-btn__icon" src="${chrome.runtime.getURL('icons/icon-48.png')}" alt="糍粑" />
      <span class="ciba-yt-toolbar-btn__badge">ON</span>
    `;
    // 插到右侧控制区最前（CC/设置左侧）
    rightControls.insertBefore(btn, rightControls.firstChild);

    // 菜单挂 #movie_player 内，全屏可用
    const player = document.getElementById('movie_player');
    if (player && !document.getElementById('ciba-yt-menu')) {
      const menu = document.createElement('div');
      menu.id = 'ciba-yt-menu';
      menu.className = 'ciba-yt-menu';
      menu.innerHTML = `
        <div class="ciba-yt-menu__hint" id="ciba-yt-menu-hint">点击字幕单词添加到单词本</div>
        <div class="ciba-yt-menu__item" id="ciba-yt-menu-toggle">
          <svg class="ciba-yt-menu__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" stroke="currentColor" stroke-width="1.6"/>
            <path d="M6 10.5h5M6 14h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          <span class="ciba-yt-menu__label">糍粑视频字幕</span>
          <span class="ciba-yt-menu__switch" id="ciba-yt-menu-switch"><span class="ciba-yt-menu__switch-knob"></span></span>
        </div>
        <div class="ciba-yt-menu__item" id="ciba-yt-menu-mt">
          <svg class="ciba-yt-menu__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 5h7v7H4zM13 12h7v7h-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
            <path d="M7.5 9h7M16.5 15h-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            <path d="M6 19l5-5M18 5l-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          <span class="ciba-yt-menu__label">显示机器翻译</span>
          <span class="ciba-yt-menu__switch" id="ciba-yt-menu-mt-switch"><span class="ciba-yt-menu__switch-knob"></span></span>
        </div>
        <div class="ciba-yt-menu__item" id="ciba-yt-menu-download">
          <svg class="ciba-yt-menu__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          <span class="ciba-yt-menu__label">下载原字幕</span>
          <svg class="ciba-yt-menu__icon ciba-yt-menu__icon--right" viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </div>
      `;
      player.appendChild(menu);

      menu.querySelector('#ciba-yt-menu-toggle').addEventListener('click', () => {
        ytSetSubsEnabled(!ytSubsEnabled);
      });
      menu.querySelector('#ciba-yt-menu-mt').addEventListener('click', () => {
        ytSetMtEnabled(!ytMtEnabled);
      });
      menu.querySelector('#ciba-yt-menu-download').addEventListener('click', () => {
        ytDownloadSubs();
        ytToggleMenu(false);
      });
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      ytToggleMenu();
    });
    // 点击菜单/按钮以外区域收起菜单
    if (!ytMenuOutsideClickBound) {
      ytMenuOutsideClickBound = true;
      document.addEventListener('pointerdown', (e) => {
        const menu = document.getElementById('ciba-yt-menu');
        if (!menu || !menu.classList.contains('ciba-yt-menu--show')) return;
        if (menu.contains(e.target) || document.getElementById('ciba-yt-toolbar-btn')?.contains(e.target)) return;
        ytToggleMenu(false);
      }, true);
    }

    ytUpdateToolbarBtn();
    return true;
  }
  let ytMenuOutsideClickBound = false;

  // ---- 渲染当前行（拆词成可点 span）+ 机器翻译第二行 ----
  let ytMtByIndex = [];     // ytMtByIndex[i] = 原轨第 i 行的译文（无则 undefined）
  let ytMtEnabled = true;   // "显示机器翻译"开关（storage.local: ciba_yt_mt_enabled）
  let ytMtTrackUrl = '';    // 本次选中的原语言轨 baseUrl（拉翻译轨用）
  let ytMtTransUrl = '';    // 播放器提供的现成 zh-Hans 翻译轨 URL（含 tlang，最可靠）
  let ytMtRetryTimer = null; // 429 限流后的延迟重试定时器

  function ytRenderOverlayLine(cue) {
    const lineEl = document.getElementById('ciba-yt-overlay-line');
    if (!lineEl) return;
    ytHideHoverTip(); // 行切换重渲染会销毁悬停的 span，气泡随之隐藏
    if (!cue) {
      lineEl.innerHTML = '';
      lineEl.removeAttribute('data-raw');
      return;
    }
    // 机器翻译行（开关开 + 该行有译文才渲染）
    let mtHtml = '';
    if (ytMtEnabled && ytCues.length) {
      const idx = ytFindCueIndexForLine(cue);
      const mt = (idx >= 0 && ytMtByIndex[idx]) || '';
      if (mt) mtHtml = `<div class="ciba-yt-overlay-mt">${ytEscapeHtml(mt)}</div>`;
    }
    lineEl.innerHTML = ytEscapeHtml(cue.text)
      .replace(/[A-Za-z][A-Za-z'’\-]*/g, (m) => `<span class="ciba-video-ocr-word">${m}</span>`)
      + mtHtml;
    lineEl.setAttribute('data-raw', cue.text);
  }

  // 找 cue 在 ytCues 中的下标（渲染时用，cue 均来自 ytCues，indexOf 足够）
  function ytFindCueIndexForLine(cue) {
    return ytCues.indexOf(cue);
  }

  // ---- 加载机器翻译轨（YouTube 原生 tlang 能力，零成本） ----
  async function ytLoadMtTrack() {
    if ((!ytMtTrackUrl && !ytMtTransUrl) || !ytMtEnabled) return;
    try {
      // 优先用播放器提供的现成翻译轨 URL；否则用原轨 URL + tlang 由 bridge 带 pot 直连
      const payload = ytMtTransUrl
        ? { url: ytMtTransUrl }
        : { url: ytMtTrackUrl, tlang: 'zh-Hans' };
      const json3 = await ytBridgeRequest('fetchTrack', payload);
      const mtCues = ytBuildCues(json3);
      ytMtByIndex = ytAlignMtToCues(ytCues, mtCues);
      ytOverlayCurIdx = -1; // 强制下一 tick 重渲染，让译文行出现
      ytOverlayTick();
    } catch (e) {
      // 翻译轨拉取失败：只显示原文
      console.warn('[ciba] YouTube 翻译轨拉取失败:', (e && e.message) || e);
      ytMtByIndex = [];
      // 429 限流：30 秒后自动重试一次（YouTube 限流通常分钟级解除）
      if (String((e && e.message) || e).indexOf('429') !== -1 && !ytMtRetryTimer) {
        ytMtRetryTimer = setTimeout(() => {
          ytMtRetryTimer = null;
          if (ytMtEnabled && ytCues.length) ytLoadMtTrack();
        }, 30000);
      }
    }
  }

  // ---- 对齐：把翻译轨 cue 映射到原轨行（区间重叠优先 + 就近兜底） ----
  function ytAlignMtToCues(cues, mtCues) {
    const byIndex = new Array(cues.length);
    const mt = [];
    for (const c of mtCues) {
      const text = (c.text || '').trim();
      if (!text || text === '-') continue;
      mt.push({ s: c.start, e: c.start + (c.dur > 0 ? c.dur : 2), text });
    }
    if (!mt.length) return byIndex;
    let p = 0; // mt[p] 是 start ≤ 当前行中点的最后一条
    for (let i = 0; i < cues.length; i++) {
      const cs = cues[i].start;
      const ce = cs + (cues[i].dur > 0 ? cues[i].dur : 1);
      const cMid = cs + (ce - cs) / 2;
      while (p + 1 < mt.length && mt[p + 1].s <= cMid) p++;
      // 候选 p-1/p/p+1：与原行区间有重叠者，取重叠最大
      // （翻译轨常把原轨相邻行合并/拆分，重叠判定比 start 差值更稳）
      let best = -1, bestOv = 0;
      for (const k of [p - 1, p, p + 1]) {
        if (k < 0 || k >= mt.length) continue;
        const ov = Math.min(ce, mt[k].e) - Math.max(cs, mt[k].s);
        if (ov > bestOv) { bestOv = ov; best = k; }
      }
      if (best >= 0) { byIndex[i] = mt[best].text; continue; }
      // 兜底：无重叠时取 start 最接近原行中点者（6s 内）
      // 覆盖翻译轨首句整体延后、时间轴错位等情况
      let near = -1, nearD = Infinity;
      for (const k of [p, p + 1]) {
        if (k < 0 || k >= mt.length) continue;
        const d = Math.abs(mt[k].s - cMid);
        if (d < nearD) { nearD = d; near = k; }
      }
      if (near >= 0 && nearD <= 6) byIndex[i] = mt[near].text;
    }
    return byIndex;
  }

  function ytSetMtEnabled(v) {
    ytMtEnabled = !!v;
    chrome.storage.local.set({ ciba_yt_mt_enabled: ytMtEnabled }, () => {});
    ytUpdateToolbarBtn();
    ytOverlayCurIdx = -1; // 强制重渲染当前行
    ytOverlayTick();
    // 从关到开且还没拉过翻译轨：补拉
    if (ytMtEnabled && (ytMtTransUrl || ytMtTrackUrl) && !ytMtByIndex.length && ytCues.length) ytLoadMtTrack();
  }

  // ---- 二分定位：起点 ≤ t 的最后一行 ----
  function ytFindCueIndex(t) {
    let idx = -1, lo = 0, hi = ytCues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ytCues[mid].start <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return idx;
  }

  // ---- 渲染"获取字幕中..."提示行 ----
  function ytRenderLoadingLine() {
    const lineEl = document.getElementById('ciba-yt-overlay-line');
    if (!lineEl) return;
    lineEl.innerHTML = `<span class="ciba-yt-overlay-loading">加载字幕中，请稍候...</span>`;
    lineEl.removeAttribute('data-raw');
  }

  // ---- 主 tick：切换显示行 + 广告/空档处理 + 原生 CC 视觉隐藏 ----
  function ytOverlayTick() {
    const overlayEl = document.getElementById('ciba-yt-video-overlay');
    if (!overlayEl) return;
    const player = document.getElementById('movie_player');
    const video = ytVideoEl && ytVideoEl.isConnected ? ytVideoEl : (ytVideoEl = findVideoElement());
    const hasCues = ytCues.length > 0;
    const adShowing = !!(player && player.classList.contains('ad-showing'));
    const show = (hasCues || ytSubsLoading) && video && !adShowing && ytSubsEnabled;
    overlayEl.style.display = show ? '' : 'none';
    // 有我们的字幕在显示时才视觉隐藏原生 CC（不动播放器 CC 开关状态，
    // timedtext 请求照发，网络捕获照收）
    if (player) player.classList.toggle('ciba-hide-native-caps', hasCues && !adShowing && ytSubsEnabled);
    if (!show) {
      // 隐藏时清掉字幕行内容（CSS 的 display:flex !important 会压过行内 display:none，
      // 实际靠 :empty 规则隐藏行），避免关闭开关后残留最后一行字幕/加载提示
      ytRenderOverlayLine(null);
      ytOverlayCurIdx = -1;
      return;
    }

    // 加载中：字幕区显示提示，等加载完成后由 tick 正常接管
    if (ytSubsLoading) {
      if (ytOverlayCurIdx !== -2) { ytOverlayCurIdx = -2; ytRenderLoadingLine(); }
      return;
    }

    const t = video.currentTime;
    let idx = ytFindCueIndex(t);
    if (idx >= 0) {
      const cue = ytCues[idx];
      if (cue.dur > 0 && t > cue.start + cue.dur + 0.5) idx = -1; // 行已结束（0.5s 容差）
    }
    if (idx === ytOverlayCurIdx) return;
    ytOverlayCurIdx = idx;
    ytRenderOverlayLine(idx >= 0 ? ytCues[idx] : null);
  }

  // ---- timeupdate 绑定（video 元素可能被换，轮询重绑） ----
  function ytBindVideoTimeUpdate() {
    const v = findVideoElement();
    if (v === ytVideoEl) return;
    if (ytVideoEl) ytVideoEl.removeEventListener('timeupdate', ytOverlayTick);
    ytVideoEl = v;
    if (ytVideoEl) ytVideoEl.addEventListener('timeupdate', ytOverlayTick);
  }

  // ---- 加载当前视频字幕 ----
  async function ytLoadCurrentVideo() {
    const token = ++ytLoadingToken;
    ytSubsLoading = true;
    ytOverlayCurIdx = -1;
    // 提示行的显隐统一交给 tick 判断（开关关闭时不显示"获取字幕中..."）
    ytOverlayTick();
    let info = null;
    // 播放器可能尚未就绪，带重试
    for (let attempt = 0; attempt < 6 && !(info && info.tracks && info.tracks.length); attempt++) {
      try { info = await ytBridgeRequest('getTracks'); } catch (e) { info = null; }
      if (!(info && info.tracks && info.tracks.length)) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (token !== ytLoadingToken) return;
    if (!info || !info.tracks || !info.tracks.length) {
      // 无人工/自动字幕轨：结束加载态，清掉提示行
      ytSubsLoading = false;
      ytRenderOverlayLine(null);
      return;
    }

    const pick = ytPickTrack(info.tracks);
    if (!pick || !pick.baseUrl) {
      ytSubsLoading = false;
      ytRenderOverlayLine(null);
      return;
    }
    try {
      const json3 = await ytBridgeRequest('fetchTrack', { url: pick.baseUrl });
      if (token !== ytLoadingToken) return;
      ytSubsLoading = false;
      ytCues = ytBuildCues(json3);
      ytMtTrackUrl = pick.baseUrl;      // 记录轨地址，供翻译轨拉取
      if (ytMtRetryTimer) { clearTimeout(ytMtRetryTimer); ytMtRetryTimer = null; }
      ytMtTransUrl = '';                // 从轨的 translations 里找现成中文翻译轨 URL
      try {
        const trs = pick.translations || [];
        const tr = trs.find((t) => t.languageCode === 'zh-Hans')
          || trs.find((t) => (t.languageCode || '').indexOf('zh') === 0);
        if (tr && tr.url) ytMtTransUrl = tr.url;
      } catch (e) {}
      ytMtByIndex = [];                 // 新视频重置译文
      ytOverlayCurIdx = -1;
      ytOverlayTick();
      // 原文字幕就绪后异步拉机器翻译轨（不阻塞字幕显示）
      if (ytMtEnabled) ytLoadMtTrack();
    } catch (e) {
      // 拉取失败：保留原生字幕（不挂 ciba-hide-native-caps，用户仍可开 CC）
      if (token !== ytLoadingToken) return;
      ytSubsLoading = false;
      ytRenderOverlayLine(null);
    }
  }

  function ytInit() {
    // 先读取字幕开关状态（默认开），读完再启动轮询，
    // 避免异步读取完成前用默认值误显示"获取字幕中..."
    chrome.storage.local.get(['ciba_yt_subs_enabled', 'ciba_yt_mt_enabled'], (r) => {
      ytSubsEnabled = r.ciba_yt_subs_enabled !== false;
      ytMtEnabled = r.ciba_yt_mt_enabled !== false; // 机器翻译默认开
      ytUpdateToolbarBtn();
      startYtLoops();
    });
  }

  function startYtLoops() {
    // 播放器可能晚于脚本出现，轮询注入覆盖层直到成功
    const injectTimer = setInterval(() => {
      if (ytInjectOverlay()) clearInterval(injectTimer);
    }, 500);
    setInterval(() => {
      // 控制栏按钮可能随播放器重建/尚未出现，持续尝试注入（内部有去重）
      ytInjectToolbarButton();
      ytBindVideoTimeUpdate();
      ytOverlayTick();
      // YouTube 是 SPA：URL 变了即换片，重新加载字幕
      const navUrl = location.pathname + location.search;
      if (navUrl !== ytLastNavUrl) {
        ytLastNavUrl = navUrl;
        ytCues = [];
        ytMtByIndex = []; // 换片重置机器翻译
        ytMtTrackUrl = '';
        ytMtTransUrl = '';
        if (ytMtRetryTimer) { clearTimeout(ytMtRetryTimer); ytMtRetryTimer = null; }
        ytOverlayCurIdx = -1;
        ytRenderOverlayLine(null);
        ytLoadCurrentVideo();
      }
    }, 400);
    // yt 的 SPA 导航事件作兜底信号（下次轮询立即触发重载）
    window.addEventListener('yt-navigate-finish', () => { ytLastNavUrl = ''; });
  }

  function init() {
    initOverlayElements();
    setupGlobalListeners();
    if (IS_YOUTUBE) ytInit();
  }

  // 尊重"在此网站禁用"：与 content_script.js 共用 disabledSites 黑名单，
  // 命中黑名单时本脚本（OCR + YouTube 字幕覆盖层）完全不初始化
  (function bootIfNotDisabled() {
    try {
      if (!window.location || !window.location.hostname) return;
    } catch (e) { return; }
    const hostname = window.location.hostname;
    chrome.storage.local.get('disabledSites', (result) => {
      const disabledSites = result.disabledSites || [];
      if (disabledSites.includes(hostname)) return; // 已禁用，什么都不做
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
      } else {
        init();
      }
    });
  })();
})();