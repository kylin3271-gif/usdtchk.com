export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let addrs = [];
  if (req.method === 'GET') {
    const q = req.query.addresses || req.query.address || '';
    addrs = q.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
  } else if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    if (Array.isArray(body.addresses)) addrs = body.addresses;
    else if (typeof body.addresses === 'string') addrs = body.addresses.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
    else if (body.address) addrs = [body.address];
  }
  if (!addrs.length) return res.status(400).json({ error: 'need addresses' });
  addrs = [...new Set(addrs)].slice(0, 100);

  const results = [];
  for (const addr of addrs) {
    let trx = 0, usdt = 0, energy = 0, multi = '否';
    try {
      const r = await fetch('https://api.trongrid.io/v1/accounts/' + addr);
      const j = await r.json();
      const d = j.data && j.data[0];
      if (d) {
        trx = (d.balance || 0) / 1e6;
        if (d.trc20) {
          const a = d.trc20.find(x => x['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t']);
          if (a) usdt = parseFloat(a['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'] || 0) / 1e6;
        }
      }
    } catch(e) {}
    try {
      const r = await fetch('https://api.trongrid.io/wallet/getaccount', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ address: addr, visible: true }) });
      const p = await r.json();
      if (p && p.permission) {
        const o = p.permission.owner;
        if ((o && o.keys && o.keys.length > 1) || (p.permission.active && p.permission.active.length > 0)) multi = '是';
      }
    } catch(e) {}
    try {
      const r = await fetch('https://api.trongrid.io/wallet/getaccountresource', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ address: addr, visible: true }) });
      const e = await r.json();
      if (e) energy = Math.max(0, (e.EnergyLimit||0) - (e.EnergyUsed||0));
    } catch(e) {}
    results.push({ address: addr, trx, usdt, multi, energy });
  }
  return res.status(200).json({ count: results.length, results });
}
