/* =========================================================
   utils.js —— 从原站抽出的纯函数，可直接复用
   对应原代码：
     preciseAdd          （批量页 346-362）
     sortByField         （批量页 555-603）
     copyTextToClipboard （批量页 604-612 / 结果页 696-708）
     fmtTime             （结果页 moment(t*1000).format）
   另外补原站缺的两个：escapeHtml（防 XSS）、shortAddr
   ========================================================= */
window.U = (function () {
  'use strict';

  /* ---------- DOM ---------- */
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- 数字 ---------- */
  function fmt(n, d) {
    d = (d === undefined) ? 2 : d;
    var v = Number(n);
    if (!isFinite(v)) return '0.00';
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /** 定点加法：避免 0.1+0.2 这类浮点误差（原站 preciseAdd，保持原实现语义） */
  function preciseAdd(num1, num2) {
    var r1, r2, m;
    try { r1 = num1.toString().split('.')[1].length; } catch (e) { r1 = 0; }
    try { r2 = num2.toString().split('.')[1].length; } catch (e) { r2 = 0; }
    m = Math.pow(10, Math.max(r1, r2));
    return Math.round(Number(num1) * m + Number(num2) * m) / m;
  }

  /** 通用排序：数字按大小，字符串按 localeCompare(numeric)（原站 sortByField 精简版） */
  function sortByField(arr, field, order) {
    order = (order === 'desc') ? 'desc' : 'asc';
    if (!Array.isArray(arr) || !arr.length) return (arr || []).slice();
    var copy = arr.slice();
    copy.sort(function (a, b) {
      var va = a[field], vb = b[field];
      if (va == null && vb == null) return 0;
      if (va == null) return order === 'asc' ? -1 : 1;
      if (vb == null) return order === 'asc' ? 1 : -1;
      if (typeof va === 'number' && typeof vb === 'number') {
        return order === 'asc' ? va - vb : vb - va;
      }
      var sa = String(va), sb = String(vb);
      return order === 'asc'
        ? sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
        : sb.localeCompare(sa, undefined, { numeric: true, sensitivity: 'base' });
    });
    return copy;
  }

  /* ---------- 文本 ---------- */
  /** 原站把后端数据直接拼进 HTML，这里补上转义 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function shortAddr(a) {
    a = String(a || '');
    return a.length > 16 ? a.slice(0, 6) + '…' + a.slice(-6) : a;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /** 秒级时间戳 → YYYY-MM-DD HH:mm:ss（原站用 moment(t*1000)，这里不依赖 moment） */
  function fmtTime(ts) {
    var d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ---------- 复制 ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); },
        function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch (e) { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }

  /* ---------- Toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    var el = qs('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }

  /* ---------- 金额展示 ---------- */
  function amount(n, d) { return fmt(n, d === undefined ? 2 : d); }

  return {
    qs: qs, qsa: qsa, fmt: fmt, amount: amount, preciseAdd: preciseAdd,
    sortByField: sortByField, esc: esc, shortAddr: shortAddr, fmtTime: fmtTime,
    copyText: copyText, toast: toast
  };
})();
