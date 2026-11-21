// POST /api/batch - 4个数据源兜底，TSH8这种小额地址也能查到
const USDT='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDD='TPYmHEhy5n8TCEfYGqW2rPxsghSdvf6c5';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchJSON(url,retries=2){
  for(let i=0;i<retries;i++){
    try{
      const r=await fetch(url,{headers:{'Accept':'application/json'}});
      if(!r.ok) throw new Error('http '+r.status);
      const j=await r.json();
      return j;
    }catch(e){ await sleep(500*(i+1)); if(i===retries-1) throw e; }
  }
}
function parseTrc20(info){
  let usdt=0,usdd=0;
  (info.trc20||[]).forEach(t=>{
    if(t[USDT]) usdt=parseInt(t[USDT])/1e6;
    if(t[USDD]) usdd=parseInt(t[USDD])/1e6;
  });
  return {usdt,usdd};
}
async function queryOne(addr){
  // 1. TronGrid 主力
  try{
    const g=await fetchJSON(`https://api.trongrid.io/v1/accounts/${addr}`);
    const info=g.data?.[0];
    if(info){
      const {usdt,usdd}=parseTrc20(info);
      const p=info.permission||{};
      const isMulti=(p.owner?.keys?.length||0)>1 || (p.active?.[0]?.keys?.length||0)>1;
      return {address:addr,trx:(info.balance||0)/1e6,usdt,usdd,isMulti,activated:!!info.create_time,status:'成功'};
    }
  }catch{}
  await sleep(200);
  // 2. Tronscan accountv2
  try{
    const j=await fetchJSON(`https://apilist.tronscanapi.com/api/accountv2?address=${addr}`);
    const d=j.data?.[0]||j;
    if(d && (d.balance!==undefined || d.tokenBalances)){
      let usdt=0,usdd=0;
      (d.tokenBalances||[]).forEach(t=>{
        const ab=(t.tokenAbbr||'').toUpperCase();
        const v=parseFloat(t.balance||0)/Math.pow(10,t.tokenDecimal??6);
        if(ab==='USDT') usdt=v; if(ab==='USDD') usdd=v;
      });
      return {address:addr,trx:(d.balance||0)/1e6,usdt,usdd,isMulti:false,activated:!!d.createTime,status:'成功'};
    }
  }catch{}
  await sleep(200);
  // 3. Tronscan 旧接口 account - TSH8这个地址就是靠这个兜底
  try{
    const j=await fetchJSON(`https://apilist.tronscanapi.com/api/account?address=${addr}`);
    const d=j.data?.[0]||j;
    if(d && d.balance!==undefined){
      let usdt=0,usdd=0;
      if(d.tokens && typeof d.tokens==='object' && !Array.isArray(d.tokens)){
        if(d.tokens[USDT]) usdt=parseInt(d.tokens[USDT])/1e6;
        if(d.tokens[USDD]) usdd=parseInt(d.tokens[USDD])/1e6;
      }
      if(Array.isArray(d.tokens)){
        d.tokens.forEach(t=>{
          const ab=(t.tokenAbbr||'').toUpperCase();
          const v=parseFloat(t.balance||0)/Math.pow(10,t.tokenDecimal??6);
          if(ab==='USDT') usdt=v; if(ab==='USDD') usdd=v;
        });
      }
      return {address:addr,trx:(d.balance||0)/1e6,usdt,usdd,isMulti:false,activated:!!d.createTime,status:'成功'};
    }
  }catch{}
  await sleep(200);
  // 4. TronGrid TRC20 余额接口 - 最后兜底，只查 USDT
  try{
    const j=await fetchJSON(`https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?limit=1&contract_address=${USDT}&only_confirmed=true`);
    // 只要这个接口通，就说明地址存在，再用 TronGrid 重新拿一次余额
    const g2=await fetchJSON(`https://api.trongrid.io/v1/accounts/${addr}`);
    const info2=g2.data?.[0];
    if(info2){
      const {usdt,usdd}=parseTrc20(info2);
      return {address:addr,trx:(info2.balance||0)/1e6,usdt,usdd,isMulti:false,activated:!!info2.create_time,status:'成功'};
    }
  }catch{}
  return {address:addr,trx:0,usdt:0,usdd:0,isMulti:false,activated:false,status:'失败'};
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method!=='POST') return res.status(405).json({error:'仅支持 POST'});
  let body=req.body; if(typeof body==='string'){try{body=JSON.parse(body)}catch{body={}}}
  const addrs=[...(body.addresses||[])].map(s=>String(s).trim()).filter(Boolean).slice(0,2000);
  if(!addrs.length) return res.status(400).json({error:'缺少地址'});
  const bad=addrs.find(a=>!a.startsWith('T')||a.length!==34);
  if(bad) return res.status(400).json({error:'地址长度不对，必须是34位 T 开头：'+bad});
  const cache=new Map(); const results=[];
  for(const addr of addrs){
    if(cache.has(addr)){ results.push({...cache.get(addr)}); continue; }
    let one=await queryOne(addr);
    // 失败自动再试一次，TSH8这种第一次限流第二次就能成功
    if(one.status==='失败'){
      await sleep(800);
      one=await queryOne(addr);
    }
    cache.set(addr,one); results.push(one);
    await sleep(220);
  }
  return res.json({results});
}
