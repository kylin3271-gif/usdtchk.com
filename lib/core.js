/**
 * server.js —— 方案B：零依赖 Node 服务（Node 18+，用内置 fetch）
 *
 * 职责：
 *   1. 静态托管 ../web
 *   2. 提供 /api/balance | /api/txs | /api/block | /api/batch
 *   3. 内存 LRU 缓存 + 每 IP 限流 + 可选 CORS
 *   4. MOCK=1 时用确定性数据跑通全流程（无 key 也能端到端自测）
 *
 * 启动：
 *   TRONGRID_KEY=xxx node server.js
 *   MOCK=1 node server.js            # 演示模式
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------- 配置 ---------------- */
const CFG = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  mock: process.env.MOCK === '1' || !process.env.TRONGRID_KEY,
  trongrid: process.env.TRONGRID_BASE || 'https://api.trongrid.io',
  trongridKey: process.env.TRONGRID_KEY || '',
  blockscout: process.env.BLOCKSCOUT_BASE || 'https://eth.blockscout.com',
  usdtTrc20: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  usddTrc20: 'TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn',
  usdtErc20: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  pageSize: 20,
  maxBatch: 200,
  cacheTtl: Number(process.env.CACHE_TTL || 20),     // 秒
  ratePerMin: Number(process.env.RATE_PER_MIN || 60),
  timeout: Number(process.env.UPSTREAM_TIMEOUT || 12000),
  usdtCny: Number(process.env.USDT_CNY || 6.67),
  cors: process.env.CORS_ORIGIN || '',               // 例：https://your-site.com
  webDir: path.join(__dirname, '..', 'web'),
};

/* ---------------- 小工具 ---------------- */
const RE_TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const RE_ETH = /^0x[a-fA-F0-9]{40}$/;


/** 最小单位 → 数量字符串（BigInt，避免浮点误差） */
function unit2dec(raw, dec = 6) {
  const s = String(raw == null ? '0' : raw).replace(/[^\d]/g, '') || '0';
  const big = BigInt(s);
  const base = BigInt('1' + '0'.repeat(dec));
  const int = big / base;
  const frac = (big % base).toString().padStart(dec, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : String(int);
}
function sun2trx(sun) { return unit2dec(sun, 6); }
function wei2eth(wei) { return unit2dec(wei, 18); }

/* base58（TRON hex 地址 → T 开头） */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function hexToBase58(hex) {
  let h = String(hex).replace(/^0x/i, '').toLowerCase();
  if (h.length === 40) h = '41' + h;
  if (h.length !== 42 || !h.startsWith('41')) return h;
  const raw = Buffer.from(h, 'hex');
  const chk = crypto.createHash('sha256').update(crypto.createHash('sha256').update(raw).digest()).digest().subarray(0, 4);
  let num = BigInt('0x' + Buffer.concat([raw, chk]).toString('hex'));
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  return out || '1';
}

/* ---------------- 缓存（简单 LRU + TTL） ---------------- */
const cache = new Map();
const CACHE_MAX = 2000;
function cget(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() > e.until) { cache.delete(k); return null; }
  cache.delete(k); cache.set(k, e);          // 触达移到队尾
  return e.v;
}
function cput(k, v) {
  cache.set(k, { v, until: Date.now() + CFG.cacheTtl * 1000 });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/* ---------------- 限流 ---------------- */
const hits = new Map();
function rateLimit(ip) {
  const now = Math.floor(Date.now() / 60000);
  const e = hits.get(ip);
  if (!e || e.min !== now) { hits.set(ip, { min: now, n: 1 }); return true; }
  e.n += 1;
  if (hits.size > 5000) hits.clear();
  return e.n <= CFG.ratePerMin;
}

/* ---------------- 上游 fetch ---------------- */
async function upstream(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CFG.timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { accept: 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error('upstream HTTP ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error('upstream non-JSON'); }
  } finally { clearTimeout(t); }
}
const tronHeaders = () => ({ 'TRON-PRO-API-KEY': CFG.trongridKey });

/* trc20 列表接口不返回区块号/区块哈希：按 txid 向节点补查（并发 5，单条失败不影响整页） */
async function fillBlockInfo(rows) {
  const need = rows.filter((r) => r.txid && (!r.block_no || !r.blockHash));
  if (!need.length) return;
  const CONC = 5;
  for (let i = 0; i < need.length; i += CONC) {
    await Promise.all(need.slice(i, i + CONC).map(async (r) => {
      try {
        const info = await upstream(`${CFG.trongrid}/wallet/gettransactioninfobyid`, {
          method: 'POST',
          headers: { ...tronHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ value: r.txid })
        });
        if (info && info.blockNumber) r.block_no = info.blockNumber;
        if (info && info.blockID) r.blockHash = info.blockID;
      } catch { /* 忽略：拿不到就留空，前端显示 — */ }
    }));
  }
}

/* ---------------- TRON ---------------- */
async function tronAccount(addr) {
  const key = 'tron:acc:' + addr;
  const c = cget(key); if (c) return c;

  const r = await upstream(`${CFG.trongrid}/${'v1/accounts/'}${encodeURIComponent(addr)}`, { headers: tronHeaders() });
  const a = (r.data && r.data[0]) || {};

  let usdt = '0', usdd = '0';
  (a.trc20 || []).forEach((item) => {
    Object.keys(item).forEach((contract) => {
      if (contract.toLowerCase() === CFG.usdtTrc20.toLowerCase()) usdt = unit2dec(item[contract], 6);
      if (contract.toLowerCase() === CFG.usddTrc20.toLowerCase()) usdd = unit2dec(item[contract], 18);
    });
  });

  const multi = ((a.active_permissions || []).length > 1) ||
    ((a.owner_permission && a.owner_permission.threshold || 0) > 1) ? '是' : '否';

  const acc = {
    trx: sun2trx(a.balance || 0), trx_dis: sun2trx(a.balance || 0),
    usdt, usdt_dis: usdt, usdd, usdd_dis: usdd,
    is_multi: multi,
    energy: a.energy_limit || 0,
    activated: !!a.balance || (a.trc20 || []).length > 0
  };
  cput(key, acc);
  return acc;
}

async function tronTxs(q) {
  const page = Math.max(1, Number(q.page) || 1);
  const size = CFG.pageSize;
  const need = page * size;
  if (need > 200) throw new Error('DEEP_PAGE');

  const items = [];
  let total = need;

  if (q.type === 'USDT') {
    let url = `${CFG.trongrid}/v1/accounts/${encodeURIComponent(q.address)}/transactions/trc20` +
      `?limit=${need}&contract_address=${encodeURIComponent(CFG.usdtTrc20)}&only_confirmed=true`;
    if (q.direction === 'in') url += `&only_to=${encodeURIComponent(q.address)}`;
    if (q.direction === 'out') url += `&only_from=${encodeURIComponent(q.address)}`;
    if (q.timestampStart) url += `&min_timestamp=${Number(q.timestampStart)}`;
    if (q.timestampEnd) url += `&max_timestamp=${Number(q.timestampEnd)}`;

    const r = await upstream(url, { headers: tronHeaders() });
    (r.data || []).forEach((it) => {
      const dec = (it.token_info && it.token_info.decimals) || 6;
      items.push({
        time: Math.floor((it.block_timestamp || 0) / 1000),
        from: it.from, to: it.to,
        value: unit2dec(it.value, dec),
        blockHash: it.block_hash || '',
        txid: it.transaction_id,
        block_no: it.block || 0,
      });
    });
  } else {
    let url = `${CFG.trongrid}/v1/accounts/${encodeURIComponent(q.address)}/transactions` +
      `?limit=${need}&only_confirmed=true&order_by=block_timestamp,desc`;
    const r = await upstream(url, { headers: tronHeaders() });
    (r.data || []).forEach((it) => {
      const c = (it.raw_data && it.raw_data.contract && it.raw_data.contract[0]) || {};
      if (c.type !== 'TransferContract') return;
      const v = c.parameter.value || {};
      items.push({
        time: Math.floor((it.block_timestamp || 0) / 1000),
        from: hexToBase58(v.owner_address || ''), to: hexToBase58(v.to_address || ''),
        value: sun2trx(v.amount || 0),
        blockHash: it.blockID || '', txid: it.txID, block_no: it.blockNumber || 0,
      });
    });
    if (q.direction === 'in') {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].to !== q.address) items.splice(i, 1);
    }
    if (q.direction === 'out') {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].from !== q.address) items.splice(i, 1);
    }
  }

  /* 金额区间：按展示串比较，避免精度口径混乱 */
  let rows = items;
  if (q.minvolume !== '' || q.maxvolume !== '') {
    const min = q.minvolume === '' ? -Infinity : Number(q.minvolume);
    const max = q.maxvolume === '' ? Infinity : Number(q.maxvolume);
    rows = rows.filter((r) => { const v = Number(r.value); return v >= min && v <= max; });
  }
  if (rows.length < need) total = (page - 1) * size + rows.length;

  let sumIn = 0n, sumOut = 0n;
  rows.forEach((r) => {
    const raw = BigInt(Math.round(Number(r.value) * 1e6));   /* 统一按 6 位累加 */
    if (r.to === q.address) sumIn += raw;
    if (r.from === q.address) sumOut += raw;
  });

  /* 契约：USDT 汇总必须是“6 位最小单位”（前端会 /1000000）；原生币直接给数量 */
  const cached = (v) => q.type === 'USDT' ? v.toString() : unit2dec(v.toString(), 6);
  const pageRows = rows.slice((page - 1) * size, page * size);
  if (q.type === 'USDT') await fillBlockInfo(pageRows);
  return {
    address: q.address, type: q.type, total,
    totalInVolume: cached(sumIn),
    totalOutVolume: cached(sumOut),
    transactionsList: pageRows
  };
}

async function tronBlock(height) {
  const r = await upstream(`${CFG.trongrid}/wallet/getblockbynumber`, {
    method: 'POST',
    headers: { ...tronHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ number: Number(height) })
  });
  const raw = (r.block_header && r.block_header.raw_data) || null;
  if (!raw) throw new Error('NO_BLOCK');
  return { data: [{
    witnessName: hexToBase58(raw.witness_address || ''),
    timestamp: Math.floor((raw.timestamp || 0) / 1000),
    number: raw.number, hash: r.blockID || ''
  }] };
}

/* ---------------- ETH（Blockscout，最小实现） ---------------- */
async function ethAccount(addr) {
  const key = 'eth:acc:' + addr.toLowerCase();
  const c = cget(key); if (c) return c;

  const a = await upstream(`${CFG.blockscout}/api/v2/addresses/${addr}`);
  let usdt = '0', usdd = '0';
  try {
    const tb = await upstream(`${CFG.blockscout}/api/v2/addresses/${addr}/token-balances`);
    (tb || []).forEach((row) => {
      const sym = String((row.token && row.token.symbol) || '').toUpperCase();
      const dec = (row.token && row.token.decimals) ?? 6;
      if (sym === 'USDT') usdt = unit2dec(row.value, dec);
      if (sym === 'USDD') usdd = unit2dec(row.value, dec);
    });
  } catch { /* 忽略 */ }

  const acc = {
    trx: wei2eth(a.coin_balance || 0), trx_dis: wei2eth(a.coin_balance || 0),
    usdt, usdt_dis: usdt, usdd, usdd_dis: usdd,
    is_multi: '—', energy: '—', activated: true
  };
  cput(key, acc);
  return acc;
}

async function ethTxs(q) {
  const page = Math.max(1, Number(q.page) || 1);
  const size = CFG.pageSize;

  const items = [];
  if (q.type === 'USDT') {
    const r = await upstream(`${CFG.blockscout}/api/v2/addresses/${q.address}/token-transfers?token=${CFG.usdtErc20}&type=ERC-20`);
    (r.items || []).forEach((it) => {
      const dec = (it.total && it.total.decimals) || 6;
      items.push({
        time: it.timestamp, from: (it.from && it.from.hash) || '', to: (it.to && it.to.hash) || '',
        value: unit2dec((it.total && it.total.value) || 0, dec),
        blockHash: it.block_hash || '', txid: it.transaction_hash, block_no: it.block_number || 0
      });
    });
  } else {
    const r = await upstream(`${CFG.blockscout}/api/v2/addresses/${q.address}/transactions`);
    (r.items || []).forEach((it) => {
      items.push({
        time: it.timestamp, from: (it.from && it.from.hash) || '', to: (it.to && it.to.hash) || '',
        value: wei2eth(it.value || 0),
        blockHash: it.block_hash || '', txid: it.hash, block_no: it.block_number || 0
      });
    });
  }

  let rows = items;
  if (q.direction === 'in') rows = rows.filter((r) => String(r.to).toLowerCase() === q.address.toLowerCase());
  if (q.direction === 'out') rows = rows.filter((r) => String(r.from).toLowerCase() === q.address.toLowerCase());
  if (q.minvolume !== '' || q.maxvolume !== '') {
    const min = q.minvolume === '' ? -Infinity : Number(q.minvolume);
    const max = q.maxvolume === '' ? Infinity : Number(q.maxvolume);
    rows = rows.filter((r) => { const v = Number(r.value); return v >= min && v <= max; });
  }

  let sumIn = 0n, sumOut = 0n;
  rows.forEach((r) => {
    const raw = BigInt(Math.round(Number(r.value) * 1e6));
    if (String(r.to).toLowerCase() === q.address.toLowerCase()) sumIn += raw;
    if (String(r.from).toLowerCase() === q.address.toLowerCase()) sumOut += raw;
  });

  const cached = (v) => q.type === 'USDT' ? v.toString() : unit2dec(v.toString(), 6);
  return {
    address: q.address, type: q.type, total: rows.length,
    totalInVolume: cached(sumIn),
    totalOutVolume: cached(sumOut),
    transactionsList: rows.slice((page - 1) * size, page * size)
  };
}

/* ---------------- MOCK（与前端 mock.js 同构，便于端到端自测） ---------------- */
function hashSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const MOCK = {
  _tron(r) { let s = 'T'; for (let i = 0; i < 33; i++) s += B58[Math.floor(r() * 58)]; return s; },
  balance(p) {
    const r = mulberry32(hashSeed(p.search || ''));
    const trx = (r() * 2000 + 20).toFixed(6);
    const usdt = (r() * 50000 + 100).toFixed(2);
    return { code: 1, data: {
      TRX_TOTAL: trx, USDT_TOTAL: usdt, cny_value: (Number(usdt) * CFG.usdtCny).toFixed(2),
      is_multi: r() > 0.85 ? '是' : '否', EnergyLimit: Math.floor(r() * 200000),
      firstTransactionTime: '2023-04-12 09:31', chain: 'TRON', cny_is_sample: true } };
  },
  txs(p) {
    const r = mulberry32(hashSeed((p.address || '') + p.type + p.page));
    const list = [];
    const n = 20;
    for (let i = 0; i < n; i++) {
      const out = r() > 0.5;
      list.push({
        time: Math.floor(Date.now() / 1000) - i * 3600 - Math.floor(r() * 1800),
        from: out ? p.address : MOCK._tron(r),
        to: out ? MOCK._tron(r) : p.address,
        value: (r() * 3000 + 1).toFixed(2),
        blockHash: Math.floor(r() * 1e15).toString(16).padStart(64, '0'),
        txid: Math.floor(r() * 1e15).toString(16).padStart(64, '0'),
        block_no: 60000000 + Math.floor(r() * 1000000)
      });
    }
    return { code: 1, data: {
      address: p.address, type: p.type, total: 140,
      /* 对齐契约：USDT 用 6 位最小单位，其他给数量 */
      totalInVolume: p.type === 'USDT'
        ? String(Math.round(list.filter(x => x.to === p.address).reduce((s, x) => s + Number(x.value), 0) * 1e6))
        : list.filter(x => x.to === p.address).reduce((s, x) => s + Number(x.value), 0).toFixed(2),
      totalOutVolume: p.type === 'USDT'
        ? String(Math.round(list.filter(x => x.from === p.address).reduce((s, x) => s + Number(x.value), 0) * 1e6))
        : list.filter(x => x.from === p.address).reduce((s, x) => s + Number(x.value), 0).toFixed(2),
      transactionsList: list } };
  },
  block(p) {
    const r = mulberry32(hashSeed(String(p.height)));
    return { code: 1, data: { data: [{
      witnessName: MOCK._tron(r),
      timestamp: Math.floor(Date.now() / 1000) - 300, number: Number(p.height),
      hash: Math.floor(r() * 1e15).toString(16).padStart(64, '0') }] } };
  },
  batch(p) {
    const r = mulberry32(hashSeed(p.address));
    const trx = (r() * 1000).toFixed(6), usdt = (r() * 20000).toFixed(2), usdd = (r() * 500).toFixed(2);
    return { code: 1, data: { address: p.address, trx, trx_dis: trx, usdt, usdt_dis: usdt, usdd, usdd_dis: usdd,
      is_multi: r() > 0.9 ? '是' : '否' } };
  }
};

/* ---------------- 请求体解析（只支持 urlencoded / json，足够本场景） ---------------- */
function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseParams(qs, body, type) {
  const p = Object.fromEntries(new URLSearchParams(qs || ''));
  if (!body) return p;
  if (String(type || '').includes('application/json')) {
    try { Object.assign(p, JSON.parse(body)); } catch { /* 忽略 */ }
  } else {
    Object.assign(p, Object.fromEntries(new URLSearchParams(body)));
  }
  return p;
}

const API = {
  '/api/balance': async (p) => {
    const a = String(p.search || '').trim();
    if (!RE_TRON.test(a) && !RE_ETH.test(a)) throw new Error('BAD_ADDR');
    const acc = RE_TRON.test(a) ? await tronAccount(a) : await ethAccount(a);
    return {
      TRX_TOTAL: acc.trx, USDT_TOTAL: acc.usdt,
      cny_value: (Number(acc.usdt) * CFG.usdtCny).toFixed(2),
      is_multi: acc.is_multi, EnergyLimit: acc.energy,
      firstTransactionTime: RE_TRON.test(a) ? acc.activated ? '已激活' : 0 : 0,
      chain: RE_TRON.test(a) ? 'TRON' : 'Ethereum', cny_is_sample: true
    };
  },
  '/api/txs': async (p) => {
    const a = String(p.address || '').trim();
    if (!RE_TRON.test(a) && !RE_ETH.test(a)) throw new Error('BAD_ADDR');
    const q = {
      address: a, type: String(p.type || 'USDT').toUpperCase(),
      direction: String(p.direction || '全部'),
      minvolume: String(p.minvolume || ''), maxvolume: String(p.maxvolume || ''),
      timestampStart: p.timestampStart ? Number(p.timestampStart) || Date.parse(p.timestampStart) / 1000 : '',
      timestampEnd: p.timestampEnd ? Number(p.timestampEnd) || Date.parse(p.timestampEnd) / 1000 : '',
      page: p.page || 1
    };
    return RE_TRON.test(a) ? tronTxs(q) : ethTxs(q);
  },
  '/api/block': async (p) => tronBlock(p.height),
  '/api/batch': async (p) => {
    const a = String(p.address || p.search || '').trim();
    if (!RE_TRON.test(a)) throw new Error('BAD_ADDR');
    const acc = await tronAccount(a);
    return { address: a, trx: acc.trx, trx_dis: acc.trx_dis, usdt: acc.usdt, usdt_dis: acc.usdt_dis,
      usdd: acc.usdd, usdd_dis: acc.usdd_dis, is_multi: acc.is_multi };
  }
};

/* ---------------- 导出给 Vercel 适配层 ---------------- */
module.exports = { CFG, API, MOCK, rateLimit, RE_TRON, RE_ETH };
//（注：内容由AI生成）
