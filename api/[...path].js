/**
 * api/[...path].js —— Vercel 函数入口（一个文件接住 /api/balance | txs | block | batch）
 *
 * 与方案B 的 server.js 共用同一套业务逻辑（../lib/core），行为、返回结构完全一致。
 * Vercel 会把 /api/xxx 的 xxx 塞进 req.query.path（字符串或数组），这里还原成 '/api/xxx'。
 */
const { CFG, API, MOCK, rateLimit } = require('../lib/core');

const ERR_MAP = {
  BAD_ADDR: '地址格式不正确',
  DEEP_PAGE: '翻页过深，请缩小筛选范围',
  NO_BLOCK: '区块不存在或尚未同步',
  BODY_TOO_LARGE: '请求体过大',
};

/** 把 Vercel 的 query/path 还原成 '/api/xxx' */
function resolvePath(req) {
  /* 优先从 req.url 取真实路径（Vercel 不同版本对 catch-all 参数注入不一致） */
  const rawUrl = String(req.url || '');
  const pathOnly = rawUrl.split('?')[0];
  if (pathOnly && pathOnly.startsWith('/api/')) return pathOnly.replace(/\/+$/, '');
  const raw = req.query && req.query.path;
  const seg = [].concat(raw || []).filter(Boolean).join('/');
  return '/api/' + seg;
}

/** 合并 query 与 body（Vercel 对 json / urlencoded 会自动解析成对象） */
function collectParams(req) {
  const p = Object.assign({}, req.query || {});
  delete p.path;
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) {
    Object.assign(p, b);
  } else if (typeof b === 'string' && b.length) {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/json')) {
      try { Object.assign(p, JSON.parse(b)); } catch (_) { /* 忽略 */ }
    } else {
      Object.assign(p, Object.fromEntries(new URLSearchParams(b)));
    }
  }
  return p;
}

function getIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (CFG.cors) {
    res.setHeader('Access-Control-Allow-Origin', CFG.cors);
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = resolvePath(req);
  if (!rateLimit(getIp(req))) {
    send(res, 429, { code: 0, msg: '请求太频繁，请稍后再试' });
    return;
  }

  /* 自检：https://你的域名/api/health → 看 mock 是否 true */
  if (pathname === '/api/health') {
    send(res, 200, { code: 1, data: {
      ok: true, mock: CFG.mock, keyConfigured: !!CFG.trongridKey,
      cacheTtl: CFG.cacheTtl, ratePerMin: CFG.ratePerMin, node: process.version
    } });
    return;
  }

  const fn = API[pathname];
  if (!fn) {
    send(res, 404, { code: 0, msg: '接口不存在' });
    return;
  }

  // 只允许 GET/POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    send(res, 405, { code: 0, msg: '请使用 POST' });
    return;
  }

  try {
    const p = collectParams(req);
    // 演示模式：与 server.js 一样，MOCK 里自带 code/data，不再包一层
    if (CFG.mock) {
      send(res, 200, MOCK[pathname.slice(5)](p));
      return;
    }
    const data = await fn(p);
    send(res, 200, { code: 1, data });
  } catch (e) {
    console.error('[api]', pathname, e && e.message);
    send(res, 200, { code: 0, msg: ERR_MAP[e && e.message] || '查询失败，请稍后重试' });
  }
};
