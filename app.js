// TrustEscrow API: one Vercel function. Storage: Upstash Redis (REST). No npm packages needed.
const C=require("crypto"),now=()=>new Date().toISOString();
const DBU=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL,DBT=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
const R=async(...c)=>{const r=await fetch(DBU,{method:"POST",headers:{Authorization:"Bearer "+DBT},body:JSON.stringify(c)}),j=await r.json();if(j.error)throw new Error(j.error);return j.result};
const J=async k=>{const v=await R("GET",k);return v?JSON.parse(v):null},put=(k,v)=>R("SET",k,JSON.stringify(v));
const ADMIN=(process.env.ADMIN_EMAILS||"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean);
const ESC={asset:"USDT",network:"TRON (TRC20)",address:process.env.ESCROW_WALLET||"THu8GLd9TTZugk9ZhBTvwYG8KvfhnJxZVj"};
const NET={"TRON (TRC20)":/^T[1-9A-HJ-NP-Za-km-z]{33}$/,"Ethereum (ERC20)":/^0x[a-fA-F0-9]{40}$/,"BNB Smart Chain (BEP20)":/^0x[a-fA-F0-9]{40}$/,"Polygon":/^0x[a-fA-F0-9]{40}$/,"Solana":/^[1-9A-HJ-NP-Za-km-z]{32,44}$/};
const T={pending:["accepted","rejected","cancelled"],accepted:["awaiting_payment"],awaiting_payment:["processing","cancelled"],processing:["confirmed","failed"],failed:["processing","cancelled"],confirmed:["in_progress"],in_progress:["release_processing","disputed","refunded"],release_processing:["completed","refunded"],disputed:["release_processing","refunded","in_progress"]};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])),E=(c,m)=>Object.assign(new Error(m),{c});
const isAdmin=u=>ADMIN.includes(u.email)&&!!u.proof,hex64=/^[0-9a-fA-F]{64}$/,mailRe=/^\S+@\S+\.\S+$/,dRe=/^\d{4}-\d\d-\d\d$/;
const site=req=>process.env.SITE_URL||"https://"+(req.headers["x-forwarded-host"]||req.headers.host);
const hash=(p,s)=>C.scryptSync(p,s,64).toString("hex");
async function mail(to,subject,html){if(!process.env.RESEND_API_KEY)return false;try{const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+process.env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:process.env.MAIL_FROM||"onboarding@resend.dev",to,subject,html})});return r.ok}catch{return false}}
async function ping(req,to,msg,tx){await Promise.all([R("LPUSH","n:"+to,JSON.stringify({to,msg,at:now(),tx})).then(()=>R("LTRIM","n:"+to,0,49)),mail(to,"TrustEscrow: "+msg.slice(0,70),`<p>${esc(msg)}</p>${tx?`<p><a href="${site(req)}/#/tx/${tx}">Open the transaction</a></p>`:""}`)])}
const pingAdmins=(req,msg,tx)=>Promise.all(ADMIN.map(e=>ping(req,e,msg,tx)));
const audit=(u,a,reason)=>R("LPUSH","audit",JSON.stringify({at:now(),by:u.email,a,reason})).then(()=>R("LTRIM","audit",0,499));
const rl=async(k,max)=>{const n=await R("INCR","rl:"+k);if(n==1)await R("EXPIRE","rl:"+k,60);if(n>max)throw E(429,"Too many attempts. Please wait a minute.")};
async function session(res,email){const t=C.randomBytes(32).toString("hex");await R("SET","s:"+t,email,"EX",604800);res.setHeader("Set-Cookie",`sid=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`)}
const sid=req=>(/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie||"")||[])[1];
async function who(req){const s=sid(req);if(!s)return null;const e=await R("GET","s:"+s);return e?J("u:"+e):null}
const need=async req=>{const u=await who(req);if(!u)throw E(401,"Please log in");return u};
const view=(t,u)=>{const o={...t};if(!isAdmin(u)&&u.email==t.sender&&o.payout)o.payout={...o.payout,d:{...o.payout.d,wallet:"••••"+String(o.payout.d.wallet).slice(-4)}};return o};
async function state(u){const cfg={escrow:ESC,googleClientId:process.env.GOOGLE_CLIENT_ID||""};if(!u)return{me:null,tx:[],notes:[],users:[],audit:[],cfg};
const adm=isAdmin(u),ids=await R("SMEMBERS",adm?"txall":"utx:"+u.email),rows=ids.length?(await R("MGET",...ids.map(i=>"tx:"+i))).filter(Boolean).map(x=>view(JSON.parse(x),u)):[];
const [nr,ns]=await Promise.all([R("GET","nr:"+u.email),R("LRANGE","n:"+u.email,0,49)]),last=+nr||0,notes=(ns||[]).map(x=>{const n=JSON.parse(x);n.read=Date.parse(n.at)<=last;return n});
let users=[],aud=[];if(adm){const em=await R("SMEMBERS","users");users=em.length?(await R("MGET",...em.map(e=>"u:"+e))).filter(Boolean).map(x=>{const v=JSON.parse(x);return{email:v.email,name:v.name,role:isAdmin(v)?"admin":"user"}}):[];aud=(await R("LRANGE","audit",0,99)).map(x=>JSON.parse(x))}
return{me:{email:u.email,name:u.name,role:adm?"admin":"user"},tx:rows,notes,users,audit:aud,cfg}}
async function txAct(req,res,u,b,id,a){const t=await J("tx:"+id),adm=isAdmin(u),r=t&&(u.email==t.sender?"sender":u.email==t.receiver?"receiver":adm?"admin":null);if(!r)throw E(404,"Transaction not found");
const only=(...x)=>{if(!x.includes(r))throw E(403,"You are not allowed to do that")},go=(to,note,by)=>{if(!(T[t.status]||[]).includes(to))throw E(409,"That action is not available right now");t.hist.push({at:now(),to,by:by||u.name,note});t.status=to},
why=()=>{const w=String(b.why||"").trim().slice(0,300);if(w.length<3)throw E(400,"Please add a short reason");return w},hx=x=>{x=String(x||"").trim();if(x&&!hex64.test(x))throw E(400,"Transaction hash should be 64 characters (0-9, a-f)");return x},
amt=`${t.amount} ${t.currency}`;let msg="Done";
switch(a){
case"approve":{only("receiver");const n=String(b.network||""),w=String(b.wallet||"").trim();if(!NET[n]||!NET[n].test(w))throw E(400,"That address is not valid for "+n);if(t.status!="pending")throw E(409,"This request was already handled");
t.payout={m:"crypto",d:{asset:"USDT",network:n,wallet:w}};go("accepted","Seller approved the request and set a payout wallet");go("awaiting_payment","Waiting for the buyer's payment","System");
await ping(req,t.sender,`${t.receiver} approved "${t.title}". Send ${amt} to the escrow wallet and upload your payment screenshot.`,id);msg="Approved. The buyer can now make the payment.";break}
case"decline":only("receiver");go("rejected","Request declined by seller");await ping(req,t.sender,`${t.receiver} declined "${t.title}".`,id);break;
case"cancel":only("sender");go("cancelled","Cancelled by buyer");await ping(req,t.receiver,`"${t.title}" was cancelled by the buyer.`,id);break;
case"pay":{only("sender");const s=String(b.shot||"");if(!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(s)||s.length>1200000)throw E(400,"Please attach a clear screenshot (image, under 1MB)");
t.txid=hx(b.txid);go("processing","Payment proof submitted for verification");await R("SET","shot:"+id,s);t.shot=true;t.note="";
await Promise.all([pingAdmins(req,`Payment proof submitted for "${t.title}" (${amt}). Please verify.`,id),ping(req,t.receiver,`The buyer submitted payment for "${t.title}". You will be told once the funds are held.`,id)]);msg="Payment proof received. We are verifying it.";break}
case"verify":{only("admin");const w=why();if(b.o=="ok"){go("confirmed","Payment verified: "+w);go("in_progress","Funds held in escrow","System");
await Promise.all([ping(req,t.sender,`Your payment for "${t.title}" has been verified. Your funds are being held securely until you choose to release them to the seller. If any problem occurs, you will be refunded.`,id),ping(req,t.receiver,`Funds for "${t.title}" are secured in escrow. You can go ahead with the buyer.`,id)]);await audit(u,`Verified payment ${id}`,w)}
else{go("failed","Payment could not be verified: "+w);t.note=w;await ping(req,t.sender,`We could not verify your payment for "${t.title}": ${w}. Please check and resubmit.`,id);await audit(u,`Rejected payment proof ${id}`,w)}break}
case"release":only("sender");go("release_processing","Buyer confirmed the deal and released the funds");await Promise.all([pingAdmins(req,`Buyer released funds for "${t.title}". Please send the payout.`,id),ping(req,t.receiver,`The buyer released the funds for "${t.title}". Your payout is being processed.`,id)]);msg="Funds released. The seller's payout is being processed.";break;
case"payout":{only("admin");const x=hx(b.txid),w=why();if(!x)throw E(400,"Enter the payout transaction hash");t.payoutTx=x;go("completed","Funds paid out to the seller");await Promise.all([ping(req,t.receiver,`Your payout for "${t.title}" has been sent to your wallet.`,id),ping(req,t.sender,`"${t.title}" is complete. The funds were paid out to the seller.`,id),audit(u,`Payout sent ${id}`,w)]);break}
case"refund":{only("admin");const w=why();t.refundTx=hx(b.txid);go("refunded","Refunded to the buyer: "+w);await Promise.all([ping(req,t.sender,`Your funds for "${t.title}" are being refunded.`,id),ping(req,t.receiver,`"${t.title}" was refunded to the buyer.`,id),audit(u,`Refund ${id}`,w)]);break}
case"dispute":{only("sender","receiver");const x=String(b.text||"").trim().slice(0,2000);if(x.length<5)throw E(400,"Please describe the problem");go("disputed","Dispute raised; release is paused");t.dispute={by:u.email,text:x,ev:String(b.ev||"").slice(0,500),at:now()};
await Promise.all([ping(req,r=="sender"?t.receiver:t.sender,`A dispute was raised on "${t.title}".`,id),pingAdmins(req,`Dispute raised on "${t.title}".`,id)]);break}
case"resolve":{only("admin");const w=why(),o=b.o,to={release:"release_processing",refund:"refunded",continue:"in_progress"}[o];if(!to)throw E(400,"Choose an outcome");go(to,"Admin decision: "+o);t.dispute.res={o,why:w,by:u.email,at:now()};
await Promise.all([ping(req,t.sender,`Dispute on "${t.title}" was decided: ${o}.`,id),ping(req,t.receiver,`Dispute on "${t.title}" was decided: ${o}.`,id),audit(u,`Dispute ${id}: ${o}`,w)]);break}
default:throw E(404,"Unknown action")}
await put("tx:"+id,t);return res.status(200).json({msg})}
module.exports=async(req,res)=>{res.setHeader("Cache-Control","no-store");
try{if(!DBU||!DBT)throw E(503,"Database is not configured");
const p=String((req.query&&req.query.p)||req.url.split("?")[0].replace(/^\/api\//,"")).replace(/^\/+|\/+$/g,""),q=p.split("/"),m=req.method,b=req.body&&typeof req.body=="object"?req.body:{},ip=String(req.headers["x-forwarded-for"]||"x").split(",")[0].trim();
if(m!="GET"&&req.headers["x-requested-with"]!="fetch")throw E(403,"Forbidden");
if(p=="auth/verify"){const t=String((req.query||{}).t||""),e=/^[a-f0-9]+$/.test(t)&&await R("GET","v:"+t),u=e&&await J("u:"+e);if(u){u.verified=u.proof=true;await put("u:"+e,u);await R("DEL","v:"+t)}res.setHeader("Location","/#/login");return res.status(302).end()}
if(p=="state")return res.status(200).json(await state(await who(req)));
if(p=="auth/register"&&m=="POST"){await rl("a"+ip,10);const em=String(b.email||"").trim().toLowerCase(),nm=String(b.name||"").trim().slice(0,80),pw=String(b.password||"");
if(!mailRe.test(em)||!nm||pw.length<8||pw.length>200)throw E(400,"Enter your name, a valid email and a password of 8+ characters");if(await R("EXISTS","u:"+em))throw E(409,"Email already registered");
const salt=C.randomBytes(16).toString("hex"),u={email:em,name:nm,salt,hash:hash(pw,salt),created:now(),verified:false,proof:false},tok=C.randomBytes(24).toString("hex");await R("SET","v:"+tok,em,"EX",86400);
const sent=await mail(em,"Verify your email",`<p>Welcome to TrustEscrow.</p><p><a href="${site(req)}/api/auth/verify?t=${tok}">Verify my email</a></p>`);u.verified=!sent;await put("u:"+em,u);await R("SADD","users",em);
if(sent)return res.status(200).json({verify:true});await session(res,em);return res.status(200).json({ok:true})}
if(p=="auth/login"&&m=="POST"){await rl("a"+ip,10);const u=await J("u:"+String(b.email||"").trim().toLowerCase());
if(!(u&&u.hash&&C.timingSafeEqual(Buffer.from(hash(String(b.password||""),u.salt),"hex"),Buffer.from(u.hash,"hex"))))throw E(401,"Invalid email or password");
if(!u.verified)throw E(403,"Please verify your email first. Check your inbox.");await session(res,u.email);return res.status(200).json({ok:true})}
if(p=="auth/google"&&m=="POST"){const gid=process.env.GOOGLE_CLIENT_ID;if(!gid)throw E(404,"Not available");const j=await(await fetch("https://oauth2.googleapis.com/tokeninfo?id_token="+encodeURIComponent(String(b.credential||"")))).json();
if(j.aud!=gid||j.email_verified!="true")throw E(401,"Google sign-in failed");const em=j.email.toLowerCase();let u=await J("u:"+em);if(!u){u={email:em,name:j.name||em.split("@")[0],created:now(),verified:true,proof:true};await R("SADD","users",em)}else u.verified=u.proof=true;await put("u:"+em,u);await session(res,em);return res.status(200).json({ok:true})}
if(p=="auth/logout"&&m=="POST"){const s=sid(req);if(s)await R("DEL","s:"+s);res.setHeader("Set-Cookie","sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");return res.status(200).json({ok:true})}
const u=await need(req);
if(p=="profile"&&m=="POST"){const nm=String(b.name||"").trim().slice(0,80);if(!nm)throw E(400,"Enter your name");u.name=nm;await put("u:"+u.email,u);return res.status(200).json({ok:true})}
if(p=="notes/read"&&m=="POST"){await R("SET","nr:"+u.email,Date.now());return res.status(200).json({ok:true})}
if(p=="tx"&&m=="POST"){await rl("t"+u.email,20);const rc=String(b.rcv||"").trim().toLowerCase(),a=String(b.amount||""),title=String(b.title||"").trim().slice(0,80),desc=String(b.desc||"").trim().slice(0,2000),cond=String(b.cond||"").trim().slice(0,2000);
if(!mailRe.test(rc)||rc==u.email)throw E(400,"Enter the seller's email (not your own)");if(!/^\d{1,9}(\.\d{1,2})?$/.test(a)||+a<=0)throw E(400,"Enter a valid amount");if(!title||!desc||!cond||!dRe.test(String(b.due||"")))throw E(400,"Please complete all required fields");
const t={id:"TX-"+C.randomBytes(5).toString("hex").toUpperCase(),sender:u.email,receiver:rc,title,desc,cond,amount:+a,currency:"USDT",ref:String(b.ref||"").slice(0,60),due:b.due,expiry:dRe.test(String(b.expiry||""))?b.expiry:"",payout:null,status:"pending",created:now(),hist:[{at:now(),to:"pending",by:u.name,note:"Request sent to seller"}],dispute:null,shot:false};
await put("tx:"+t.id,t);await Promise.all([R("SADD","utx:"+u.email,t.id),R("SADD","utx:"+rc,t.id),R("SADD","txall",t.id)]);await ping(req,rc,`${u.name} sent you a request for "${title}". Log in to approve it.`,t.id);return res.status(200).json({id:t.id})}
if(q[0]=="tx"&&q.length==3&&m=="POST"&&/^TX-[A-F0-9]{10}$/.test(q[1])){await rl("x"+u.email,60);return txAct(req,res,u,b,q[1],q[2])}
if(q[0]=="shot"&&m=="GET"){const t=await J("tx:"+q[1]);if(!t||!(u.email==t.sender||isAdmin(u)))throw E(404,"Not found");const s=await R("GET","shot:"+t.id),x=/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(s||"");if(!x)throw E(404,"Not found");
res.setHeader("Content-Type",x[1]);res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Cache-Control","private, max-age=600");return res.status(200).end(Buffer.from(x[2],"base64"))}
throw E(404,"Not found")}catch(e){if(e.c)return res.status(e.c).json({error:e.message});console.error(e);return res.status(500).json({error:"Server error. Please try again."})}};
