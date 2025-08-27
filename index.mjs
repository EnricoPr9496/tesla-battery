import fs from "fs/promises";
import path from "path";
import os from "os";
import axios from "axios";
import open from "open";
import readline from "readline";
import dotenv from "dotenv";
dotenv.config();

/* ===== Config (.env) =====
TESLA_CLIENT_ID=...
TESLA_CLIENT_SECRET=
TESLA_REGION=eu
TESLA_REDIRECT_URI=https://enricopr9496.github.io
TESLA_VEHICLE_TAG=IL_TUO_VIN_O_ID
EXTRA_SCOPES=vehicle_cmds
WAKE_POLICY=onfail
QUIET_WINDOW=00:00-07:30
MAX_WAKE_PER_DAY=16
LOG_FILE=./tesla_soc.jsonl
DAILY_WAKE_FILE=./wake_counter.json
AUTO_PARTNER_REGISTER=true
TESLA_PARTNER_DOMAIN=enricopr9496.github.io
TESLA_PARTNER_CLIENT_ID=
TESLA_PARTNER_CLIENT_SECRET=
========================================== */

const {
  TESLA_CLIENT_ID,
  TESLA_CLIENT_SECRET = "",
  TESLA_REDIRECT_URI,
  TESLA_VEHICLE_TAG,
  EXTRA_SCOPES = "",
  WAKE_POLICY = "onfail",
  QUIET_WINDOW = "00:00-07:30",
  MAX_WAKE_PER_DAY = "16",
  LOG_FILE = "./tesla_soc.jsonl",
  DAILY_WAKE_FILE = "./wake_counter.json",
  TOKENS_PATH: TOKENS_PATH_ENV,
  STATE_PATH: STATE_PATH_ENV,
  AUTO_PARTNER_REGISTER = "false",
  TESLA_PARTNER_DOMAIN = "",
  TESLA_PARTNER_CLIENT_ID = "",
  TESLA_PARTNER_CLIENT_SECRET = "",
} = process.env;

if (!TESLA_CLIENT_ID) exitErr("TESLA_CLIENT_ID mancante in .env");
if (!TESLA_REDIRECT_URI) exitErr("TESLA_REDIRECT_URI mancante in .env");
if (!TESLA_VEHICLE_TAG) exitErr("TESLA_VEHICLE_TAG mancante in .env");
if (AUTO_PARTNER_REGISTER === "true" && !TESLA_PARTNER_DOMAIN) {
  exitErr("AUTO_PARTNER_REGISTER=true ma TESLA_PARTNER_DOMAIN è vuoto");
}

// EU fisso
const API_BASE = "https://fleet-api.prd.eu.vn.cloud.tesla.com";
const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const AUTHZ_BASE = "https://auth.tesla.com/oauth2/v3/authorize";
axios.defaults.timeout = 20000;

const baseScopes = ["openid", "offline_access", "vehicle_device_data"];
const scopes = baseScopes.concat(
  EXTRA_SCOPES.split(/\s+/).map(s=>s.trim()).filter(Boolean)
);

// file locali
const TOKENS_PATH = TOKENS_PATH_ENV || path.join(os.homedir(), ".tesla_fleet_tokens.json");
const STATE_PATH  = STATE_PATH_ENV  || path.join(os.homedir(), ".tesla_fleet_state.json");

/* ===== Utils ===== */
function exitErr(msg){ console.error("Errore:", msg); process.exit(2); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function pad(n){ return String(n).padStart(2,"0"); }
function localDateStr(d=new Date()){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
async function safeAppend(file, line){ try{ await fs.appendFile(file, line+"\n","utf-8"); }catch{} }
async function loadJSON(file, fallback){ try{ return JSON.parse(await fs.readFile(file,"utf-8")); }catch{ return fallback; } }
async function saveJSON(file, obj){ await fs.writeFile(file, JSON.stringify(obj,null,2), "utf-8"); }

/* ===== Quiet window ===== */
function parseTimeToMins(hhmm){
  const m = /^(\d{1,2}):?(\d{2})$/.exec(hhmm);
  if(!m) return null;
  const h=Number(m[1]), mn=Number(m[2]);
  return h*60+mn;
}
function inQuietWindow(now=new Date(), spec=QUIET_WINDOW){
  if(!spec) return false;
  const m = /^(\d{1,2}:?\d{2})-(\d{1,2}:?\d{2})$/.exec(spec.trim());
  if(!m) return false;
  const start=parseTimeToMins(m[1]), end=parseTimeToMins(m[2]);
  if(start==null || end==null) return false;
  const mins = now.getHours()*60+now.getMinutes();
  return (start<=end) ? (mins>=start && mins<end) : (mins>=start || mins<end);
}

/* ===== OAuth (utente) ===== */
function buildAuthorizeUrl(state){
  const qs = new URLSearchParams({
    response_type:"code",
    client_id:TESLA_CLIENT_ID,
    redirect_uri:TESLA_REDIRECT_URI,
    scope:scopes.join(" "),
    state,
  });
  return `${AUTHZ_BASE}?${qs.toString()}`;
}
async function prompt(q){
  const rl = readline.createInterface({ input:process.stdin, output:process.stdout });
  return new Promise(res=> rl.question(q, ans=>{ rl.close(); res(ans); }));
}
function parseCodeFromUrl(full){
  try{
    const u=new URL(full.trim());
    const code=u.searchParams.get("code");
    if(!code) throw new Error("Parametro 'code' assente");
    return code;
  }catch{ throw new Error("URL di redirect non valido"); }
}
async function exchangeCode(code){
  const form=new URLSearchParams();
  form.append("grant_type","authorization_code");
  form.append("client_id",TESLA_CLIENT_ID);
  if(TESLA_CLIENT_SECRET) form.append("client_secret",TESLA_CLIENT_SECRET);
  form.append("code",code);
  form.append("redirect_uri",TESLA_REDIRECT_URI);
  form.append("audience",API_BASE);
  const {data}=await axios.post(TOKEN_URL, form, {headers:{"Content-Type":"application/x-www-form-urlencoded"}});
  return data;
}
async function refreshTokens(refreshToken){
  const form=new URLSearchParams();
  form.append("grant_type","refresh_token");
  form.append("client_id",TESLA_CLIENT_ID);
  if(TESLA_CLIENT_SECRET) form.append("client_secret",TESLA_CLIENT_SECRET);
  form.append("refresh_token",refreshToken);
  form.append("audience",API_BASE);
  const {data}=await axios.post(TOKEN_URL, form, {headers:{"Content-Type":"application/x-www-form-urlencoded"}});
  return data;
}

/* ===== Fleet API ===== */
async function getVehicleData(accessToken, tag){
  const url = `${API_BASE}/api/1/vehicles/${encodeURIComponent(tag)}/vehicle_data`;
  const {data}=await axios.get(url, {headers:{Authorization:`Bearer ${accessToken}`}});
  return data;
}
async function wakeVehicle(accessToken, tag){
  const url = `${API_BASE}/api/1/vehicles/${encodeURIComponent(tag)}/wake_up`;
  try{
    const {data}=await axios.post(url, {}, {headers:{Authorization:`Bearer ${accessToken}`}});
    return data?.response?.state || "unknown";
  }catch(e){
    if(e?.response?.status===403) throw new Error("wake_up non autorizzato: aggiungi 'vehicle_cmds' agli scope e riautorizza.");
    throw new Error("wake_up fallito: "+(e?.response?.data?.error || e.message));
  }
}
function looksUnavailable(err){
  const s=err?.response?.status;
  const b=err?.response?.data;
  const m=(b?.error || b?.error_description || err?.message || "").toString().toLowerCase();
  return s===408 || m.includes("vehicle unavailable") || m.includes("offline") || m.includes("asleep");
}

/* ===== Partner (EU) ===== */
async function fetchPemReachable(domain){
  const url=`https://${domain}/.well-known/appspecific/com.tesla.3p.public-key.pem`;
  try{ const r=await axios.get(url,{timeout:10000}); return r.status>=200 && r.status<300; }catch{ return false; }
}
function partnerCreds(){
  return {
    id:  TESLA_PARTNER_CLIENT_ID || TESLA_CLIENT_ID,
    sec: TESLA_PARTNER_CLIENT_SECRET || TESLA_CLIENT_SECRET || "",
  };
}
async function getPartnerTokenEU(){
  const {id,sec}=partnerCreds();
  const form=new URLSearchParams();
  form.append("grant_type","client_credentials");
  form.append("client_id",id);
  if(sec) form.append("client_secret",sec);
  form.append("audience",API_BASE);
  const {data}=await axios.post(TOKEN_URL, form, {headers:{"Content-Type":"application/x-www-form-urlencoded"}});
  return data.access_token;
}
async function checkPartnerRegisteredEU(domain, token){
  const url = `${API_BASE}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(domain)}`;
  try{ await axios.get(url, {headers:{Authorization:`Bearer ${token}`}}); return true; }catch{ return false; }
}
async function registerPartnerEU(domain, token){
  const url = `${API_BASE}/api/1/partner_accounts`;
  await axios.post(url, {domain}, {headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"}});
}
async function ensurePartnerRegisteredEU(domain){
  console.log(`Verifica partner EU per dominio: ${domain}`);
  if(!await fetchPemReachable(domain)){
    throw new Error(`PEM non raggiungibile su https://${domain}/.well-known/appspecific/com.tesla.3p.public-key.pem`);
  }
  const ptoken = await getPartnerTokenEU();
  if(await checkPartnerRegisteredEU(domain, ptoken)){ console.log("✔ partner EU già registrato."); return; }
  console.log("Registro partner EU…");
  await registerPartnerEU(domain, ptoken);
  if(!(await checkPartnerRegisteredEU(domain, ptoken))) throw new Error("Registrazione partner EU non verificata.");
  console.log("✔ registrazione partner EU completata.");
}

/* ===== Stato interno & contatore ===== */
async function loadState(){ return await loadJSON(STATE_PATH, {wakes:[], polls:[], last_success_iso:null}); }
async function recordWake(state, iso){ state.wakes.push(iso); await saveJSON(STATE_PATH,state); }
async function recordPoll(state, iso){ state.polls.push(iso); await saveJSON(STATE_PATH,state); }
function countWakesTodayLocal(arr){
  const today = localDateStr(new Date());
  return arr.filter(ts=> localDateStr(new Date(ts)) === today).length;
}

// Contatore giornaliero editabile
async function loadCounter(file){
  let c; try{ c=JSON.parse(await fs.readFile(file,'utf-8')); }catch{ c=null; }
  const today = localDateStr();
  if(!c || c.date !== today) return {date:today, count:0};
  return c;
}
async function saveCounter(file, counter){
  await fs.writeFile(file, JSON.stringify(counter,null,2), 'utf-8');
}

/* ===== Lettura con onfail + quiet + tetto ===== */
async function readVehicleDataWithPolicy(accessToken, tag, state, counter){
  await recordPoll(state, new Date().toISOString());

  try{
    return { data: await getVehicleData(accessToken, tag), woke:false, usedWakeToday:counter.count };
  }catch(err){
    // partner non registrato → prova auto-register e ritenta una volta
    const msg = (err?.response?.data?.error || err?.message || "").toString().toLowerCase();
    if (msg.includes("must be registered in the current region")){
      if (AUTO_PARTNER_REGISTER === "true" && TESLA_PARTNER_DOMAIN){
        console.warn("Partner non registrato in EU: auto-register…");
        await ensurePartnerRegisteredEU(TESLA_PARTNER_DOMAIN);
        // ritenta
        return { data: await getVehicleData(accessToken, tag), woke:false, usedWakeToday:counter.count };
      }
      throw new Error("Partner non registrato in EU. Imposta AUTO_PARTNER_REGISTER=true e TESLA_PARTNER_DOMAIN nel .env");
    }

    if(!looksUnavailable(err)) throw err;

    const inQuiet = inQuietWindow(new Date(), QUIET_WINDOW);
    const maxPerDay = Number(MAX_WAKE_PER_DAY) || 0;
    const usedToday = counter.count;

    if(inQuiet) throw new Error(`Veicolo unavailable durante quiet window (${QUIET_WINDOW}): non eseguo wake_up.`);
    if(maxPerDay && usedToday >= maxPerDay) throw new Error(`Limite wake raggiunto (counter): oggi ${usedToday}/${maxPerDay}.`);

    console.log("Veicolo unavailable; WAKE onfail → wake_up…");
    const st = await wakeVehicle(accessToken, tag);
    console.log("Stato dopo wake:", st);
    await recordWake(state, new Date().toISOString());
    counter.count += 1; counter.date = localDateStr(); await saveCounter(DAILY_WAKE_FILE, counter);

    for(let i=0;i<8;i++){
      await sleep(5000);
      try{
        await recordPoll(state, new Date().toISOString());
        const data = await getVehicleData(accessToken, tag);
        return { data, woke:true, usedWakeToday: counter.count };
      }catch(e){
        if(!looksUnavailable(e)) throw e;
        process.stdout.write(".");
      }
    }
    throw new Error("Timeout: veicolo non online dopo wake");
  }
}

/* ===== Main ===== */
(async()=>{
  // (opzionale) auto-register partner EU all'avvio
  if(process.env.AUTO_PARTNER_REGISTER === "true"){
    try{ await ensurePartnerRegisteredEU(TESLA_PARTNER_DOMAIN); }
    catch(e){ console.warn("Auto-register partner:", e.message); }
  }

  const state   = await loadState();
  let counter   = await loadCounter(DAILY_WAKE_FILE);

  // token utente
  let tokens = await loadJSON(TOKENS_PATH, null);
  let accessToken = null;

  if(!tokens?.refresh_token){
    console.log("Prima esecuzione: autorizzazione necessaria.");
    const st = Math.random().toString(36).slice(2);
    const url = buildAuthorizeUrl(st);
    console.log("\n1) Apri e accedi:\n", url, "\n");
    try{ await open(url); }catch{}
    console.log("2) Dopo il login verrai reindirizzato a:", TESLA_REDIRECT_URI, "con ?code=...\n");
    const full = await prompt("Incolla qui l'URL completo di redirect: ");
    const code = parseCodeFromUrl(full);

    console.log("3) Scambio del code per i token…");
    const data = await exchangeCode(code);
    accessToken = data.access_token;
    const refresh = data.refresh_token;
    if(!refresh) exitErr("Nessun refresh_token nella risposta!");
    await saveJSON(TOKENS_PATH, {refresh_token:refresh, created_at:Date.now()});
    console.log("Access token ottenuto. Prefisso:", accessToken.slice(0,24), "…\n");
  }else{
    console.log("Uso refresh_token locale per ottenere un access token…");
    const data = await refreshTokens(tokens.refresh_token);
    accessToken = data.access_token;
    if(data.refresh_token && data.refresh_token !== tokens.refresh_token){
      await saveJSON(TOKENS_PATH, {refresh_token:data.refresh_token, created_at:Date.now()});
      console.log("Refresh token ruotato e salvato.");
    }
  }

  console.log(`Policy: onfail | Quiet: ${QUIET_WINDOW} | Max wake/day: ${MAX_WAKE_PER_DAY}`);
  console.log("Wake counter file:", DAILY_WAKE_FILE);
  console.log("Chiamo /vehicle_data su", TESLA_VEHICLE_TAG, "…");

  let woke=false;
  try{
    const res = await readVehicleDataWithPolicy(accessToken, TESLA_VEHICLE_TAG, state, counter);
    const vd = res.data; woke = !!res.woke;
    counter = await loadCounter(DAILY_WAKE_FILE); // ricarica

    // campi extra utili all'analisi
    const odoMiles = vd?.response?.vehicle_state?.odometer;
    const odometer_km = (typeof odoMiles==="number") ? Math.round(odoMiles*1.60934*10)/10 : null;
    const charging_state = vd?.response?.charge_state?.charging_state;
    const is_charging = charging_state === "Charging";

    const out = {
      ts: new Date().toISOString(),
      soc_percent: vd?.response?.charge_state?.battery_level,
      range_km:  vd?.response?.charge_state?.battery_range,
      ideal_range_km: vd?.response?.charge_state?.ideal_battery_range,
      charging_state,
      is_charging,
      odometer_km,
      is_online: vd?.response?.state === "online",
      woke,
      wake_today_counter: counter.count,
    };
    console.log(JSON.stringify(out,null,2));

    state.last_success_iso = out.ts;
    await saveJSON(STATE_PATH, state);
    await safeAppend(LOG_FILE, JSON.stringify(out));
  }catch(err){
    const msg = err?.response?.data || err.message;
    console.error("\nLettura fallita:", msg);
    await safeAppend(LOG_FILE, JSON.stringify({ ts:new Date().toISOString(), error:String(msg), woke }));
    process.exit(1);
  }

  const wakesTodayState = countWakesTodayLocal(state.wakes);
  const wakesTodayFile  = counter.count;
  console.log("\n=== Riepilogo di oggi ===");
  console.log(`Wake (file editabile): ${wakesTodayFile}/${MAX_WAKE_PER_DAY}`);
  console.log(`Wake (storico interno): ${wakesTodayState}`);
})();
