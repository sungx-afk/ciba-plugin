// Popup Script for Chrome Extension Settings

const DEFAULT_SETTINGS = {
  enabled: true,
  allowScreenshotUpload: false
};

document.addEventListener("DOMContentLoaded", async () => {
  const toggleEnabled = document.getElementById("toggle-enabled");
  const toggleUploadScreenshot = document.getElementById("toggle-upload-screenshot");
  if (!toggleEnabled || !toggleUploadScreenshot) return;

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  toggleEnabled.checked = settings.enabled !== false;
  toggleUploadScreenshot.checked = !!settings.allowScreenshotUpload;

  toggleEnabled.addEventListener("change", async () => {
    await chrome.storage.sync.set({ enabled: toggleEnabled.checked });
  });

  toggleUploadScreenshot.addEventListener("change", async () => {
    await chrome.storage.sync.set({ allowScreenshotUpload: toggleUploadScreenshot.checked });
  });
});