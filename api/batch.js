export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let addrs = [];
  if (req.method === 'GET') {
    const q = req.query.addresses || req.query.address || '';
    addrs = q.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  } else if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (Array.isArray(body.addresses)) addrs = body.addresses;
    else if (typeof body.addresses === 'string') addrs = body.addresses.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    else if (body.address) addrs = [body.address];
  }
  if (!addrs.length) return res.status(400).json({ error: 'need addresses' });
  addrs = [...new Set(addrs)].slice(0, 100);

  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const results = [];

  for (const addr of addrs) {
    let trx = 0, usdt = 0, energy = 0, multi = '否';
    try {
      // 用 Tronscan 查 TRX + USDT + 能量 + 多签，一次搞定
      const r = await fetch('https://apilist.tronscanapi.com/api/account?address=' + addr, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const j = await r.json();
      const d = j.data && j.data[0] ? j.data[0] : j;

      if (d) {
        if (typeof d.balance === 'number') trx = d.balance / 1e6;

        // USDT
        const list = d.trc20token_balances || d.trc20TokenBalances || [];
        if (Array.isArray(list)) {
          list.forEach(t => {
            const id = t.tokenId || t.token_id || '';
            const bal = t.balance !== undefined ? t.balance : t.tokenBalance;
            if (id === USDT && bal !== undefined) {
              const dec = t.tokenDecimal !== undefined ? t.tokenDecimal : 6;
              usdt = parseFloat(bal) / Math.pow(10, dec);
            }
          });
        }

        // 能量：account_resource
        const ar = d.account_resource || d.accountResource;
        if (ar) {
          const limit = ar.energy_limit || ar.energyLimit || 0;
          const used = ar.energy_used || ar.energyUsed || 0;
          energy = Math.max(0, limit - used);
        }
        // 有些返回直接是 energy_remaining
        if (!energy && d.energy_remaining !== undefined) energy = d.energy_remaining;

        // 多签
        let keys = 0;
        const op = d.owner_permission || d.ownerPermission;
        if (op && op.keys) keys += op.keys.length;
        const ap = d.active_permission || d.activePermission;
        if (Array.isArray(ap)) ap.forEach(p => { if (p.keys) keys += p.keys.length; });
        if (keys > 1) multi = '是';
      }
    } catch (e) {}
    // 每个地址停 200ms，防限速
    await new Promise(r => setTimeout(r, 200));
    results.push({ address: addr, trx, usdt, multi, energy });
  }
  return res.status(200).json({ count: results.length, results });
}
