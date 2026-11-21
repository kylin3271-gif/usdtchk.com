/* =========================================================
   result.js —— 地址详情页（对应原站 结果页.txt）
   保留原站数据流：
     进页并发两个请求
       ① balance → 概览（TRX/USDT/能量/激活时间/CNY/多签）
       ② txs(page=1) → 列表 + 收入/支出汇总 + 分页
     筛选把参数回传后端；哈希掩码→点击展开并复制；高度→弹层取块信息
   改动（都在 README 里写明）：
     - 地址来自 ?addr= 或服务端注入的 window.__ADDRESS__，不再硬编码
     - 币种 tab 由“整页跳转 /type/xxx.html”改为前端切换（避免路由耦合）
     - 新增转义、超时、空态、错误提示
   ========================================================= */
(function () {
  'use strict';
  var $ = window.U;

  var PAGE_SIZE = 20;
  var state = { address: '', type: 'USDT', direction: '全部', min: '', max: '', start: '', end: '', page: 1 };
  var lastTotal = 0;

  /* ---------- 取地址 ---------- */
  function pickAddress() {
    var q = new URLSearchParams(location.search).get('addr');
    if (q) return q.trim();
    if (window.__ADDRESS__) return String(window.__ADDRESS__).trim();
    return '';
  }

  function isEth(a) { return a.slice(0, 2).toLowerCase() === '0x'; }

  document.addEventListener('DOMContentLoaded', function () {
    var addr = pickAddress();
    if (!addr) { location.href = 'index.html'; return; }
    state.address = addr;

    /* 链上类型决定第二个 tab 名称 */
    var nativeTab = isEth(addr) ? 'ETH' : 'TRX';
    $.qs('#tabNative').textContent = nativeTab;

    $.qs('#addrText').textContent = addr;
    $.qs('#chainTag').textContent = isEth(addr) ? 'Ethereum' : 'TRON';

    $.qs('#copyAddr').addEventListener('click', function () { $.copyText(addr); });

    /* 币种 tab（原站是整页跳转，这里改成前端切换） */
    $.qsa('#typeTabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.type = b.getAttribute('data-type');
        state.page = 1;
        $.qsa('#typeTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        loadTxs();
      });
    });

    /* 筛选 */
    $.qs('#fApply').addEventListener('click', function () {
      state.direction = $.qs('#fDir').value;
      state.min = $.qs('#fMin').value.trim();
      state.max = $.qs('#fMax').value.trim();
      state.start = $.qs('#fStart').value;
      state.end = $.qs('#fEnd').value;
      state.page = 1;
      loadTxs();
    });
    $.qs('#fReset').addEventListener('click', function () {
      state.direction = '全部'; state.min = ''; state.max = ''; state.start = ''; state.end = ''; state.page = 1;
      $.qs('#fDir').value = '全部';
      $.qs('#fMin').value = ''; $.qs('#fMax').value = '';
      $.qs('#fStart').value = ''; $.qs('#fEnd').value = '';
      loadTxs();
    });
    $.qs('#fStart').addEventListener('change', function () { $.qs('#fApply').click(); });
    $.qs('#fEnd').addEventListener('change', function () { $.qs('#fApply').click(); });

    loadBalance();
    loadTxs();
  });

  /* =========================================================
     ① 概览
     ========================================================= */
  function loadBalance() {
    API.balance(state.address).then(function (res) {
      if (!res || res.code !== 1) {
        setOv('#ovTrx', '—'); setOv('#ovUsdt', '—');
        $.toast((res && res.msg) || '余额获取失败');
        return;
      }
      var d = res.data || {};
      setOv('#ovTrx', d.TRX_TOTAL);
      setOv('#ovUsdt', d.USDT_TOTAL);
      setOv('#ovEnergy', d.EnergyLimit);
      setOv('#ovCny', d.cny_value ? '¥ ' + d.cny_value : '—');
      setOv('#ovMulti', d.is_multi);
      setOv('#ovActive', (!d.firstTransactionTime || d.firstTransactionTime == 0) ? '未激活' : d.firstTransactionTime);
    });
  }
  function setOv(sel, val) {
    var el = $.qs(sel);
    if (el) el.textContent = (val === undefined || val === null || val === '') ? '—' : String(val);
  }

  /* =========================================================
     ② 交易列表
     ========================================================= */
  function loadTxs() {
    API.mask(true);
    API.txs({
      address: state.address,
      type: state.type,
      direction: state.direction,
      minvolume: state.min,
      maxvolume: state.max,
      timestampStart: state.start,
      timestampEnd: state.end,
      page: state.page
    }).then(function (res) {
      API.mask(false);
      if (!res || res.code !== 1) {
        renderError((res && res.msg) || '交易记录获取失败');
        return;
      }
      render(res.data || {});
    });
  }

  function render(data) {
    var list = data.transactionsList || [];
    lastTotal = Number(data.total || 0);

    /* --- 汇总：USDT 是 6 位精度，TRX/ETH 直接格式化（原站逻辑） --- */
    var inVol = Number(data.totalInVolume || 0);
    var outVol = Number(data.totalOutVolume || 0);
    if ((data.type || state.type) === 'USDT') { inVol /= 1000000; outVol /= 1000000; }

    var sum = $.qs('#sumLine');
    sum.innerHTML = '共计 <b>' + lastTotal + '</b> 条 · 收入 <span class="in">' +
      $.amount(inVol) + '</span> ' + $.esc(data.type || state.type) +
      ' · 支出 <span class="out">' + $.amount(outVol) + '</span> ' + $.esc(data.type || state.type) +
      (API.cfg.mode === 'mock' ? ' <span class="dim">（示例数据）</span>' : '');

    /* --- 行渲染 --- */
    var rows = list.map(function (t) {
      var isOut = String(t.from) === state.address;
      var raw = String(t.value == null ? '0' : t.value).replace(/^[+-]/, '');
      var amt = '<span class="' + (isOut ? 'amt-out' : 'amt-in') + '">' + (isOut ? '−' : '+') + $.esc(raw) + ' ' + $.esc(data.type || state.type) + '</span>';

      return '<tr>' +
        '<td class="mono" style="white-space:nowrap">' + $.fmtTime(t.time) + '</td>' +
        '<td>' + (isOut ? '<span style="color:#dd3545">转出</span>' : '<span style="color:#198754">接收</span>') + '</td>' +
        '<td class="mono ellip" title="' + $.esc(isOut ? t.to : t.from) + '">' + $.esc($.shortAddr(isOut ? t.to : t.from)) + '</td>' +
        '<td>' + amt + '</td>' +
        '<td><span class="hash-link" data-hash="' + $.esc(t.blockHash || '') + '">' +
          (t.blockHash ? '*****' + $.esc(String(t.blockHash).slice(-6)) : '—') + '</span></td>' +
        '<td><span class="hash-link" data-hash="' + $.esc(t.txid || '') + '">' +
          (t.txid ? '*****' + $.esc(String(t.txid).slice(-6)) : '—') + '</span></td>' +
        '<td><span class="height-link" data-h="' + $.esc(t.block_no) + '">' + $.esc(t.block_no) + '</span></td>' +
        '</tr>';
    }).join('');

    var body = $.qs('#txBody');
    body.innerHTML = rows || '<tr><td colspan="7" class="tbl-empty">该筛选条件下没有记录，试试放宽金额或时间范围</td></tr>';

    bindRowEvents();
    renderPager();
  }

  function renderError(msg) {
    $.qs('#txBody').innerHTML = '<tr><td colspan="7" class="tbl-empty">' + $.esc(msg) + '</td></tr>';
    $.qs('#sumLine').textContent = '加载失败';
    $.qs('#txPager').innerHTML = '';
  }

  /* 哈希/高度点击：原站是“展开并复制”、“弹层查块”，这里保留行为 */
  function bindRowEvents() {
    $.qsa('#txBody .hash-link').forEach(function (el) {
      el.addEventListener('click', function () {
        var h = el.getAttribute('data-hash');
        if (!h) return;
        if (el.getAttribute('data-open') === '1') {
          el.textContent = '*****' + h.slice(-6);
          el.removeAttribute('data-open');
          return;
        }
        el.textContent = h;
        el.setAttribute('data-open', '1');
        $.copyText(h);
      });
    });

    $.qsa('#txBody .height-link').forEach(function (el) {
      el.addEventListener('click', function () {
        var h = el.getAttribute('data-h');
        API.block(h).then(function (res) {
          if (!res || res.code !== 1 || !res.data || !res.data.data || !res.data.data[0]) {
            $.toast((res && res.msg) || '区块信息获取失败');
            return;
          }
          var d = res.data.data[0];
          openModal('区块详情', [
            ['出块者', d.witnessName],
            ['出块时间', $.fmtTime(d.timestamp > 1e11 ? d.timestamp / 1000 : d.timestamp)],
            ['区块高度', d.number],
            ['区块哈希', d.hash]
          ]);
        });
      });
    });
  }

  /* =========================================================
     ③ 分页
     ========================================================= */
  function renderPager() {
    var pages = Math.max(1, Math.ceil(lastTotal / PAGE_SIZE));
    if (state.page > pages) state.page = pages;

    var box = $.qs('#txPager');
    if (pages <= 1) { box.innerHTML = ''; return; }

    var html = '<button data-p="' + (state.page - 1) + '" ' + (state.page === 1 ? 'disabled' : '') + '>上一页</button>';
    var from = Math.max(1, state.page - 2), to = Math.min(pages, from + 4);
    if (state.page <= 2) to = Math.min(pages, 5);
    if (state.page >= pages - 1) from = Math.max(1, pages - 4);

    if (from > 1) html += '<button data-p="1">1</button>' + (from > 2 ? '<span class="info">…</span>' : '');
    for (var p = from; p <= to; p++) {
      html += '<button data-p="' + p + '" class="' + (p === state.page ? 'on' : '') + '">' + p + '</button>';
    }
    if (to < pages) html += (to < pages - 1 ? '<span class="info">…</span>' : '') + '<button data-p="' + pages + '">' + pages + '</button>';

    html += '<button data-p="' + (state.page + 1) + '" ' + (state.page === pages ? 'disabled' : '') + '>下一页</button>';
    html += '<span class="info">' + state.page + ' / ' + pages + '</span>';
    box.innerHTML = html;

    $.qsa('#txPager button').forEach(function (b) {
      b.addEventListener('click', function () {
        var p2 = Number(b.getAttribute('data-p'));
        if (p2 >= 1 && p2 <= pages && p2 !== state.page) { state.page = p2; loadTxs(); }
      });
    });
  }

  /* =========================================================
     ④ 弹层
     ========================================================= */
  function openModal(title, rows) {
    var m = $.qs('#modal');
    $.qs('#modalTitle').textContent = title + (API.cfg.mode === 'mock' ? '（示例数据）' : '');
    $.qs('#modalBody').innerHTML = rows.map(function (r) {
      return '<div class="row"><span>' + $.esc(r[0]) + '</span><span>' + $.esc(r[1] == null ? '—' : r[1]) + '</span></div>';
    }).join('');
    m.classList.add('show');
  }

  window.__closeModal = function () { $.qs('#modal').classList.remove('show'); };
})();
