// ===== 设置页（选词设置 + 视频字幕 OCR 设置）=====
// 所有选项统一为实时保存：控件 change 即写入 storage，不再需要"保存"按钮。

const WORD_OPTIONS_KEY = 'ciba_options';

// 选词默认值：word_popup=0 英文单词直接弹；sentence_popup=0 句子点击图标再弹
// （与 content_script.js 第 658-685 行的判断逻辑保持一致）
const WORD_DEFAULT_OPTIONS = {
  word_popup: 0,
  sentence_popup: 0
};

// 视频字幕 OCR 默认值（与 video_ocr_content.js 的 DEFAULT_SETTINGS 保持一致）
const OCR_DEFAULT_SETTINGS = {
  enabled: true,
  allowScreenshotUpload: false
};

document.addEventListener('DOMContentLoaded', function () {
  initWordOptions();
  initOcrOptions();
});

// ---------- 1. 选词设置 ----------
function initWordOptions() {
  const wordPopupDirect = document.getElementById('word_popup_direct');
  const wordPopupImage = document.getElementById('word_popup_image');
  const sentencePopupImage = document.getElementById('sentence_popup_image');
  const sentencePopupDirect = document.getElementById('sentence_popup_direct');
  if (!wordPopupDirect || !sentencePopupDirect) return;

  // 回填已保存配置
  chrome.storage.local.get(WORD_OPTIONS_KEY, function (result) {
    let options = WORD_DEFAULT_OPTIONS;
    if (result && result[WORD_OPTIONS_KEY]) {
      try {
        options = Object.assign({}, WORD_DEFAULT_OPTIONS, JSON.parse(result[WORD_OPTIONS_KEY]));
      } catch (e) {
        options = WORD_DEFAULT_OPTIONS;
      }
    }
    wordPopupImage.checked = !!options.word_popup;
    wordPopupDirect.checked = !options.word_popup;
    sentencePopupDirect.checked = !!options.sentence_popup;
    sentencePopupImage.checked = !options.sentence_popup;
  });

  // 实时保存：先读现有配置再覆盖本次改动，避免丢掉其它字段
  function saveWordOptions() {
    chrome.storage.local.get(WORD_OPTIONS_KEY, function (result) {
      let options = {};
      if (result && result[WORD_OPTIONS_KEY]) {
        try { options = JSON.parse(result[WORD_OPTIONS_KEY]) || {}; } catch (e) { options = {}; }
      }
      options.word_popup = wordPopupImage.checked ? 1 : 0;
      options.sentence_popup = sentencePopupDirect.checked ? 1 : 0;
      chrome.storage.local.set({ [WORD_OPTIONS_KEY]: JSON.stringify(options) }, function () {
        showToast('设置已保存');
      });
    });
  }

  document.querySelectorAll('input[name="word_popup"], input[name="sentence_popup"]').forEach(function (el) {
    el.addEventListener('change', saveWordOptions);
  });
}

// ---------- 2. 视频字幕 OCR 设置 ----------
async function initOcrOptions() {
  const toggleEnabled = document.getElementById('toggle-enabled');
  const toggleUploadScreenshot = document.getElementById('toggle-upload-screenshot');
  if (!toggleEnabled || !toggleUploadScreenshot) return;

  const settings = await chrome.storage.sync.get(OCR_DEFAULT_SETTINGS);
  toggleEnabled.checked = settings.enabled !== false;
  toggleUploadScreenshot.checked = !!settings.allowScreenshotUpload;

  toggleEnabled.addEventListener('change', async () => {
    await chrome.storage.sync.set({ enabled: toggleEnabled.checked });
    showToast(toggleEnabled.checked ? '已开启字幕自动识别' : '已关闭字幕自动识别');
  });

  toggleUploadScreenshot.addEventListener('change', async () => {
    await chrome.storage.sync.set({ allowScreenshotUpload: toggleUploadScreenshot.checked });
    showToast(toggleUploadScreenshot.checked ? '已开启截图上传' : '已关闭截图上传');
  });
}

// ---------- Toast 提示（沿用深色样式；纯文本构建，不走 innerHTML）----------
function showToast(msg, type = 'success', duration = 1500) {
  const existing = document.getElementById('ciba_toast');
  if (existing) existing.remove(); // 连续操作时不堆叠

  const wrap = document.createElement('div');
  wrap.id = 'ciba_toast';
  wrap.className = `toast-content toast-${type}`;
  const inner = document.createElement('div');
  inner.className = 'toast';
  inner.textContent = msg;
  wrap.appendChild(inner);
  document.body.appendChild(wrap);

  setTimeout(function () {
    wrap.remove();
  }, duration);
}
