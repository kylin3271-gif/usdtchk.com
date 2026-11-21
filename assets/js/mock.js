/* =========================================================
   mock.js —— 演示数据源
   作用：不接后端也能把三页逻辑跑通（file:// 直接双击即可打开）
   返回结构严格对齐原站 4 个接口，前端渲染逻辑一行都不用改
   ========================================================= */
window.MOCK = (function () {
  'use strict';

  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function hashSeed(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function skew(rnd, min, max) { return min + Math.pow(rnd(), 2.2) * (max - min); }
  function tron(rnd) {
    var s = 'T';
    for (var i = 0; i < 33; i++) s += B58[Math.floor(rnd() * B58.length)];
    return s;
  }
  function hex(rnd, n, prefix) {
    var s = prefix || '', h = '0123456789abcdef';
    for (var i = 0; i < n; i++) s += h[Math.floor(rnd() * 16)];
    return s;
  }
  function money(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** 余额：TRX_TOTAL / USDT_TOTAL 为展示字符串；totalIn/Out 才是原始最小单位 */
  function balance(params) {
    var addr = params.search || params.address || '';
    var rnd = mulberry32(hashSeed(addr + '#bal'));
    var trx = skew(rnd, 10, 260000);
    var usdt = skew(rnd, 0, 90000);
    var energy = rnd() < 0.35 ? 0 : Math.floor(skew(rnd, 800, 132000));
    var activated = rnd() < 0.1 ? 0 : (Date.now() / 1000 - skew(rnd, 300, 2100 * 86400 / 86400) * 86400);
    var d = new Date(activated * 1000);
    var pad = function (n) { return n < 10 ? '0' + n : n; };

    return {
      code: 1,
      data: {
        TRX_TOTAL: money(trx),
        USDT_TOTAL: money(usdt),
        cny_value: money(usdt * 6.67 + trx * 2.01),
        is_multi: rnd() < 0.11 ? '是' : '否',
        EnergyLimit: String(energy),
        firstTransactionTime: activated
          ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          : 0
      }
    };
  }

  /** 交易列表：totalIn/totalOut 用最小单位（USDT 6 位），行内 value 直接是展示串 */
  function txs(params) {
    var addr = params.address || '';
    var type = (params.type || 'USDT').toUpperCase();
    var dir = params.direction || '全部';
    var minV = params.minvolume === '' || params.minvolume == null ? -Infinity : Number(params.minvolume);
    var maxV = params.maxvolume === '' || params.maxvolume == null ? Infinity : Number(params.maxvolume);
    var startTs = params.timestampStart ? new Date(params.timestampStart + 'T00:00:00').getTime() / 1000 : 0;
    var endTs = params.timestampEnd ? new Date(params.timestampEnd + 'T23:59:59').getTime() / 1000 : 9999999999;
    var page = Math.max(1, Number(params.page) || 1);
    var pageSize = 20;

    var rnd = mulberry32(hashSeed(addr + '#' + type));
    var all = [];
    var n = 90 + Math.floor(rnd() * 260);
    var cursor = Date.now() / 1000 - skew(rnd, 60, 7200);

    for (var i = 0; i < n; i++) {
      cursor -= skew(rnd, 60, 36000);
      var other = tron(rnd);
      var isIn = rnd() < 0.48;
      var amount = type === 'USDT'
        ? Math.round(skew(rnd, 0.01, 4800) * 100) / 100
        : Math.round(skew(rnd, 0.1, 5200) * 100) / 100;

      all.push({
        time: Math.floor(cursor),
        from: isIn ? other : addr,
        to: isIn ? addr : other,
        value: (isIn ? '' : '-') + money(amount),
        _n: amount,
        _in: isIn,
        blockHash: hex(rnd, 64, ''),
        txid: hex(rnd, 64, ''),
        block_no: 58000000 + Math.floor(rnd() * 22000000)
      });
    }

    /* 过滤：方向 / 金额区间 / 日期 */
    var filtered = all.filter(function (t) {
      if (dir === 'in' && !t._in) return false;
      if (dir === 'out' && t._in) return false;
      if (t._n < minV || t._n > maxV) return false;
      if (t.time < startTs || t.time > endTs) return false;
      return true;
    });

    var inSum = 0, outSum = 0;
    filtered.forEach(function (t) { if (t._in) inSum += t._n; else outSum += t._n; });

    var slice = filtered.slice((page - 1) * pageSize, page * pageSize).map(function (t) {
      t = Object.assign({}, t);
      delete t._n; delete t._in;
      return t;
    });

    var scale = (type === 'USDT') ? 1000000 : 1;   /* 原站只对 USDT 做了 /1000000 */

    return {
      code: 1,
      data: {
        address: addr,
        type: type,
        total: filtered.length,
        totalInVolume: String(Math.round(inSum * scale)),
        totalOutVolume: String(Math.round(outSum * scale)),
        transactionsList: slice
      }
    };
  }

  /** 区块详情 */
  function block(params) {
    var h = Number(params.height) || 0;
    var rnd = mulberry32(hashSeed('blk' + h));
    return {
      code: 1,
      data: {
        data: [{
          witnessName: tron(rnd),
          timestamp: (h > 0 ? (1600000000000 + h * 3000) : Date.now() * 1),
          number: h,
          hash: hex(rnd, 64, '')
        }]
      }
    };
  }

  /** 批量单地址余额（原站失败时返回 code!=1，前端插“失败”占位行） */
  function batch(params) {
    var addr = (params.address || '').trim();
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) {
      return { code: 0, msg: '地址格式不正确' };
    }
    var rnd = mulberry32(hashSeed(addr + '#b'));
    var trx = Math.round(skew(rnd, 1, 180000) * 100) / 100;
    var usdt = Math.round(skew(rnd, 0, 62000) * 100) / 100;
    var usdd = Math.round(skew(rnd, 0, 9000) * 100) / 100;
    return {
      code: 1,
      data: {
        address: addr,
        trx: trx, trx_dis: money(trx),
        usdt: usdt, usdt_dis: money(usdt),
        usdd: usdd, usdd_dis: money(usdd),
        is_multi: rnd() < 0.12 ? '是' : '否'
      }
    };
  }

  return { balance: balance, txs: txs, block: block, batch: batch };
})();
