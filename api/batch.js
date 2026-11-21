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

  const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const results = [];
  for (const addr of addrs) {
    let trx = 0, usdt = 0, energy = 0, multi = '否';
    try {
      const r = await fetch('https://apilist.tronscanapi.com/api/accountv2?address=' + addr, { headers: { 'accept': 'application/json' } });
      const j = await r.json();
      // Tronscan 返回 balance 是 SUN，trc20token_balances 里是 USDT
      if (j) {
        if (typeof j.balance === 'number') trx = j.balance / 1e6;
        const list = j.trc20token_balances || j.trc20TokenBalances || [];
        if (Array.isArray(list)) {
          const u = list.find(x => x.tokenId === USDT_CONTRACT || x.token_id === USDT_CONTRACT || x.contract_address === USDT_CONTRACT);
          if (u) usdt = parseFloat(u.balance || 0) / Math.pow(10, u.tokenDecimal || u.decimals || 6);
        }
        // 多签判断：owner_permission / active_permission 里有多个 key
        const perms = [...(j.owner_permission ? [j.owner_permission] : []), ...(j.active_permissions || j.activePermissions || [])];
        let keyCount = 0;
        perms.forEach(p => { if (p && p.keys) keyCount += p.keys.length; });
        // Tronscan 还有 account 的 permission 字段
        if (j.permission) {
          if (j.permission.owner && j.permission.owner.keys) keyCount = Math.max(keyCount, j.permission.owner.keys.length);
        }
        if (keyCount > 1) multi = '是';
        if (j.account_resource) {
          const er = j.account_resource.energy_used || 0;
          const el = j.account_resource.energy_limit || 0;
          energy = Math.max(0, el - er);
        }
        // 备用：bandwidth 里也可能有 energy
        if (!energy && j.bandwidth) {
          const er = j.bandwidth.energyUsed || 0;
          const el = j.bandwidth.energyLimit || 0;
          if (el) energy = Math.max(0, el - er);
        }
      }
    } catch(e) {}
    // 如果 Tronscan 没拿到能量，再用 TronGrid 补一次能量
    if (!energy) {
      try {
        const r = await fetch('https://api.trongrid.io/wallet/getaccountresource', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ address: addr, visible: true }) });
        const e = await r.json();
        if (e) energy = Math.max(0, (e.EnergyLimit||0) - (e.EnergyUsed||0));
      } catch(e) {}
    }
    results.push({ address: addr, trx, usdt, multi, energy });
  }
  return res.status(200).json({ count: results.length, results });
}
