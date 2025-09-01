/**
 * Vercel single-file API — JSON + SSE in one route
 *
 * Route: /api/sys-last8
 * - JSON (default): returns [{ block, time, pool, logo }]
 * - SSE push: add ?stream=1 (keeps connection open, sends snapshot then update on new block)
 *
 * Notes:
 * - Edge runtime (no Express). Copy this file to api/sys-last8.js in your repo.
 * - CORS enabled. JSON is cached by CDN ~15s unless you pass ?noCache=1.
 */

export const config = { runtime: "edge" };

// ---- Config ----
const ESPLORA_BASES = [
  "https://mempool.space/api",
  "https://blockstream.info/api"
];
const MEMPOOL_API = "https://mempool.space/api";
const POOLS_JSON_URL = "https://raw.githubusercontent.com/mempool/mining-pools/master/pools-v2.json";
const POOL_LOGO_BASE = "https://raw.githubusercontent.com/mempool/mining-pool-logos/master";

const MATCH_ASCII = "sys";
const MATCH_HEX = asciiToHex(MATCH_ASCII);

// ---- Small helpers ----
function asciiToHex(str){ let s=""; for(let i=0;i<str.length;i++) s+=str.charCodeAt(i).toString(16).padStart(2,"0"); return s; }
function hexToAscii(hex){ try{ const c=String(hex||"").replace(/[^0-9a-f]/gi,""); let o=""; for(let i=0;i<c.length;i+=2){ const b=parseInt(c.substring(i,i+2),16); if(Number.isNaN(b)) continue; o+= (b>=32&&b<=126)?String.fromCharCode(b):"."; } return o; }catch(e){ return ""; } }
const hexIncludes=(t,n)=>String(t||"").toLowerCase().includes(String(n||"").toLowerCase());
function readLE(hex,off,bytes){ let v=0; for(let i=0;i<bytes;i++) v|=parseInt(hex.substr(off+i*2,2),16)<<(8*i); return v>>>0; }
function extractOpReturnFromHexScript(scriptHex){ if(!scriptHex) return null; const h=scriptHex.toLowerCase().replace(/[^0-9a-f]/g,""); let i=0; const readByte=()=>{ const b=parseInt(h.substr(i,2),16); i+=2; return b; }; while(i<h.length){ const op=readByte(); if(op===106){ let out=""; while(i<h.length){ const b=parseInt(h.substr(i,2),16); if(Number.isNaN(b)) break; if(b>=1&&b<=75){ i+=2; const len=b; out+=h.substr(i,len*2); i+=len*2; continue; } if(b===76){ i+=2; const len1=parseInt(h.substr(i,2),16); i+=2; out+=h.substr(i,len1*2); i+=len1*2; continue; } if(b===77){ i+=2; const len2=readLE(h,i,2); i+=4; out+=h.substr(i,len2*2); i+=len2*2; continue; } if(b===78){ i+=2; const len4=readLE(h,i,4); i+=8; out+=h.substr(i,len4*2); i+=len4*2; continue; } break; } return out||null; } } return null; }
function extractOpReturnHex(voutAsm,voutHex){ if(voutAsm&&voutAsm.indexOf("OP_RETURN")===0){ const parts=voutAsm.trim().split(" ").filter(Boolean); const hexParts=parts.slice(1).filter(p=>/^[0-9a-fA-F]+$/.test(p)); if(hexParts.length) return hexParts.join("").toLowerCase(); } if(voutHex) return extractOpReturnFromHexScript(voutHex); return null; }

// ---- Pools metadata & detection ----
let POOLS=null; // { coinbaseTags: [{pattern,name,link,slug}], payoutAddresses: Map, slugsByName: Map }
async function loadPools(){ try{ const r=await fetch(POOLS_JSON_URL,{cache:"no-store"}); const json=await r.json(); const coinbaseTags=[]; const payoutAddresses=new Map(); const slugsByName=new Map(); if(json.coinbase_tags) for(const [pattern,v] of Object.entries(json.coinbase_tags)) coinbaseTags.push({pattern,name:v.name,link:v.link}); if(json.payout_addresses) for(const [addr,v] of Object.entries(json.payout_addresses)) payoutAddresses.set(addr,{name:v.name,link:v.link}); if(json.slugs) for(const [name,slug] of Object.entries(json.slugs)) slugsByName.set(name,slug); if(Array.isArray(json.pools)){ for(const p of json.pools){ if(!p||!p.name) continue; const slug=slugsByName.get(p.name); if(Array.isArray(p.addresses)) for(const addr of p.addresses){ if(!payoutAddresses.has(addr)) payoutAddresses.set(addr,{name:p.name,link:p.link,slug}); } } } for(const e of coinbaseTags) e.slug=slugsByName.get(e.name); payoutAddresses.forEach((meta,addr)=>{ if(!meta.slug&&meta.name){ const s=slugsByName.get(meta.name); payoutAddresses.set(addr,{...meta,slug:s}); } }); POOLS={coinbaseTags,payoutAddresses,slugsByName}; }catch{ POOLS={coinbaseTags:[],payoutAddresses:new Map(),slugsByName:new Map()}; } }
const FALLBACK_TAGS=[
  {re:/(secpool|sec *pool)/i,name:"SECPOOL",slug:"secpool",link:"https://www.secpool.com"},
  {re:/(spider ?pool|spiderpool)/i,name:"SpiderPool",slug:"spiderpool",link:"https://www.spiderpool.com"},
  {re:/(binance( *pool)?|bnbpool)/i,name:"Binance Pool",slug:"binancepool",link:"https://pool.binance.com"},
  {re:/(mining *squared|miningsquared|bsquared)/i,name:"Mining Squared",slug:"miningsquared",link:"https://miningsquared.com"},
  {re:/(foundry|foundryusa)/i,name:"Foundry USA",slug:"foundryusa",link:"https://foundrydigital.com"},
  {re:/(antpool)/i,name:"AntPool",slug:"antpool",link:"https://www.antpool.com"},
  {re:/(f2pool)/i,name:"F2Pool",slug:"f2pool",link:"https://www.f2pool.com"},
  {re:/(viabtc)/i,name:"ViaBTC",slug:"viabtc",link:"https://www.viabtc.com"},
  {re:/(btc[.]com|btccom)/i,name:"BTC.com",slug:"btccom",link:"https://pool.btc.com"},
  {re:/(luxor)/i,name:"Luxor",slug:"luxor",link:"https://mining.luxor.tech"},
  {re:/(sbi.*crypto)/i,name:"SBI Crypto",slug:"sbicrypto",link:"https://www.sbicrypto.com"},
  {re:/(mara|marapool)/i,name:"MARA Pool",slug:"marapool",link:"https://www.mara.xyz"}
];
function matchFallbackTag(ascii){ for(const t of FALLBACK_TAGS){ if(t.re.test(ascii)) return {name:t.name,slug:t.slug,link:t.link}; } }
function detectPoolFromTags(ascii){ if(POOLS){ for(const entry of POOLS.coinbaseTags){ try{ const re=new RegExp(entry.pattern,"i"); if(re.test(ascii)) return {name:entry.name,link:entry.link,slug:entry.slug}; }catch{ if(ascii.toLowerCase().includes(String(entry.pattern).toLowerCase())) return {name:entry.name,link:entry.link,slug:entry.slug}; } } } return matchFallbackTag(ascii); }
function detectPoolFromPayouts(coinbaseTx){ if(!POOLS||!coinbaseTx||!Array.isArray(coinbaseTx.vout)) return undefined; for(const o of coinbaseTx.vout){ const addr=o&&o.scriptpubkey_address; if(addr&&POOLS.payoutAddresses.has(addr)) return POOLS.payoutAddresses.get(addr); } }
async function getBlockExtras(blockHash){ try{ const r=await fetch(`${MEMPOOL_API}/block/${blockHash}`,{cache:"no-store"}); const b=await r.json(); if(b&&b.extras&&b.extras.pool) return {name:b.extras.pool.name,link:b.extras.pool.link,slug:b.extras.pool.slug}; }catch{} try{ const r2=await fetch(`${ESPLORA.base}/block/${blockHash}`,{cache:"no-store"}); const b2=await r2.json(); if(b2&&b2.extras&&b2.extras.pool) return {name:b2.extras.pool.name,link:b2.extras.pool.link,slug:b2.extras.pool.slug}; }catch{} return null; }
const poolLogoUrl=slug=> slug?`${POOL_LOGO_BASE}/${slug}.svg`:`${POOL_LOGO_BASE}/default.svg`;

// ---- Esplora selection ----
const ESPLORA={ base:null };
async function pickEsploraBase(){ if(ESPLORA.base) return ESPLORA.base; for(const base of ESPLORA_BASES){ try{ const r=await fetch(`${base}/blocks`,{cache:"no-store"}); if(r.ok){ ESPLORA.base=base; return base; } }catch{} } throw new Error("No Esplora API reachable"); }
const api=path=>{ if(!ESPLORA.base) throw new Error("Esplora base not set"); return `${ESPLORA.base}${path}`; };

// ---- Block helpers ----
async function fetchJSON(url){ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(String(r.status)); return r.json(); }
async function fetchTEXT(url){ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(String(r.status)); return r.text(); }
const fetchBlocksPage=()=>fetchJSON(api("/blocks"));
const fetchBlocksPageFrom=h=>fetchJSON(api(`/blocks/${h}`));
async function getCoinbaseTx(blockHash){ const page=await fetchJSON(api(`/block/${blockHash}/txs/0`)); return (page&&page[0])||null; }

function extractFirstMatchingFromTx(tx){ if(!tx||!Array.isArray(tx.vout)) return null; for(const v of tx.vout){ if(v && (v.scriptpubkey_type==="op_return" || (v.scriptpubkey_asm && v.scriptpubkey_asm.indexOf("OP_RETURN")===0))){ const dataHex=extractOpReturnHex(v.scriptpubkey_asm,v.scriptpubkey); if(dataHex && hexIncludes(dataHex,MATCH_HEX)) return { where:"OP_RETURN", dataHex }; } } return null; }

async function findMatchInBlock(block){ let extras=null, coinbase=null; try{ extras=await getBlockExtras(block.id); }catch{} try{ coinbase=await getCoinbaseTx(block.id); }catch{} if(coinbase){ const cbMatch=extractFirstMatchingFromTx(coinbase); if(cbMatch) return { pool:detectPool(coinbase,extras), matchedWhere:cbMatch.where }; const ssHex=(coinbase.vin && coinbase.vin[0] && coinbase.vin[0].scriptsig)||""; if(ssHex && hexIncludes(ssHex,MATCH_HEX)) return { pool:detectPool(coinbase,extras), matchedWhere:"scriptSig" }; } let page=0; while(true){ let txs=null; try{ txs=await fetchJSON(api(`/block/${block.id}/txs/${page}`)); }catch{ break; } if(!txs||!txs.length) break; for(const tx of txs){ const match=extractFirstMatchingFromTx(tx); if(match) return { pool:detectPool(coinbase,extras), matchedWhere:match.where }; } page++; if(page>80) break; } return null; }

function detectPool(coinbaseTx,extras){ if(extras&&(extras.name||extras.slug)){ if(!extras.slug&&POOLS&&POOLS.slugsByName&&extras.name){ const s=POOLS.slugsByName.get(extras.name); if(s) extras.slug=s; } return extras; } const ssHex=(coinbaseTx&&coinbaseTx.vin&&coinbaseTx.vin[0]&&coinbaseTx.vin[0].scriptsig)||""; const ascii=hexToAscii(ssHex||""); const byTag=detectPoolFromTags(ascii); if(byTag) return byTag; const byAddr=detectPoolFromPayouts(coinbaseTx); if(byAddr) return byAddr; return { name:"Unknown", slug:null }; }

async function computeLast8(){ await pickEsploraBase(); if(!POOLS) await loadPools(); const out=[]; let page=await fetchBlocksPage(); if(!page||!page.length) throw new Error("No blocks returned"); let nextHeight=page[page.length-1].height-1; outer: while(out.length<8){ for(const b of page){ const match=await findMatchInBlock(b); if(match){ out.push({ block:b.height, time:new Date(b.timestamp*1000).toISOString(), pool:match.pool&&match.pool.name?match.pool.name:"Unknown", logo:poolLogoUrl(match.pool&&match.pool.slug) }); if(out.length>=8) break outer; } } try{ page=await fetchBlocksPageFrom(nextHeight); nextHeight = page.length ? page[page.length-1].height-1 : nextHeight-10; if(!page.length) break; }catch{ break; } } out.sort((a,b)=>b.block-a.block); return out; }

// ---- Main handler (JSON + SSE in one) ----
export default async function handler(req){
  const url=new URL(req.url);
  const wantsStream = url.searchParams.get("stream")==="1" || String(req.headers.get("accept")||"").includes("text/event-stream");
  const noCache = url.searchParams.get("noCache")==="1";

  if(!wantsStream){
    try{
      const data=await computeLast8();
      const headers={
        "content-type":"application/json; charset=utf-8",
        "access-control-allow-origin":"*",
        "cache-control": noCache? "no-store" : "s-maxage=15, stale-while-revalidate=30"
      };
      return new Response(JSON.stringify(data),{ headers });
    }catch(e){
      return new Response(JSON.stringify({ error:String(e&&e.message?e.message:e) }),{ status:500, headers:{ "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*", "cache-control":"no-store" } });
    }
  }

  // SSE stream
  const encoder=new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller){
      const send=(event,data)=>{ controller.enqueue(encoder.encode(`event: ${event}\n`)); controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); };
      const comment=(text)=>controller.enqueue(encoder.encode(`: ${text}\n\n`));

      let lastTop=0;
      try{ const snap=await computeLast8(); lastTop = snap[0]?.block || 0; send("snapshot", snap); }catch(e){ send("error", { message:String(e&&e.message?e.message:e) }); }

      const pingId=setInterval(()=>comment("ping"), 20000);
      const pollId=setInterval(async ()=>{
        try{
          await pickEsploraBase();
          const tipHash=(await fetchTEXT(api("/blocks/tip/hash"))).trim();
          if(!tipHash) return;
          const tip=await fetchJSON(api(`/block/${tipHash}`));
          if(tip&&tip.height&&tip.height>lastTop){ const upd=await computeLast8(); lastTop = upd[0]?.block || lastTop; send("update", upd); }
        }catch{}
      }, 5000);

      const abort=()=>{ clearInterval(pingId); clearInterval(pollId); try{ controller.close(); }catch{} };
      try{ req.signal?.addEventListener("abort", abort); }catch{}
    }
  }),{
    headers:{
      "content-type":"text/event-stream; charset=utf-8",
      "cache-control":"no-store, no-transform",
      "connection":"keep-alive",
      "access-control-allow-origin":"*"
    }
  });
}
