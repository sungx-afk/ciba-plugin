document.addEventListener("DOMContentLoaded", function () {
  //从本地获取对应的保存值
  chrome.storage.local.get('ciba_options', function(result) {
    if (result && result.ciba_options){
      let options = JSON.parse(result.ciba_options)
      if (options.word_click){
        document.getElementById('word_doubleclick').checked = true
      }else{
        document.getElementById('word_click').checked = true
      }
      if (options.word_popup){
        document.getElementById('word_popup_image').checked = true
      }else{
        document.getElementById('word_popup_direct').checked = true
      }
      if (options.sentence_popup){
        document.getElementById('sentence_popup_direct').checked = true
      }else{
        document.getElementById('sentence_popup_image').checked = true
      }
    }else{
      document.getElementById('word_click').checked = true
      document.getElementById('word_popup_direct').checked = true
      document.getElementById('sentence_popup_image').checked = true
    }
  });
  document.getElementById('save_btn').addEventListener('click', () => {
    let options = {
      word_click:0,
      word_popup:0,
      sentence_popup:0
    }
    if (document.getElementById('word_doubleclick').checked){
      options.word_click = 1
    }
    if (document.getElementById('word_popup_image').checked){
      options.word_popup = 1
    }
    if (document.getElementById('sentence_popup_direct').checked){
      options.sentence_popup = 1
    }
    chrome.storage.local.set({ "ciba_options": JSON.stringify(options) }, function(){
      showToast("保存成功")
    });
  });
})

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
