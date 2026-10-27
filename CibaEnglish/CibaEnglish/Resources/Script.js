function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "糍粑记忆卡 + 视频字幕OCR 扩展已开启。你可以在 Safari 设置的「扩展」中关闭它。";
        document.getElementsByClassName('state-off')[0].innerText = "糍粑记忆卡 + 视频字幕OCR 扩展已关闭。你可以在 Safari 设置的「扩展」中开启它。";
        document.getElementsByClassName('state-unknown')[0].innerText = "你可以在 Safari 设置的「扩展」中开启糍粑记忆卡 + 视频字幕OCR 扩展。";
        document.getElementsByClassName('open-preferences')[0].innerText = "退出并打开 Safari 设置…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
