export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. 取地址列表，GET 和 POST 都支持
  let addrs = [];

  if (req.method === 'GET') {
    const q = req.query.addresses || req.query.address || '';
    addrs = q.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  } else if (req.method === 'POST') {
    const body = typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : (req.body || {});

    if (Array.isArray(body.addresses)) {
      addrs = body.addresses;
    } else if (typeof body.addresses === 'string') {
      addrs = body.addresses.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    } else if (body.address) {
      addrs = [body.address];
    }
  }

  if (!addrs.length) {
    return res.status(400).json({ error: 'need addresses' });
  }

  // 去重，最多 100 个
  addrs = [...new Set(addrs)].slice(0, 100);

  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const TG = 'https://api.trongrid.io';
  const results = [];

  for (const addr of addrs) {
    let trx = 0;
    let usdt = 0;
    let energy = 0;
    let multi = '否';

    try {
      // 2. 查 TRX + 多签
      const r1 = await fetch(TG + '/wallet/getaccount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, visible: true })
      });
      const a = await r1.json();

      if (a && typeof a.balance === 'number') {
        trx = a.balance / 1e6;
      }

      let keys = 0;
      if (a.owner_permission && a.owner_permission.keys) {
        keys += a.owner_permission.keys.length;
      }
      if (Array.isArray(a.active_permission)) {
        a.active_permission.forEach(p => {
          if (p.keys) keys += p.keys.length;
        });
      }
      if (keys > 1) multi = '是';

      // 3. 查能量
      const r2 = await fetch(TG + '/wallet/getaccountresource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, visible: true })
      });
      const e = await r2.json();
      if (e) {
        energy = Math.max(0, (e.EnergyLimit || 0) - (e.EnergyUsed || 0));
      }

      // 4. 查 USDT，用 v1/accounts 的 trc20
      const r3 = await fetch(TG + '/v1/accounts/' + addr);
      const c = await r3.json();
      const d = c && c.data && c.data[0];
      if (d && d.trc20) {
        if (Array.isArray(d.trc20)) {
          d.trc20.forEach(obj => {
            if (obj && obj[USDT] !== undefined) {
              usdt = parseFloat(obj[USDT]) / 1e6;
            }
          });
        } else if (typeof d.trc20 === 'object' && d.trc20[USDT] !== undefined) {
          usdt = parseFloat(d.trc20[USDT]) / 1e6;
        }
      }
    } catch (e) {
      // 单个地址失败不影响其他
    }

    results.push({
      address: addr,
      trx: trx,
      usdt: usdt,
      multi: multi,
      energy: energy
    });
  }

  return res.status(200).json({
    count: results.length,
    results: results
  });
}
