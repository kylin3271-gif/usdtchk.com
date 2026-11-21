/* =========================================================
   home.js —— 首页逻辑（对应原站 查哈希首页.txt）
   保留：isPay() 的首字/长度校验、表单提交、价格条
   改动：提交目标改成 result.html?addr=…（不再依赖 PHP 路由）
   ========================================================= */
(function () {
  'use strict';
  var $ = window.U;

  /* ---------- 1. 地址校验（原站 isPay 的等价实现，补了 base58 校验） ---------- */
  var RE_TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
  var RE_ETH = /^0x[a-fA-F0-9]{40}$/;

  function validate(raw) {
    var v = String(raw || '').replace(/\s+/g, '');
    if (!v) return '请输入要查询的钱包地址';
    var first = v.charAt(0);
    if (first === 'T' || first === 't') {
      if (v.length !== 34) return '波场地址应为 34 位，当前 ' + v.length + ' 位';
      if (!RE_TRON.test(v)) return '波场地址含非法字符（应为 T 开头 + 33 位 base58）';
      return '';
    }
    if (first === '0') {
      if (v.length !== 42) return '以太坊地址应为 42 位，当前 ' + v.length + ' 位';
      if (!RE_ETH.test(v)) return '以太坊地址格式不正确（应为 0x + 40 位十六进制）';
      return '';
    }
    return '地址应以 T（波场）或 0（以太坊）开头';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var form = $.qs('#searchForm');
    var input = $.qs('#addrInput');
    var errBox = $.qs('#formErr');
    var btn = $.qs('#searchBtn');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      var err = validate(v);
      if (err) {
        errBox.textContent = err;
        errBox.style.display = 'block';
        input.parentNode.style.borderColor = '#dd3545';
        input.focus();
        return;
      }
      errBox.style.display = 'none';
      input.parentNode.style.borderColor = '';
      btn.disabled = true;
      btn.textContent = '读取中';
      setTimeout(function () {
        location.href = 'result.html?addr=' + encodeURIComponent(v.replace(/\s+/g, ''));
      }, 300);
    });

    input.addEventListener('input', function () {
      if (errBox.style.display === 'block') { errBox.style.display = 'none'; input.parentNode.style.borderColor = ''; }
    });

    /* ---------- 2. 价格条 ---------- */
    /* 原站由后端渲染“欧易前10商家均价”。这里：有配置用配置，没有就用示例值并明确标注 */
    /* 版面按设计稿：图标 + 币种名 + 「数字 ¥」，不带 /CNY 后缀 */
    var DEFAULT_PRICES = [
      { k: 'USDT', g: 'T', v: '6.67',      c: '#26a17b' },
      { k: 'BTC',  g: '\u20BF', v: '390,052', c: '#f7931a' },
      { k: 'TRX',  g: 'T', v: '2.01',      c: '#e8453c' },
      { k: 'ETH',  g: '\u039E', v: '10,789.59', c: '#627eea' }
    ];
    var prices = (window.SITE_CONFIG && window.SITE_CONFIG.prices) || DEFAULT_PRICES;
    var strip = $.qs('#priceStrip');
    if (strip) {
      strip.innerHTML = prices.map(function (p) {
        var glyph = p.g || p.k.charAt(0);
        return '<div class="price-card">' +
          '<div class="price-ico" style="background:' + $.esc(p.c || '#4e6ef2') + '">' + $.esc(glyph) + '</div>' +
          '<div><div class="nm">' + $.esc(p.k) + '</div>' +
          '<div class="vl">' + $.esc(p.v) + ' \u00A5</div></div>' +
          '</div>';
      }).join('');
    }

    /* 报价说明：接了真实行情就沿用原站文案；没接就改成“示例参考价”，
       不在页面上写“实时获取…均价”这种无法兑现的承诺 */
    var noteLine1 = $.qs('#priceNoteLine1');
    if (noteLine1 && !(window.SITE_CONFIG && window.SITE_CONFIG.prices)) {
      noteLine1.textContent = '示例参考价（未接入行情源）';
    }
  });
})();
