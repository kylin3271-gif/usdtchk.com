/* =========================================================
   batch.js —— 批量查询页（对应原站 批量功能页.txt）
   保留原站核心资产：200ms 串行队列（防止并发打爆节点）
   保留：逐条增量渲染、定点累加、失败占位行、排序、复制
   修掉原站的问题：
     - 上限文案三处不一致（2000 / 100 / 2000）→ 统一为 MAX_ADDR = 200
     - 队列无法取消 → 加了“停止”按钮
     - 失败行没有地址 → 已补上
     - 无转义 → 已补
   ========================================================= */
(function () {
  'use strict';
  var $ = window.U;

  var MAX_ADDR = 200;      /* 单次上限 */
  var INTERVAL = 200;      /* 原站 200ms 串行间隔 */

  var run = {
    list: [], idx: 0, timer: null, stopped: false, running: false,
    rows: [],                    /* {seq, address, trx, usdt, usdd, multi, status, raw...} */
    sum: { trx: 0, usdt: 0, usdd: 0 },
    ok: 0, fail: 0,
    sortKey: 'seq', sortDir: 1
  };

  var RE_TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

  document.addEventListener('DOMContentLoaded', function () {
    var ta = $.qs('#addrList');
    var cnt = $.qs('#lineCount');
    var btnRun = $.qs('#btnRun');
    var btnStop = $.qs('#btnStop');

    function parseLines(v) {
      return String(v || '').split(/\r?\n/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return RE_TRON.test(s); });
    }
    function updateCount() {
      var n = parseLines(ta.value).length;
      cnt.textContent = n + ' / ' + MAX_ADDR;
      cnt.classList.toggle('bad', n > MAX_ADDR);
    }
    ta.addEventListener('input', updateCount);
    updateCount();

    $.qs('#btnSample').addEventListener('click', function () {
      ta.value = sampleAddresses(5).join('\n');
      updateCount();
    });
    $.qs('#btnClear').addEventListener('click', function () {
      ta.value = '';
      updateCount();
      $.qs('#batchResult').style.display = 'none';
      run.rows = [];
    });

    btnRun.addEventListener('click', function () {
      var list = parseLines(ta.value);
      if (!list.length) { $.toast('没有可查询的地址（需 T 开头 34 位）'); return; }
      if (list.length > MAX_ADDR) { $.toast('一次最多 ' + MAX_ADDR + ' 个地址，请分批'); return; }
      start(list, btnRun, btnStop);
    });

    btnStop.addEventListener('click', function () {
      run.stopped = true;
      clearTimeout(run.timer);
      finish(btnRun, btnStop, true);
    });

    $.qs('#btnCopy').addEventListener('click', function () {
      if (!run.rows.length) { $.toast('暂无可复制的结果'); return; }
      var tsv = '地址\tTRX\tUSDT\tUSDD\t多签\t状态\n' + run.rows.map(function (r) {
        return [r.address, r.trxDis, r.usdtDis, r.usddDis, r.multi, r.status].join('\t');
      }).join('\n');
      $.copyText(tsv);
    });

    $.qs('#btnCsv').addEventListener('click', function () {
      if (!run.rows.length) { $.toast('暂无可导出的结果'); return; }
      var csv = '\ufeff序号,地址,TRX,USDT,USDD,多签,状态\n' + run.rows.map(function (r, i) {
        return [i + 1, r.address, r.trxDis, r.usdtDis, r.usddDis, r.multi, r.status].join(',');
      }).join('\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'batch-balance.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 800);
      $.toast('CSV 已导出');
    });

    /* 表头排序 */
    $.qsa('#batchTable th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-k');
        if (run.sortKey === k) run.sortDir *= -1;
        else { run.sortKey = k; run.sortDir = 1; }
        drawRows();
      });
    });
  });

  /* =========================================================
     串行队列（原站 sendRequests 的等价实现）
     ========================================================= */
  function start(list, btnRun, btnStop) {
    run.list = list; run.idx = 0; run.rows = [];
    run.sum = { trx: 0, usdt: 0, usdd: 0 };
    run.ok = 0; run.fail = 0; run.stopped = false; run.running = true;
    run.sortKey = 'seq'; run.sortDir = 1;

    $.qs('#batchResult').style.display = 'block';
    $.qs('#batchBody').innerHTML = '';
    $.qs('#progress').style.display = 'block';
    $.qs('#progressBar').style.width = '0%';
    $.qs('#batchTip').textContent = '查询中…';
    drawSum();

    btnRun.disabled = true;
    btnStop.style.display = '';
    btnStop.disabled = false;

    setTimeout(function () { step(btnRun, btnStop); }, 0);
  }

  function step(btnRun, btnStop) {
    if (run.stopped) return;
    if (run.idx >= run.list.length) { finish(btnRun, btnStop, false); return; }

    var addr = run.list[run.idx];
    API.batch(addr).then(function (res) {
      if (run.stopped) return;
      handleOne(addr, res);
      run.idx++;
      var pct = Math.round(run.idx / run.list.length * 100);
      $.qs('#progressBar').style.width = pct + '%';
      $.qs('#batchTip').textContent = '查询中 ' + run.idx + ' / ' + run.list.length;
      run.timer = setTimeout(function () { step(btnRun, btnStop); }, INTERVAL);   /* 串行间隔 */
    });
  }

  function handleOne(addr, res) {
    var seq = run.idx + 1;
    var row;

    if (res && res.code === 1 && res.data) {
      var d = res.data;
      row = {
        seq: seq, address: addr,
        trx: Number(d.trx || 0), usdt: Number(d.usdt || 0), usdd: Number(d.usdd || 0),
        trxDis: d.trx_dis || $.amount(d.trx), usdtDis: d.usdt_dis || $.amount(d.usdt),
        usddDis: d.usdd_dis || $.amount(d.usdd),
        multi: d.is_multi || '否', status: '成功'
      };
      run.sum.trx = $.preciseAdd(run.sum.trx, row.trx);
      run.sum.usdt = $.preciseAdd(run.sum.usdt, row.usdt);
      run.sum.usdd = $.preciseAdd(run.sum.usdd, row.usdd);
      run.ok++;
    } else {
      row = {
        seq: seq, address: addr, trx: 0, usdt: 0, usdd: 0,
        trxDis: '—', usdtDis: '—', usddDis: '—', multi: '—', status: '失败'
      };
      run.fail++;
    }

    run.rows.push(row);
    appendRow(row);
    drawSum();
    updateHeaderSort();
  }

  /* 增量插入（原站 upTable 的行为：来一条插一条，不整表重绘） */
  function appendRow(r) {
    var tbody = $.qs('#batchBody');
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="mono" style="color:#9e9e9e">' + r.seq + '</td>' +
      '<td class="mono">' + $.esc(r.address) + '</td>' +
      '<td class="mono">' + $.esc(r.trxDis) + '</td>' +
      '<td class="mono">' + $.esc(r.usdtDis) + '</td>' +
      '<td class="mono">' + $.esc(r.usddDis) + '</td>' +
      '<td>' + (r.multi === '是' ? '<span style="color:#dd3545">是</span>' : $.esc(r.multi)) + '</td>' +
      '<td>' + (r.status === '成功' ? '<span style="color:#198754">成功</span>' : '<span style="color:#dd3545">失败</span>') + '</td>';
    tbody.appendChild(tr);
  }

  /* 排序后整表重绘（原站 updateSortData 的等价实现） */
  function drawRows() {
    var rows = $.sortByField(run.rows, run.sortKey === 'multi' ? 'multi' : (run.sortKey === 'status' ? 'status' : run.sortKey),
      run.sortDir === 1 ? 'asc' : 'desc');
    var tbody = $.qs('#batchBody');
    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td class="mono" style="color:#9e9e9e">' + r.seq + '</td>' +
        '<td class="mono">' + $.esc(r.address) + '</td>' +
        '<td class="mono">' + $.esc(r.trxDis) + '</td>' +
        '<td class="mono">' + $.esc(r.usdtDis) + '</td>' +
        '<td class="mono">' + $.esc(r.usddDis) + '</td>' +
        '<td>' + (r.multi === '是' ? '<span style="color:#dd3545">是</span>' : $.esc(r.multi)) + '</td>' +
        '<td>' + (r.status === '成功' ? '<span style="color:#198754">成功</span>' : '<span style="color:#dd3545">失败</span>') + '</td>' +
        '</tr>';
    }).join('');
    updateHeaderSort();
  }

  function updateHeaderSort() {
    $.qsa('#batchTable th.sortable').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-k') === run.sortKey) th.classList.add(run.sortDir === 1 ? 'asc' : 'desc');
      var ar = th.querySelector('.ar');
      if (ar) ar.textContent = (th.getAttribute('data-k') === run.sortKey) ? (run.sortDir === 1 ? '▲' : '▼') : '⇅';
    });
  }

  function drawSum() {
    $.qs('#sumTotal').textContent = run.rows.length;
    $.qs('#sumTrx').textContent = $.amount(run.sum.trx);
    $.qs('#sumUsdt').textContent = $.amount(run.sum.usdt);
    $.qs('#sumUsdd').textContent = $.amount(run.sum.usdd);
    $.qs('#sumOk').textContent = run.ok + ' / ' + run.fail;
  }

  function finish(btnRun, btnStop, stopped) {
    run.running = false;
    btnRun.disabled = false;
    btnStop.style.display = 'none';
    $.qs('#progress').style.display = 'none';
    $.qs('#batchTip').textContent = stopped
      ? '已停止：完成 ' + run.rows.length + ' / ' + run.list.length
      : '已完成 ' + run.rows.length + ' 个地址';
    if (!run.rows.length) {
      $.qs('#batchBody').innerHTML = '<tr><td colspan="7" class="tbl-empty">暂无结果</td></tr>';
    }
  }

  /* 示例地址 */
  function sampleAddresses(n) {
    var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    var out = [];
    var seed = 20261121;
    function rnd() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    for (var i = 0; i < n; i++) {
      var s = 'T';
      for (var j = 0; j < 33; j++) s += B58[Math.floor(rnd() * B58.length)];
      out.push(s);
    }
    return out;
  }
})();
