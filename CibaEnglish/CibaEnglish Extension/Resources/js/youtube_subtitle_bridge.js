// youtube_subtitle_bridge.js
// 注入在 YouTube 页面的 MAIN world（manifest 中 "world": "MAIN"），document_start 执行。
// 职责：
//   ① 读取播放器已加载的字幕轨列表（人工上传轨 + ASR 自动轨）
//   ② 拉取指定轨的完整字幕内容
// 与内容脚本（隔离世界）通过 window.postMessage 通信。
//
// 关键背景：2025 年起 YouTube 对 /api/timedtext 接口校验 pot 令牌——
// 播放器自己发的请求天然带 pot，我们直连拼出的 URL 没有 → 常返回 200 但 body 为空。
// 解决方案（Language Reactor 同款）：hook 网络捕获播放器请求 URL 里的 pot 令牌，
// 直连时拼上 &c=WEB&pot=<令牌> 即可正常返回。因此拉取策略三级：
//   ① 复用"播放器已请求过"的响应（MAIN world 钩住 fetch/XHR 缓存）
//   ② 指挥播放器重新加载该轨（原语言轨）或确保 pot 已捕获（翻译轨）
//   ③ 直连降级兜底（json3 → srv1 → 换最新 baseUrl，带 pot）
(function () {
  'use strict';
  if (window.__cibaYtSubsBridgeInstalled) return;
  window.__cibaYtSubsBridgeInstalled = true;

  const REQ_TYPE = 'CIBA_YT_SUBS_REQ';
  const RESP_TYPE = 'CIBA_YT_SUBS_RESP';

  function respond(id, ok, data) {
    window.postMessage({ type: RESP_TYPE, id: id, ok: ok, data: data }, '*');
  }

  // ---------- ① 字幕轨列表 ----------
  function getPlayerResponse() {
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const pr = player.getPlayerResponse();
        if (pr) return pr;
      }
    } catch (e) {}
    try {
      if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args
          && window.ytplayer.config.args.player_response) {
        return JSON.parse(window.ytplayer.config.args.player_response);
      }
    } catch (e) {}
    return null;
  }

  function extractTracks() {
    const pr = getPlayerResponse();
    let tracks = [];
    try {
      const r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      tracks = (r && r.captionTracks) || [];
    } catch (e) {}
    return {
      tracks: tracks.map(function (t) {
        let name = '';
        try {
          name = (t.name && (t.name.simpleText ||
            (t.name.runs && t.name.runs.map(function (r) { return r.text; }).join('')))) || '';
        } catch (e) {}
        return {
          languageCode: t.languageCode || '',
          name: name,
          kind: t.kind || '',          // 'asr' = 自动生成字幕
          baseUrl: t.baseUrl || '',
          // 各语言翻译轨的现成 URL（含 tlang，播放器自己请求时带 pot）
          translations: (t.translations || []).map(function (x) {
            return { languageCode: x.languageCode || '', url: x.url || '' };
          })
        };
      })
    };
  }

  // ---------- timedtext 网络捕获 ----------
  var timedtextCache = {}; // 'v=xxx|lang=xx' -> { url, text }
  // ---------- pot 令牌捕获（Language Reactor 同款方案） ----------
  // 播放器自己请求 /api/timedtext 时 URL 自带 pot；捕获后拼到直连请求上即可通过校验
  var potByVideo = {};     // videoId -> pot
  function capturePot(url) {
    try {
      if (url.indexOf('/api/timedtext') === -1) return;
      var p = new URL(url, location.origin).searchParams;
      var pot = p.get('pot'), v = p.get('v');
      if (pot && v && !potByVideo[v]) potByVideo[v] = pot;
    } catch (e) {}
  }
  function currentPot() {
    try {
      var pr = getPlayerResponse();
      var v = pr && pr.videoDetails && pr.videoDetails.videoId;
      if (v && potByVideo[v]) return potByVideo[v];
      // 兜底：页面同一时刻只播一个视频，用任意已捕获的 pot
      var keys = Object.keys(potByVideo);
      if (keys.length === 1) return potByVideo[keys[0]];
    } catch (e) {}
    return '';
  }
  async function waitForPot(ms) {
    var deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      var pot = currentPot();
      if (pot) return pot;
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    return currentPot();
  }
  function cacheKey(url) {
    try {
      var p = new URL(url, location.origin).searchParams;
      return (p.get('v') || '') + '|' + (p.get('lang') || '') + '|' + (p.get('tlang') || '');
    } catch (e) { return ''; }
  }
  function storeTimedtext(url, text) {
    var k = cacheKey(url);
    if (!k || k === '|') return;
    timedtextCache[k] = { url: String(url), text: text };
  }
  function findCache(rawUrl) {
    var k = cacheKey(rawUrl);
    return (k && timedtextCache[k]) || null;
  }

  function hookNetwork() {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        var req = arguments[0];
        var url = '';
        try { url = typeof req === 'string' ? req : ((req && req.url) || String(req)); } catch (e) {}
        var promise = origFetch.apply(this, arguments);
        if (url && url.indexOf('/api/timedtext') !== -1) {
          capturePot(url);
          promise.then(function (resp) {
            try {
              resp.clone().text().then(function (t) {
                if (t && t.trim()) storeTimedtext(url, t);
              }).catch(function () {});
            } catch (e) {}
          }).catch(function () {});
        }
        return promise;
      };
    }
    if (typeof XMLHttpRequest === 'function') {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function () {
        try { this.__cibaTtUrl = String(arguments[1] || ''); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        if (xhr.__cibaTtUrl && xhr.__cibaTtUrl.indexOf('/api/timedtext') !== -1) {
          capturePot(xhr.__cibaTtUrl);
          xhr.addEventListener('load', function () {
            try {
              var t = xhr.responseText;
              if (t && t.trim()) storeTimedtext(xhr.__cibaTtUrl, t);
            } catch (e) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    }
  }
  hookNetwork();

  // ---------- 解析 ----------
  // srv1 XML：<text start="1.2" dur="2.3">Hello</text>
  function parseSrv1(text) {
    var events = [];
    try {
      var doc = new DOMParser().parseFromString(text, 'text/xml');
      var nodes = doc.querySelectorAll('text');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var start = parseFloat(node.getAttribute('start'));
        var dur = parseFloat(node.getAttribute('dur') || '0');
        if (isNaN(start)) continue;
        var content = (node.textContent || '').trim();
        if (!content) continue;
        // srv1 实体被二次转义，再还原一次
        content = content.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        events.push({ tStartMs: Math.round(start * 1000), dDurationMs: Math.round((isNaN(dur) ? 0 : dur) * 1000), segs: [{ utf8: content }] });
      }
    } catch (e) {}
    return { events: events };
  }

  // srv3/ttml：<p t="1200" d="2300"><s>Hel</s><s>lo</s></p>（毫秒）
  function parseSrv3(text) {
    var events = [];
    try {
      var doc = new DOMParser().parseFromString(text, 'text/xml');
      var nodes = doc.querySelectorAll('p');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var startMs = parseInt(node.getAttribute('t'), 10);
        if (isNaN(startMs)) continue;
        var durMs = parseInt(node.getAttribute('d'), 10);
        var content = (node.textContent || '').trim();
        if (!content) continue;
        events.push({ tStartMs: startMs, dDurationMs: isNaN(durMs) ? 0 : durMs, segs: [{ utf8: content }] });
      }
    } catch (e) {}
    return { events: events };
  }

  // 嗅探解析：json3 / srv1 / srv3 统一归成 json3 形状
  function parseCaptions(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (t.charAt(0) === '{') {
      try {
        var j = JSON.parse(t);
        if (j && Array.isArray(j.events) && j.events.length) return j;
      } catch (e) {}
    }
    if (t.charAt(0) === '<') {
      var s1 = parseSrv1(t);
      if (s1.events.length) return s1;
      var s3 = parseSrv3(t);
      if (s3.events.length) return s3;
    }
    return null;
  }

  // ---------- ② 指挥播放器代拉 ----------
  async function fetchViaPlayer(rawUrl) {
    var player = document.getElementById('movie_player');
    if (!player || typeof player.loadModule !== 'function' || typeof player.setOption !== 'function') return null;
    var lang = '';
    try { lang = new URL(rawUrl, location.origin).searchParams.get('lang') || ''; } catch (e) {}
    if (!lang) return null;

    var saved = null;
    try { saved = player.getOption('captions', 'track'); } catch (e) {}
    var restore = function () {
      try {
        if (saved && saved.languageCode) player.setOption('captions', 'track', saved);
        else player.unloadModule('captions');
      } catch (e) {}
    };

    try { player.unloadModule('captions'); } catch (e) {}
    try {
      player.loadModule('captions');
      player.setOption('captions', 'track', { languageCode: lang });
    } catch (e) { restore(); return null; }

    for (var i = 0; i < 30; i++) { // 最多等 4.5s
      await new Promise(function (r) { setTimeout(r, 150); });
      var hit = findCache(rawUrl);
      if (hit) {
        var parsed = parseCaptions(hit.text);
        if (parsed) { restore(); return parsed; }
      }
    }
    restore();
    return null;
  }

  // ---------- ③ 直连降级 ----------
  function timedtextAttempts(baseUrl, tlang) {
    var clean = baseUrl.replace(/&fmt=[^&]*/g, '').replace(/&tlang=[^&]*/g, '');
    var t = tlang ? ('&tlang=' + encodeURIComponent(tlang)) : '';
    return [
      { url: clean + t + '&fmt=json3', fmt: 'json3' },
      { url: clean + t + '&fmt=srv1', fmt: 'srv1' }
    ];
  }

  async function fetchTimedtext(rawUrl, tlang) {
    var attempts = timedtextAttempts(rawUrl, tlang);
    try {
      var lang = new URL(rawUrl, location.origin).searchParams.get('lang');
      if (lang) {
        var info = extractTracks();
        var fresh = info.tracks.filter(function (t) { return t.languageCode === lang; })[0];
        if (fresh && fresh.baseUrl && fresh.baseUrl !== rawUrl) {
          attempts = attempts.concat(timedtextAttempts(fresh.baseUrl, tlang));
        }
      }
    } catch (e) {}

    // LR 方案：等播放器先请求过字幕（最多 3s），拿到 pot 后拼上直连即可通过校验
    var pot = await waitForPot(3000);
    if (pot) {
      attempts = attempts.map(function (a) {
        return { url: a.url + '&c=WEB&pot=' + encodeURIComponent(pot), fmt: a.fmt };
      });
    }

    var lastErr = 'timedtext 返回为空';
    for (var i = 0; i < attempts.length; i++) {
      if (i > 0) await new Promise(function (r) { setTimeout(r, 1200); }); // 请求间隔，避免触发限流
      var attempt = attempts[i];
      try {
        var resp = await fetch(attempt.url, { credentials: 'include', headers: { 'Accept': '*/*' } });
        var text = await resp.text();
        if (resp.status === 429) { lastErr = 'HTTP 429 限流'; continue; }
        if (!resp.ok) { lastErr = 'HTTP ' + resp.status; continue; }
        if (!text || !text.trim()) { lastErr = '响应体为空'; continue; }
        var json = (attempt.fmt === 'srv1') ? parseSrv1(text) : JSON.parse(text);
        if (json && Array.isArray(json.events) && json.events.length) return json;
        lastErr = '字幕内容为空';
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
    throw new Error(lastErr);
  }

  // ---------- ②' 翻译轨：确保 pot 后直连 ----------
  // 若 pot 尚未捕获（播放器还没请求过字幕），先指挥播放器加载一次原轨，
  // 它发出的 /api/timedtext 请求会被 hook 捕获 pot（返回的原轨数据弃用）
  function buildTlangUrl(baseUrl, tlang) {
    return baseUrl.replace(/&fmt=[^&]*/g, '').replace(/&tlang=[^&]*/g, '')
      + '&tlang=' + encodeURIComponent(tlang) + '&fmt=json3';
  }

  async function ensurePotForTranslate(rawUrl) {
    if (currentPot()) return true;
    try { await fetchViaPlayer(rawUrl); } catch (e) {}
    return !!currentPot();
  }

  async function fetchTrackSmart(rawUrl, tlang) {
    // tlang 优先取显式参数；URL 里已带 tlang（translations 现成 URL）也算翻译轨
    var effectiveTlang = tlang || '';
    if (!effectiveTlang) {
      try { effectiveTlang = new URL(rawUrl, location.origin).searchParams.get('tlang') || ''; } catch (e) {}
    }
    // ① 播放器已请求过的响应（带 pot，最可靠）
    // 翻译轨必须按"带 tlang 的 URL"查缓存，否则会命中原语言轨、译文变回英文
    var cacheLookupUrl = effectiveTlang ? buildTlangUrl(rawUrl, effectiveTlang) : rawUrl;
    var hit = findCache(cacheLookupUrl);
    if (hit) {
      var cached = parseCaptions(hit.text);
      if (cached) return cached;
    }
    // ② 指挥播放器代拉（原语言轨设 track；翻译轨先确保 pot 再直连）
    if (effectiveTlang) {
      await ensurePotForTranslate(rawUrl);
    } else {
      var viaPlayer = await fetchViaPlayer(rawUrl);
      if (viaPlayer) return viaPlayer;
    }
    // ③ 直连降级（带 pot 时可成功）
    return await fetchTimedtext(rawUrl, effectiveTlang);
  }

  // ---------- 消息入口 ----------
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var msg = e.data;
    if (!msg || msg.type !== REQ_TYPE) return;
    if (msg.action === 'getTracks') {
      respond(msg.id, true, extractTracks());
      return;
    }
    if (msg.action === 'fetchTrack' && msg.url) {
      fetchTrackSmart(msg.url, msg.tlang || '')
        .then(function (json) { respond(msg.id, true, json); })
        .catch(function (err) { respond(msg.id, false, { reason: String((err && err.message) || err) }); });
      return;
    }
  });
})();
