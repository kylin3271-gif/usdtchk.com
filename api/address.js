// /api/address?address=T... 或 0x...
const USDT_TRON='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_ETH='0xdac17f958d2ee523a2206206994597c13d831ec7';
function fmt(d){ const p=new Date(d); const q=n=>String(n).padStart(2,'0'); return `${p.getFullYear()}-${q(p.getMonth()+1)}-${q(p.getDate())} ${q(p.getHours())}:${q(p.getMinutes())}:${q(p.getSeconds())}`; }
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const addr=(req.query.address||'').trim();
  if(!addr) return res.status(400).json({error:'缺少地址'});
  try{
    if(addr.startsWith('T')) return res.json(await tron(addr));
    if(addr.startsWith('0x')) return res.json(await eth(addr));
    return res.status(400).json({error:'仅支持波场 T 开头 或 以太坊 0x 开头地址'});
  }catch(e){ return res.status(500).json({error:e.message||'查询失败'}); }
}
async function tron(addr){
  const acc=await fetch(`https://api.trongrid.io/v1/accounts/${addr}`).then(r=>r.json()).catch(()=>({}));
  const info=acc.data?.[0]||{};
  const trx=(info.balance||0)/1e6;
  let usdt=0; (info.trc20||[]).forEach(t=>{ if(t[USDT_TRON]) usdt=parseInt(t[USDT_TRON])/1e6; });
  const perm=info.permission||{};
  const isMulti=(perm.owner?.keys?.length||0)>1 || (perm.active?.[0]?.keys?.length||0)>1;
  const activatedAt=info.create_time?fmt(info.create_time):'';
  let cny='—'; try{
    const p=await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tron,tether&vs_currencies=cny').then(r=>r.json());
    cny=((trx*(p.tron?.cny||0))+(usdt*(p.tether?.cny||0))).toFixed(2);
  }catch{}
  const [u,t]=await Promise.all([
    fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?limit=200&contract_address=${USDT_TRON}&only_confirmed=true`).then(r=>r.json()).catch(()=>({data:[]})),
    fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=200&only_confirmed=true`).then(r=>r.json()).catch(()=>({data:[]})),
  ]);
  const transfers=[];
  (u.data||[]).forEach(x=>{
    if(x.token_info?.symbol!=='USDT' && x.token_info?.address!==USDT_TRON) return;
    const dec=x.token_info?.decimals ?? 6;
    const val=parseInt(x.value||0)/Math.pow(10,dec);
    if(!val || val>1000000000) return;
    transfers.push({time:fmt(x.block_timestamp),counter:x.from===addr?x.to:x.from,coin:'USDT',amount:x.from===addr?-val:val,blockHash:x.block_id||'',txHash:x.transaction_id||'',block:x.block_number||''});
  });
  (t.data||[]).forEach(x=>{
    const c=x.raw_data?.contract?.[0];
    if(!c || c.type!=='TransferContract') return;
    const raw=c.parameter?.value||{};
    const val=(raw.amount||0)/1e6;
    if(!val || val>100000000) return;
    transfers.push({time:fmt(x.block_timestamp),counter:raw.owner_address===addr?raw.to_address:raw.owner_address,coin:'TRX',amount:raw.owner_address===addr?-val:val,blockHash:x.blockId||'',txHash:x.txID||'',block:x.blockNumber||''});
  });
  try{
    const t2=await fetch(`https://apilist.tronscanapi.com/api/transfer?sort=-timestamp&count=200&address=${addr}`).then(r=>r.json()).catch(()=>({data:[]}));
    (t2.data||[]).forEach(x=>{
      const val=(x.amount||0)/1e6; if(!val) return;
      const from=x.transferFromAddress||'',to=x.transferToAddress||'';
      if(transfers.some(y=>y.txHash===x.transactionHash)) return;
      transfers.push({time:fmt(x.timestamp),counter:from===addr?to:from,coin:'TRX',amount:from===addr?-val:val,blockHash:'',txHash:x.transactionHash||'',block:x.block||''});
    });
  }catch{}
  transfers.sort((a,b)=>new Date(b.time)-new Date(a.time));
  return {trx:trx.toFixed(6),usdt:usdt.toFixed(6),energy:`${info.energy_remaining??0} / ${info.energy_limit??0}`,activatedAt,cny,isMulti,transfers:transfers.slice(0,2500)};
}
async function eth(addr){
  const key=process.env.ETHERSCAN_KEY||'';
  const base=`https://api.etherscan.io/api?apikey=${key}&address=${addr}`;
  const [bal,tok,txs]=await Promise.all([
    fetch(`${base}&module=account&action=balance&tag=latest`).then(r=>r.json()).catch(()=>({})),
    fetch(`${base}&module=account&action=tokentx&contractaddress=${USDT_ETH}&page=1&offset=200&sort=desc`).then(r=>r.json()).catch(()=>({result:[]})),
    fetch(`${base}&module=account&action=txlist&page=1&offset=200&sort=desc`).then(r=>r.json()).catch(()=>({result:[]})),
  ]);
  const safe=v=>Array.isArray(v)?v:[];
  const tokList=safe(tok.result), txList=safe(txs.result);
  let ethBal=parseInt(bal.result||'0')/1e18; if(isNaN(ethBal)) ethBal=0;
  let usdt=0; tokList.forEach(x=>{ if(x.contractAddress?.toLowerCase()===USDT_ETH) usdt+=parseInt(x.value||0)/1e6; });
  const transfers=[];
  tokList.forEach(x=>{
    const val=parseInt(x.value||0)/1e6;
    transfers.push({time:fmt(parseInt(x.timeStamp)*1000),counter:x.from?.toLowerCase()===addr.toLowerCase()?x.to:x.from,coin:'USDT',amount:x.from?.toLowerCase()===addr.toLowerCase()?-val:val,blockHash:x.blockHash||'',txHash:x.hash||'',block:x.blockNumber||''});
  });
  txList.forEach(x=>{
    const val=parseInt(x.value||0)/1e18; if(!val) return;
    transfers.push({time:fmt(parseInt(x.timeStamp)*1000),counter:x.from?.toLowerCase()===addr.toLowerCase()?x.to:x.from,coin:'TRX',amount:x.from?.toLowerCase()===addr.toLowerCase()?-val:val,blockHash:x.blockHash||'',txHash:x.hash||'',block:x.blockNumber||''});
  });
  transfers.sort((a,b)=>new Date(b.time)-new Date(a.time));
  return {trx:ethBal.toFixed(6),usdt:usdt.toFixed(6),energy:'—',activatedAt:transfers.length?transfers[transfers.length-1].time:'—',cny:'—',isMulti:false,transfers:transfers.slice(0,2500),note:'ETH'};
}
