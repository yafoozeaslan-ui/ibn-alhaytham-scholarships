var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var SESSION_HOURS = 12;
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmac, "hmac");
async function makeToken(env) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1e3;
  const sig = await hmac(env.ADMIN_PASSWORD, String(exp));
  return `${exp}.${sig}`;
}
__name(makeToken, "makeToken");
async function checkToken(env, cookie) {
  const m = /(?:^|;\s*)s=([^;]+)/.exec(cookie || "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = await hmac(env.ADMIN_PASSWORD, exp);
  return expected === sig;
}
__name(checkToken, "checkToken");
async function getState(env) {
  const s = await env.SCHOLARSHIPS_KV.get("state", "json");
  return s || { items: [], deleted: [], updated_at: null };
}
__name(getState, "getState");
async function putState(env, state) {
  state.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  await env.SCHOLARSHIPS_KV.put("state", JSON.stringify(state));
  return state;
}
__name(putState, "putState");
var json = /* @__PURE__ */ __name((obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra
  }
}), "json");
var ADMIN_PAGE = "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>لوحة التحكم - ابن الهيثم للمنح الدراسية</title>\n<style>\n:root{--primary:#0e7490;--bg:#f8fafc;--card:#fff;--text:#0f172a;--muted:#64748b;--danger:#b91c1c}\n*{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;background:var(--bg);color:var(--text)}\nheader{background:var(--primary);color:#fff;padding:1rem 1.5rem}\nheader h1{margin:0;font-size:1.25rem}\nmain{max-width:960px;margin:0 auto;padding:1.5rem}\n.card{background:var(--card);border:1px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:1rem}\nlabel{display:block;font-size:.85rem;color:var(--muted);margin:.5rem 0 .2rem}\ninput,textarea,select{width:100%;padding:.5rem;border:1px solid #cbd5e1;border-radius:6px;font-family:inherit}\nbutton{cursor:pointer;border:0;border-radius:6px;padding:.55rem 1rem;font-family:inherit;font-size:.95rem}\n.btn-p{background:var(--primary);color:#fff}.btn-d{background:var(--danger);color:#fff}\n.btn-g{background:#e2e8f0;color:var(--text)}\n.row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem}\n.item-title{font-weight:bold;margin-bottom:.2rem}\n.link{color:var(--primary);word-break:break-all;font-size:.85rem}\n.status-open{color:#15803d}.status-upcoming{color:#b45309}.status-unannounced{color:#475569}.status-closed{color:#b91c1c}\n#msg{padding:.6rem;border-radius:6px;margin:1rem 0;display:none}\n#msg.ok{display:block;background:#dcfce7;color:#14532d}#msg.err{display:block;background:#fee2e2;color:#7f1d1d}\n#loginBox{max-width:380px;margin:4rem auto}\ndetails summary{cursor:pointer;color:var(--primary);font-size:.9rem}\nsmall.muted{color:var(--muted)}\n</style></head><body>\n<header><h1>لوحة تحكم موقع ابن الهيثم للمنح الدراسية</h1></header>\n<main>\n<div id=\"loginBox\" class=\"card\">\n<h2>تسجيل الدخول</h2>\n<label>كلمة السر</label><input id=\"pw\" type=\"password\">\n<div class=\"row\"><button class=\"btn-p\" onclick=\"login()\">دخول</button></div>\n<div id=\"msg\"></div>\n</div>\n<div id=\"panel\" style=\"display:none\">\n<div class=\"row\" style=\"justify-content:space-between\">\n<span><button class=\"btn-p\" onclick=\"addItem()\">+ إضافة منحة جديدة</button>\n<button class=\"btn-g\" onclick=\"saveAll()\">حفظ التعديلات</button></span>\n<button class=\"btn-g\" onclick=\"logout()\">خروج</button>\n</div>\n<div id=\"msg2\"></div>\n<div class=\"card\"><small class=\"muted\">\n<span id=\"last-saved\">آخر حفظ: —</span> |\n<span id=\"last-published\">آخر نشر على الموقع: —</span>\n<div id=\"pending\" style=\"color:#b45309;display:none\">توجد تعديلات محفوظة بانتظار النشر. الحفظ لا ينشر فورا: تظهر التعديلات على الموقع مع التحديث المجدول القادم (حتى 6 ساعات)، أو فورا إذا طلبت تشغيل التحديث من المحادثة.</div>\n</small></div>\n<section class=\"card\"><h2>اقتراحات الزوار الخاصة</h2><p>لا تظهر الاقتراحات للزوار ولا تُنشر تلقائيًا. راجع المصدر والأهلية قبل إضافتها.</p><button class=\"btn-g\" onclick=\"loadSuggestions()\">تحديث الاقتراحات</button><div id=\"suggestions\"></div></section><div id=\"items\"></div>\n</div>\n</main>\n<script>\nlet state={items:[],deleted:[]};\nconst $=id=>document.getElementById(id);\nfunction msg(id,t,ok){const e=$(id);e.textContent=t;e.className=ok?'ok':'err';}\nasync function login(){\n  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},\n    body:JSON.stringify({password:$('pw').value})});\n  if(r.ok){showPanel();load();}else msg('msg','كلمة السر غير صحيحة',false);\n}\nasync function logout(){await fetch('/api/logout',{method:'POST'});location.reload();}\nasync function load(){\n  const r=await fetch('/api/data');\n  if(!r.ok){msg('msg2','تعذر تحميل البيانات',false);return;}\n  state=await r.json();render();times(r.headers.get('X-Published-At'));\n}\nfunction esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\"/g,'&quot;');}\nfunction render(){\n  const SL={open:'مفتوحة الآن للتقديم',upcoming:'تفتح قريباً بموعد مؤكد',unannounced:'لم يُعلن موعد الدورة بعد',closed:'انتهى موعدها'};\n  const arr=v=>Array.isArray(v)?v.join('\\n'):(v||'');\n  $('items').innerHTML=state.items.map((it,i)=>`\n  <div class=\"card\">\n   <div class=\"item-title\">${esc(it.title_ar||it.title)}</div>\n   <a class=\"link\" href=\"${esc(it.link)}\" target=\"_blank\">${esc(it.link)}</a>\n   <div class=\"row\"><span class=\"status-${esc(it.status)}\">${SL[it.status]||esc(it.status)}</span>\n   <small class=\"muted\">آخر موعد: ${esc(it.deadline)} | المصدر: ${esc(it.source)}</small></div>\n   <details><summary>تعديل</summary>\n    <label>الاسم العربي</label><input value=\"${esc(it.title_ar||'')}\" onchange=\"setF(${i},'title_ar',this.value)\">\n    <label>الاسم الرسمي الأصلي</label><input value=\"${esc(it.title||'')}\" onchange=\"setF(${i},'title',this.value)\">\n    <label>الجهة / المصدر</label><input value=\"${esc(it.source||'')}\" onchange=\"setF(${i},'source',this.value)\">\n    <label>بلد الدراسة</label><input value=\"${esc(it.study_in_ar||'')}\" onchange=\"setF(${i},'study_in_ar',this.value)\">\n    <label>الحالة</label><select onchange=\"setF(${i},'status',this.value)\">\n     ${['open','upcoming','unannounced','closed'].map(s=>`<option value=\"${s}\"${it.status===s?' selected':''}>${SL[s]}</option>`).join('')}\n    </select>\n    <label>آخر موعد</label><input value=\"${esc(it.deadline||'')}\" onchange=\"setF(${i},'deadline',this.value)\">\n    <label>نبذة قصيرة</label><textarea rows=\"2\" onchange=\"setF(${i},'summary_ar',this.value)\">${esc(it.summary_ar||'')}</textarea>\n    <label>المميزات والتمويل (سطر لكل ميزة)</label><textarea rows=\"3\" onchange=\"setA(${i},'benefits_ar',this.value)\">${esc(arr(it.benefits_ar))}</textarea>\n    <label>الأهلية (سطر لكل شرط)</label><textarea rows=\"3\" onchange=\"setA(${i},'eligibility_ar',this.value)\">${esc(arr(it.eligibility_ar))}</textarea>\n    <label>رابط المصدر الرسمي</label><input value=\"${esc(it.link||'')}\" onchange=\"setF(${i},'link',this.value)\">\n\n    <label>الدرجات الدراسية (سطر لكل درجة: بكالوريوس، ماجستير، دكتوراه)</label><textarea rows=\"2\" onchange=\"setA(${i},'degrees',this.value)\">${esc(arr(it.degrees))}</textarea>\n    <label>نوع التمويل</label><select onchange=\"setFunding(${i},this.value)\">${[['unknown','غير محدد'],['full','تمويل كامل'],['partial','تمويل جزئي مذكور صراحة']].map(([v,l])=>`<option value=\"${v}\"${(it.fully_funded?'full':it.funding_type||'unknown')===v?' selected':''}>${l}</option>`).join('')}</select>\n    <label>تاريخ نهائي منظم للعدّاد (اتركه فارغًا إن لم يُعلن)</label><input type=\"date\" value=\"${esc(it.deadline_iso||'')}\" onchange=\"setF(${i},'deadline_iso',this.value)\">\n    <label>الأوراق المطلوبة من المصدر الرسمي (سطر لكل ورقة)</label><textarea rows=\"3\" onchange=\"setA(${i},'documents_ar',this.value)\">${esc(arr(it.documents_ar))}</textarea>\n    <label>خطوات التقديم الرسمية (سطر لكل خطوة)</label><textarea rows=\"3\" onchange=\"setA(${i},'steps_ar',this.value)\">${esc(arr(it.steps_ar))}</textarea>\n   </details>\n   <div class=\"row\"><button class=\"btn-d\" onclick=\"delItem(${i})\">حذف نهائي (لن يعود بالتحديث التلقائي)</button></div>\n  </div>`).join('');\n}\nfunction setF(i,f,v){state.items[i][f]=v;}\nfunction setA(i,f,v){state.items[i][f]=v.split('\\n').map(s=>s.trim()).filter(Boolean);}\nfunction addItem(){\n  state.items.unshift({title_ar:'',title:'',link:'',source:'',status:'unannounced',deadline:'',\n   study_in_ar:'',summary_ar:'',benefits_ar:[],eligibility_ar:[],details_from:'dashboard'});render();\n}\nfunction delItem(i){\n  const it=state.items[i];\n  if(!confirm('حذف «'+it.title+'» نهائيا؟ لن يعيده التحديث التلقائي.'))return;\n  state.deleted.push(it.link);state.items.splice(i,1);render();\n}\nasync function saveAll(){\n  const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},\n    body:JSON.stringify(state)});\n  if(r.ok){msg('msg2','تم الحفظ. ستظهر التعديلات على الموقع مع التحديث القادم.',true);\n    state.updated_at=new Date().toISOString();times(null);}\n  else msg('msg2','فشل الحفظ: '+r.status,false);\n}\nfunction times(pub){\n  const saved=state.updated_at?new Date(state.updated_at).toLocaleString('ar'):'—';\n  $('last-saved').textContent='آخر حفظ: '+saved;\n  const p=pub||window._pub||null;window._pub=p;\n  $('last-published').textContent='آخر نشر على الموقع: '+(p?new Date(p).toLocaleString('ar'):'—');\n  $('pending').style.display=(state.updated_at&&(!p||new Date(state.updated_at)>new Date(p)))?'block':'none';\n}\n(async()=>{const r=await fetch('/api/data');\n if(r.ok){state=await r.json();showPanel();render();}})();\n\nlet proposals=[];\nfunction setFunding(i,v){state.items[i].funding_type=v;state.items[i].fully_funded=v==='full';}\nasync function loadSuggestions(){const r=await fetch('/api/suggestions');if(!r.ok){$('suggestions').textContent='تعذر تحميل الاقتراحات';return;}proposals=(await r.json()).items;$('suggestions').replaceChildren();if(!proposals.length){$('suggestions').textContent='لا توجد اقتراحات بانتظار المراجعة.';return;}for(const s of proposals){const box=document.createElement('div');box.className='card';const title=document.createElement('strong');title.textContent=s.title;const a=document.createElement('a');a.href=s.link;a.textContent=s.link;a.target='_blank';a.rel='noopener noreferrer';a.className='link';const note=document.createElement('p');note.textContent=s.notes||'';const date=document.createElement('small');date.textContent='وصل: '+new Date(s.created_at).toLocaleString('ar');const row=document.createElement('div');row.className='row';const use=document.createElement('button');use.className='btn-p';use.textContent='نقل إلى نموذج التحرير للمراجعة';use.onclick=()=>{state.items.unshift({title_ar:s.title,title:s.title,link:s.link,source:'اقتراح زائر - يحتاج التحقق',status:'unannounced',deadline:'',degrees:[],study_in_ar:'',summary_ar:'',benefits_ar:[],eligibility_ar:[],documents_ar:[],steps_ar:[],fully_funded:false,details_from:'dashboard',published:new Date().toISOString()});render();$('items').scrollIntoView();msg('msg2','نُقل الاقتراح إلى نموذج التحرير فقط. تحقّق من المصدر والأهلية والبيانات ثم احفظ إن قررت نشره.',true);};const del=document.createElement('button');del.className='btn-d';del.textContent='حذف الاقتراح';del.onclick=async()=>{if(!confirm('حذف هذا الاقتراح من قائمة المراجعة؟'))return;const r=await fetch('/api/suggestions/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:s.id})});if(r.ok)loadSuggestions();else alert('تعذر حذف الاقتراح');};row.append(use,del);box.append(title,document.createElement('br'),a,note,date,row);$('suggestions').append(box);}}\n\nfunction showPanel(){loadSuggestions();$(\"loginBox\").style.display=\"none\";$('panel').style.display='block';}\n</script></body></html>";
var SUGGEST_PAGE = "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>اقترح منحة | ابن الهيثم</title><style>*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;background:#f6f4ef;color:#1c1a16;line-height:1.8;margin:0}main{max-width:600px;margin:35px auto;padding:24px;background:white;border:1px solid #e7e3da;border-radius:16px}h1{color:#0d6b4f;font-size:25px}label{display:block;margin-top:16px;font-weight:bold}input,textarea{font:inherit;width:100%;padding:11px;border:1px solid #ccc;border-radius:8px}button{font:inherit;background:#0d6b4f;color:white;border:0;padding:12px 20px;border-radius:8px;margin-top:18px;cursor:pointer}a{color:#0d6b4f}.note{font-size:14px;color:#6b675f}.trap{display:none}@media(max-width:620px){main{margin:16px;padding:20px}}</style></head><body><main><a href=\"https://yafoozeaslan-ui.github.io/ibn-alhaytham-scholarships/\">→ العودة إلى المنح</a><h1>اقترح منحة للمراجعة</h1><p>تعرف منحة مناسبة للطلاب الفلسطينيين؟ أرسل رابطها الرسمي، وسيراجعها صاحب الموقع قبل أي نشر.</p><p class=\"note\">لا يضمن الإرسال قبول الاقتراح أو موعد مراجعته. لا نحتاج اسمك أو بريدك. لا ترسل وثائق شخصية أو بيانات مالية أو كلمات سر. تُحفظ بيانات المنحة هنا في قائمة مراجعة خاصة، لا في قائمة المنح العامة.</p><form id=\"form\"><label for=\"title\">اسم المنحة</label><input id=\"title\" name=\"title\" maxlength=\"200\" required><label for=\"link\">رابط الإعلان الرسمي</label><input id=\"link\" name=\"link\" type=\"url\" dir=\"ltr\" placeholder=\"https://\" maxlength=\"1500\" required><label for=\"notes\">لماذا تقترحها؟ (اختياري)</label><textarea id=\"notes\" name=\"notes\" maxlength=\"1200\" rows=\"4\" placeholder=\"مثل أهلية الطلاب الفلسطينيين أو الموعد النهائي، دون بيانات شخصية\"></textarea><div class=\"trap\" aria-hidden=\"true\"><input name=\"website\" tabindex=\"-1\" autocomplete=\"off\"></div><button id=\"send\" type=\"submit\">إرسال للمراجعة</button><p id=\"status\" role=\"status\"></p></form></main><script>const form=document.getElementById('form');form.onsubmit=async e=>{e.preventDefault();const status=document.getElementById('status'),b=document.getElementById('send');b.disabled=true;status.textContent='جارٍ الإرسال…';try{const values=Object.fromEntries(new FormData(form));const r=await fetch('/api/suggest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});const d=await r.json();if(!r.ok)throw new Error(d.error||'تعذر الإرسال. حاول لاحقًا.');form.reset();status.textContent='وصل اقتراحك إلى قائمة المراجعة الخاصة. لم يُنشر على الموقع.';}catch(e){status.textContent=e.message;}finally{b.disabled=false;}};</script></body></html>";
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if(path === '/suggest' && request.method === 'GET')return new Response(SUGGEST_PAGE,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    if(path === '/api/suggest' && request.method === 'POST'){
      if(request.headers.get('Origin')!==url.origin)return json({error:'طلب غير مسموح'},403);
      if(Number(request.headers.get('Content-Length')||0)>8000)return json({error:'الطلب أكبر من الحد المسموح'},413);
      const text=await request.text();if(text.length>8000)return json({error:'الطلب أكبر من الحد المسموح'},413);
      let b;try{b=JSON.parse(text);}catch{return json({error:'صيغة غير صحيحة'},400);}
      if(b.website)return json({ok:true});
      const title=String(b.title||'').trim(),link=String(b.link||'').trim(),notes=String(b.notes||'').trim();
      let u;try{u=new URL(link);}catch{return json({error:'أدخل رابط إعلان صحيحًا'},400);}
      if(!title||title.length>200||link.length>1500||notes.length>1200||!['https:','http:'].includes(u.protocol)||u.username||u.password)return json({error:'تحقق من اسم المنحة والرابط وحدود النص'},400);
      const ip=request.headers.get('CF-Connecting-IP')||'unknown',day=new Date().toISOString().slice(0,10);
      const rateKey='suggest-rate:'+await hmac(env.ADMIN_PASSWORD,day+':'+ip);
      const count=Number(await env.SCHOLARSHIPS_KV.get(rateKey)||0);if(count>=3)return json({error:'وصلت إلى الحد اليومي. حاول غدًا.'},429);
      const pending=await env.SCHOLARSHIPS_KV.list({prefix:'proposal:',limit:100});if(pending.keys.length>=100)return json({error:'قائمة المراجعة ممتلئة الآن. حاول لاحقًا.'},503);
      const id=crypto.randomUUID();await env.SCHOLARSHIPS_KV.put('proposal:'+id,JSON.stringify({id,title,link:u.href,notes,created_at:new Date().toISOString()}),{expirationTtl:60*60*24*90});
      await env.SCHOLARSHIPS_KV.put(rateKey,String(count+1),{expirationTtl:60*60*48});return json({ok:true});
    }
    if(path === '/api/suggestions'){
      if(!await checkToken(env,request.headers.get('Cookie')))return json({ok:false},401);
      const list=await env.SCHOLARSHIPS_KV.list({prefix:'proposal:',limit:100});const items=(await Promise.all(list.keys.map(k=>env.SCHOLARSHIPS_KV.get(k.name,'json')))).filter(Boolean).sort((a,b)=>b.created_at.localeCompare(a.created_at));return json({items});
    }
    if(path === '/api/suggestions/delete' && request.method === 'POST'){
      if(!await checkToken(env,request.headers.get('Cookie')))return json({ok:false},401);
      if(request.headers.get('Origin')!==url.origin)return json({ok:false},403);
      const b=await request.json().catch(()=>({}));if(!/^[0-9a-f-]{36}$/.test(b.id||''))return json({ok:false},400);await env.SCHOLARSHIPS_KV.delete('proposal:'+b.id);return json({ok:true});
    }
    if (path === "/scholarships.json") {
      const state = await getState(env);
      return new Response(JSON.stringify(state), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    if (path === "/admin" || path === "/") {
      return new Response(ADMIN_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    if (path === "/api/login" && request.method === "POST") {
      const { password } = await request.json().catch(() => ({}));
      if (!password || password !== env.ADMIN_PASSWORD)
        return json({ ok: false }, 401);
      const token = await makeToken(env);
      return json({ ok: true }, 200, {
        "Set-Cookie": `s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`
      });
    }
    if (path === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, {
        "Set-Cookie": "s=; Path=/; HttpOnly; Secure; Max-Age=0"
      });
    }
    if (path === "/api/data") {
      if (!await checkToken(env, request.headers.get("Cookie")))
        return json({ ok: false }, 401);
      const state = await getState(env);
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      try {
        const page = await (await fetch(
          "https://yafoozeaslan-ui.github.io/ibn-alhaytham-scholarships/"
        )).text();
        const m = page.match(/"updated"\s*:\s*"([^"]+)"/);
        if (m) headers["X-Published-At"] = m[1];
      } catch (e) {
      }
      return new Response(JSON.stringify(state), { headers });
    }
    if (path === "/api/save" && request.method === "POST") {
      if (!await checkToken(env, request.headers.get("Cookie")))
        return json({ ok: false }, 401);
      const body = await request.json().catch(() => null);
      if (!body || !Array.isArray(body.items)) return json({ ok: false }, 400);
      const state = await putState(env, {
        items: body.items.filter((it) => it && (it.title_ar || it.title) && it.link),
        deleted: Array.isArray(body.deleted) ? body.deleted : []
      });
      return json({ ok: true, updated_at: state.updated_at });
    }
    return json({ ok: false, error: "not found" }, 404);
  }
};
export {
  worker_default as default
};
