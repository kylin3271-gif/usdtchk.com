/* =========================================================
   api.js —— 统一接口层（两套方案共用）
   只改这一处，就能在 mock / 方案A / 方案B 之间切换：

     window.SITE_CONFIG = {
       mode : 'mock' | 'A' | 'B'
       base : 方案B 的前缀，默认 '/api'
       timeout : 超时毫秒，默认 20000
     }

   方案A 走原站路径（需 PHP 后端，见 php-api/）
   方案B 走自有 /api/*（见 server/server.js）
   ========================================================= */
window.API = (function () {
  'use strict';

  var cfg = Object.assign({ mode: 'mock', base: '/api', timeout: 20000 }, window.SITE_CONFIG || {});

  /* 同一个接口名，两套方案各自的路径 */
  var ROUTES = {
    A: {
      balance: '/index/index/ajaxgetbalance.html',
      txs: '/index/index/ajax_search_tron.html',
      block: '/index/index/ajaxshowheight.html',
      batch: '/index/index/address_balance.html'
    },
    B: {
      balance: '/balance',
      txs: '/txs',
      block: '/block',
      batch: '/batch'
    }
  };

  var METHOD = { balance: 'POST', txs: 'POST', block: 'POST', batch: 'GET' };

  function encode(params) {
    var out = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null) v = '';
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return out.join('&');
  }

  function request(name, params) {
    params = params || {};

    /* ---- mock：不发请求，直接给演示数据 ---- */
    if (cfg.mode === 'mock') {
      try {
        return Promise.resolve(window.MOCK[name](params));
      } catch (e) {
        return Promise.resolve({ code: 0, msg: 'mock 生成失败：' + e.message });
      }
    }

    var table = ROUTES[cfg.mode === 'B' ? 'B' : 'A'];
    var path = table[name];
    var base = (cfg.mode === 'B') ? cfg.base : '';
    var method = METHOD[name] || 'POST';
    var url = base + path;
    var body = null;

    if (method === 'GET') {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + encode(params);
    } else {
      body = encode(params);
    }

    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.timeout) : null;

    return fetch(url, {
      method: method,
      headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {},
      body: body,
      signal: ctrl ? ctrl.signal : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.text().then(function (text) {
        /* 原站后端有时不返回 application/json，这里手动 parse 以兼容 */
        var json;
        try { json = JSON.parse(text); }
        catch (e) { throw new Error('返回格式异常（HTTP ' + res.status + '）'); }
        if (!res.ok && !json.code) throw new Error('HTTP ' + res.status);
        return json;
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return { code: 0, msg: '请求超时' };
      return { code: 0, msg: err.message || '网络错误' };
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    });
  }

  function loadMask(on) {
    var el = document.getElementById('mask');
    if (!el) { el = document.createElement('div'); el.id = 'mask'; el.className = 'mask'; el.innerHTML = '<div class="box">加载中…</div>'; document.body.appendChild(el); }
    el.classList.toggle('show', !!on);
  }

  return {
    cfg: cfg,
    call: request,
    mask: loadMask,
    /* 便捷方法，参数名对齐原站 */
    balance: function (address) { return request('balance', { search: address }); },
    txs: function (p) { return request('txs', p); },
    block: function (height) { return request('block', { height: height }); },
    batch: function (address) { return request('batch', { address: address }); }
  };
})();
