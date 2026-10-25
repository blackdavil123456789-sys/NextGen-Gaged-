const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
});

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlText(text) { return b64url(new TextEncoder().encode(text)); }
function fromB64url(s) { s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; const bin=atob(s); return Uint8Array.from(bin,c=>c.charCodeAt(0)); }
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}
async function makeSession(secret) {
  const payload = b64urlText(JSON.stringify({ exp: Date.now()+86400000 }));
  return payload + '.' + b64url(await hmac(secret, payload));
}
async function validSession(req, secret) {
  const m = (req.headers.get('Cookie')||'').match(/(?:^|;\s*)ngg_session=([^;]+)/);
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return false;
  const expected = b64url(await hmac(secret, payload));
  if (sig.length !== expected.length) return false;
  let diff=0; for(let i=0;i<sig.length;i++) diff |= sig.charCodeAt(i)^expected.charCodeAt(i); if(diff!==0)return false;
  try { return JSON.parse(new TextDecoder().decode(fromB64url(payload))).exp > Date.now(); } catch { return false; }
}
function cookie(value, maxAge=86400) { return `ngg_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`; }

function discount(p){ const old=Number(p.old)||0, price=Number(p.price)||0; return old>0?Math.max(0,Math.round((1-price/old)*100)):0; }
function mapProduct(p){ const q={
  id:String(p.id), name:p.name||'', cat:p.category||'', price:Number(p.offer_price)||0, old:Number(p.regular_price)||0,
  stock:p.stock||'In Stock', caption:p.caption||'', emoji:p.emoji||'📦', image:p.image_url||'', video:p.video_url||''
 }; q.discount=discount(q); return q; }
function mapOrder(o){ return {id:String(o.id), code:o.code, productId:String(o.product_id), product:o.product_name, name:o.customer_name, phone:o.phone, address:o.address, qty:Number(o.quantity)||1, total:Number(o.total)||0, status:o.status||'Pending', date:o.created_at, step:Number(o.step)||0}; }
function mapReview(r){ return {id:String(r.id), name:r.name||'Customer', rating:Number(r.rating)||5, text:r.text||''}; }

async function sb(env, path, opts={}) {
  const base = env.SUPABASE_URL.replace(/\/$/,'');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  const headers = {'apikey':key,'Authorization':`Bearer ${key}`,'Content-Type':'application/json','Prefer':'return=representation',...(opts.headers||{})};
  const r=await fetch(base+'/rest/v1/'+path,{...opts,headers});
  const text=await r.text(); let data; try{data=JSON.parse(text)}catch{data=text}
  if(!r.ok) throw new Error(typeof data==='object'?(data.message||data.hint||data.error||'Supabase request failed'):'Supabase request failed');
  return data;
}
async function readAll(env){
  const [products,orders,reviews]=await Promise.all([
    sb(env,'products?select=*&order=created_at.desc'),
    sb(env,'orders?select=*&order=created_at.desc'),
    sb(env,'reviews?select=*&order=created_at.desc')
  ]);
  return {products:products.map(mapProduct), orders:orders.map(mapOrder), reviews:reviews.map(mapReview)};
}
async function body(req){ try{return await req.json()}catch{return {}} }
function categories(products){return ['All',...new Set(products.map(x=>x.cat).filter(Boolean))]}

export default {
  async fetch(request, env) {
    const u=new URL(request.url); const p=u.pathname;
    try {
      if(p.startsWith('/api/')) {
        if(!env.SUPABASE_URL) return json({error:'Supabase is not configured'},500);

        if(request.method==='GET' && p==='/api/store') {
          const products=(await sb(env,'products?select=*&order=created_at.desc')).map(mapProduct);
          const reviews=(await sb(env,'reviews?select=*&order=created_at.desc')).map(mapReview);
          return json({products,reviews,categories:categories(products)});
        }

        if(request.method==='POST' && p==='/api/orders') {
          const b=await body(request);
          const productRows=await sb(env,`products?id=eq.${encodeURIComponent(b.productId)}&select=*`);
          if(!productRows.length) return json({error:'Product unavailable'},400);
          const product=mapProduct(productRows[0]);
          if(product.stock==='Out of Stock') return json({error:'Product unavailable'},400);
          const qty=Math.max(1,Math.min(99,Number(b.qty)||1));
          const code='NG-'+crypto.randomUUID().replace(/-/g,'').slice(0,6).toUpperCase();
          if(!String(b.name||'').trim()||!String(b.phone||'').trim()||!String(b.address||'').trim()) return json({error:'Name, phone and address are required'},400);
          const rows=await sb(env,'orders',{method:'POST',body:JSON.stringify({code,product_id:product.id,product_name:product.name,customer_name:String(b.name).trim(),phone:String(b.phone).trim(),address:String(b.address).trim(),quantity:qty,total:product.price*qty,status:'Pending',step:0})});
          return json({order:mapOrder(rows[0])},201);
        }

        if(request.method==='GET' && p.startsWith('/api/orders/')) {
          const code=decodeURIComponent(p.split('/').pop()).toUpperCase();
          const rows=await sb(env,`orders?code=eq.${encodeURIComponent(code)}&select=*`);
          return rows.length?json({order:mapOrder(rows[0])}):json({error:'Order not found'},404);
        }

        if(request.method==='POST' && p==='/api/reviews') {
          const b=await body(request); const code=String(b.code||'').toUpperCase();
          const orders=await sb(env,`orders?code=eq.${encodeURIComponent(code)}&select=*`);
          if(!orders.length || orders[0].status!=='Delivered') return json({error:'Review is available after delivery'},400);
          const text=String(b.text||'').trim().slice(0,1000); if(!text)return json({error:'Review text is required'},400);
          const rows=await sb(env,'reviews',{method:'POST',body:JSON.stringify({order_id:orders[0].id,name:String(b.name||'Customer').trim().slice(0,80),rating:Math.max(1,Math.min(5,Number(b.rating)||5)),text})});
          return json({review:mapReview(rows[0])},201);
        }

        if(p==='/api/admin/login' && request.method==='POST') {
          const b=await body(request); if(String(b.password||'')!==String(env.ADMIN_PASSWORD||'')) return json({error:'Wrong password'},401);
          const sid=await makeSession(env.ADMIN_PASSWORD); return json({ok:true},200,{'Set-Cookie':cookie(sid)});
        }
        if(p==='/api/admin/logout' && request.method==='POST') return json({ok:true},200,{'Set-Cookie':cookie('',0)});

        if(p.startsWith('/api/admin/')) {
          if(!(await validSession(request,String(env.ADMIN_PASSWORD||'')))) return json({error:'Unauthorized'},401);
          if(request.method==='GET' && p==='/api/admin/data') {
            const d=await readAll(env); return json({products:d.products,orders:d.orders,reviews:d.reviews});
          }
          if(request.method==='POST' && p==='/api/admin/products') {
            const b=await body(request); const name=String(b.name||'').trim(); if(!name)return json({error:'Product name required'},400);
            const rows=await sb(env,'products',{method:'POST',body:JSON.stringify({name,category:String(b.cat||'General').trim(),caption:String(b.caption||'').trim(),regular_price:Number(b.old)||0,offer_price:Number(b.price)||0,stock:b.stock==='Out of Stock'?'Out of Stock':'In Stock',emoji:String(b.emoji||'📦'),image_url:String(b.image||''),video_url:String(b.video||'')})});
            return json({product:mapProduct(rows[0])},201);
          }
          const pm=p.match(/^\/api\/admin\/products\/([^/]+)$/);
          if(pm){
            const id=decodeURIComponent(pm[1]);
            if(request.method==='DELETE'){await sb(env,`products?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});return json({ok:true});}
            if(request.method==='PUT'){
              const b=await body(request); const patch={};
              if(b.name!==undefined)patch.name=String(b.name); if(b.cat!==undefined)patch.category=String(b.cat); if(b.caption!==undefined)patch.caption=String(b.caption); if(b.image!==undefined)patch.image_url=String(b.image); if(b.video!==undefined)patch.video_url=String(b.video); if(b.emoji!==undefined)patch.emoji=String(b.emoji); if(b.old!==undefined)patch.regular_price=Number(b.old)||0; if(b.price!==undefined)patch.offer_price=Number(b.price)||0; if(b.stock!==undefined)patch.stock=b.stock==='Out of Stock'?'Out of Stock':'In Stock';
              const rows=await sb(env,`products?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(patch)}); return json({product:mapProduct(rows[0])});
            }
          }
          const om=p.match(/^\/api\/admin\/orders\/([^/]+)\/(status|step)$/);
          if(om && request.method==='POST'){
            const id=decodeURIComponent(om[1]); const b=await body(request); const patch={};
            if(om[2]==='status'){patch.status=String(b.status); patch.step={Pending:0,Confirmed:1,'Out for Delivery':2,Delivered:3}[patch.status]??0;} else {patch.step=Math.max(0,Math.min(3,Number(b.step)||0));patch.status=['Pending','Confirmed','Out for Delivery','Delivered'][patch.step];}
            const rows=await sb(env,`orders?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(patch)}); return rows.length?json({order:mapOrder(rows[0])}):json({error:'Order not found'},404);
          }
          const rm=p.match(/^\/api\/admin\/reviews\/([^/]+)$/);
          if(rm && request.method==='DELETE'){await sb(env,`reviews?id=eq.${encodeURIComponent(decodeURIComponent(rm[1]))}`,{method:'DELETE'});return json({ok:true});}
        }
        return json({error:'Not found'},404);
      }
      return env.ASSETS.fetch(request);
    } catch(e) { return json({error:e.message||'Server error'},500); }
  }
};
