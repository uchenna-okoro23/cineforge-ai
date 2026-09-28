import express from "express";import {Pool} from "pg";import crypto from "node:crypto";import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
const app=express();app.use(express.json({limit:"20mb"}));const __dirname=path.dirname(fileURLToPath(import.meta.url));const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?.includes("render.com")?{rejectUnauthorized:false}:undefined});
const jobs=new Map();
async function db(){if(!process.env.DATABASE_URL)return;await pool.query(`create table if not exists cineforge_jobs(id text primary key,status text not null,video_url text,error text,created_at timestamptz default now());create table if not exists cineforge_wallets(id bigserial primary key,email text unique not null,balance_kobo bigint not null default 0,created_at timestamptz default now(),updated_at timestamptz default now());create table if not exists cineforge_payments(id bigserial primary key,reference text unique not null,email text not null,amount_kobo bigint not null,status text not null,paystack_transaction_id text,created_at timestamptz default now(),updated_at timestamptz default now())`)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const generatedDir=path.join(__dirname,"generated");
fs.mkdirSync(generatedDir,{recursive:true});
app.use("/generated",express.static(generatedDir,{maxAge:"1h"}));

async function materializeProviderVideo(candidate,space){
  if(typeof candidate!=="string"||!candidate) return null;
  let url=candidate;
  if(candidate.startsWith("/file=")) url=space+candidate;
  else if(candidate.startsWith("/tmp/")||candidate.startsWith("/home/")||candidate.startsWith("/gradio/")) url=space+"/file="+candidate;
  else if(candidate.startsWith("/")) url=space+candidate;
  if(!/^https?:\\/\\//.test(url)) return null;
  const r=await fetch(url,{headers:process.env.HF_TOKEN?{Authorization:"Bearer "+process.env.HF_TOKEN}:{}});
  if(!r.ok) return null;
  const type=String(r.headers.get("content-type")||"").toLowerCase();
  const buf=Buffer.from(await r.arrayBuffer());
  if(buf.length<1024) return null;
  const isMp4=buf.subarray(4,12).toString("ascii").includes("ftyp")||type.includes("video")||type.includes("mp4");
  if(!isMp4) return null;
  const name=crypto.randomUUID()+".mp4";
  await fs.promises.writeFile(path.join(generatedDir,name),buf);
  return (process.env.PUBLIC_URL||"").replace(/\\/$/,"")+"/generated/"+name;
}
app.get("/api/_healthcheck",async(_,res)=>{try{await db();res.json({ok:true,service:"cineforge-ai"})}catch(e){res.status(503).json({ok:false,error:e.message})}});
app.get("/api/provider-status",async(_,res)=>{res.json({provider:process.env.VIDEO_PROVIDER||"hf_ltx_fast",space:process.env.HF_SPACE_URL||"https://lightricks-ltx-video-distilled.hf.space",status:"ready",authentication:process.env.HF_TOKEN?"token":"public-space"})});
async function paystack(path,options={}){if(!process.env.PAYSTACK_TEST_SECRET_KEY)throw new Error("Paystack test secret is not configured.");const r=await fetch("https://api.paystack.co"+path,{...options,headers:{"Authorization":"Bearer "+process.env.PAYSTACK_TEST_SECRET_KEY,"Content-Type":"application/json",...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok||d.status===false)throw new Error(d.message||"Paystack request failed.");return d}
app.get("/api/balance",async(req,res)=>{try{const email=String(req.query.email||"").trim().toLowerCase();if(!email)return res.json({balanceNaira:0});await db();const q=await pool.query("select balance_kobo from cineforge_wallets where email=$1",[email]);res.json({balanceNaira:Number(q.rows[0]?.balance_kobo||0)/100})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/paystack/initialize",async(req,res)=>{try{const email=String(req.body?.email||"").trim().toLowerCase();const amount=Math.round(Number(req.body?.amountNaira||0)*100);if(!email||!email.includes("@"))return res.status(400).json({error:"Valid payment email required."});if(!amount||amount<10000)return res.status(400).json({error:"Minimum test checkout amount is ₦100."});await db();await pool.query("insert into cineforge_wallets(email) values($1) on conflict(email) do nothing",[email]);const data=await paystack("/transaction/initialize",{method:"POST",body:JSON.stringify({email,amount,callback_url:(process.env.PUBLIC_URL||"")+"?payment=paystack"})});await pool.query("insert into cineforge_payments(reference,email,amount_kobo,status) values($1,$2,$3,$4) on conflict(reference) do nothing",[data.data.reference,email,amount,"initialized"]);res.json({ok:true,authorizationUrl:data.data.authorization_url,reference:data.data.reference})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/paystack/verify",async(req,res)=>{try{const reference=String(req.query.reference||"").trim();const email=String(req.query.email||"").trim().toLowerCase();if(!reference)return res.status(400).json({error:"Missing payment reference."});await db();const data=await paystack("/transaction/verify/"+encodeURIComponent(reference));const tx=data.data;const status=tx.status;const amount=Number(tx.amount||0);const txEmail=String(tx.customer?.email||email).toLowerCase();const client=await pool.connect();try{await client.query("begin");const existing=await client.query("select status from cineforge_payments where reference=$1 for update",[reference]);let credited=0;if(status==="success"&&amount>0&&(existing.rows[0]?.status!=="credited")){await client.query("insert into cineforge_wallets(email,balance_kobo) values($1,$2) on conflict(email) do update set balance_kobo=cineforge_wallets.balance_kobo+excluded.balance_kobo,updated_at=now()",[txEmail,amount]);await client.query("update cineforge_payments set status='credited',paystack_transaction_id=$1,updated_at=now() where reference=$2",[String(tx.id||""),reference]);credited=amount}else{await client.query("update cineforge_payments set status=$1,paystack_transaction_id=$2,updated_at=now() where reference=$3",[status,String(tx.id||""),reference])}const bal=await client.query("select balance_kobo from cineforge_wallets where email=$1",[email||txEmail]);await client.query("commit");res.json({ok:status==="success",status,balanceNaira:Number(bal.rows[0]?.balance_kobo||0)/100,creditedNaira:credited/100})}catch(e){await client.query("rollback");throw e}finally{client.release()}}catch(e){res.status(500).json({error:e.message})}});
async function hfGenerate({prompt,image,aspectRatio="16:9",duration=5}){
  const space=process.env.HF_SPACE_URL||"https://lightricks-ltx-video-distilled.hf.space";
  const apiName=image?"image_to_video":"text_to_video";
  let inputImage=null;
  if(image){
    const m=String(image).match(/^data:([^;]+);base64,(.+)$/);
    if(!m)throw new Error("Invalid reference image.");
    const bytes=Buffer.from(m[2],"base64");
    const fd=new FormData();
    fd.append("files",new Blob([bytes],{type:m[1]}),"reference.png");
    const up=await fetch(space+"/gradio_api/upload",{method:"POST",headers:process.env.HF_TOKEN?{Authorization:"Bearer "+process.env.HF_TOKEN}:{},body:fd});
    if(!up.ok)throw new Error("Video provider image upload failed.");
    const u=await up.json();
    inputImage=Array.isArray(u)?{path:u[0],meta:{_type:"gradio.FileData"}}:{path:u.path,meta:{_type:"gradio.FileData"}};
  }
  const dimensions=aspectRatio==="9:16"?[768,432]:aspectRatio==="1:1"?[576,576]:[432,768];
  const safeDuration=Math.max(0.3,Math.min(8.5,Number(duration)||5));
  const data=[prompt,"worst quality, inconsistent motion, blurry, jittery, distorted",inputImage,null,dimensions[0],dimensions[1],apiName==="image_to_video"?"image-to-video":"text-to-video",safeDuration,9,42,true,3,false];
  const call=await fetch(space+"/gradio_api/call/"+apiName,{method:"POST",headers:{"Content-Type":"application/json",...(process.env.HF_TOKEN?{Authorization:"Bearer "+process.env.HF_TOKEN}:{})},body:JSON.stringify({data})});
  if(!call.ok)throw new Error("Video provider rejected the generation request.");
  const c=await call.json();
  const ev=c.event_id;
  if(!ev)throw new Error("Video provider returned no event id.");
  const stream=await fetch(space+"/gradio_api/call/"+apiName+"/"+ev);
  if(!stream.ok)throw new Error("Video provider event stream failed.");
  const text=await stream.text();
  console.log("HF Gradio stream received",text.slice(-3000));
  const lines=text.split("\n").filter(x=>x.startsWith("data:"));
  for(const line of lines.reverse()){
    try{
      const d=JSON.parse(line.slice(5).trim());
      if(!Array.isArray(d)||!d.length)continue;
      const v=d[0];
      const candidates=[v?.url,v?.video?.url,v?.path,v?.video?.path,v];
      for(const candidate of candidates){
        const localUrl=await materializeProviderVideo(candidate,space);
        if(localUrl)return localUrl;
      }
    }catch(e){console.log("HF Gradio data parse skipped",e.message)}
  }
  throw new Error("Video provider finished but CineForge could not download the generated video file.");
};;