// Tesla Fleet logger — Enrico
// Requisiti: npm i axios dotenv open
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== ENV ======
const {
  TESLA_CLIENT_ID,
  TESLA_CLIENT_SECRET = "",
  TESLA_REGION = "eu",
  TESLA_REDIRECT_URI,
  TESLA_VEHICLE_TAG,
  EXTRA_SCOPES = "",
  WAKE_POLICY = "onfail",                           // onfail | never | always
  QUIET_WINDOW = "00:00-07:30",                     // HH:MM-HH:MM (ora locale)
  MAX_WAKE_PER_DAY = "16",
  LOG_FILE = ".runner_state/tesla_soc.jsonl",
  DAILY_WAKE_FILE = ".runner_state/wake_counter.json",
  TOKENS_PATH = ".runner_state/tokens.json",
  STATE_PATH = ".runner_state/state.json",
  AUTO_PARTNER_REGISTER = "true",
  TESLA_PARTNER_DOMAIN = "",
  TESLA_PARTNER_CLIENT_ID = "",
  TESLA_PARTNER_CLIENT_SECRET = "",
  EXIT_ZERO_ON_QUIET = "true"                       // se in quiet e non sveglio -> exit code 0
} = process.env;

// ====== COSTANTI TESLA FLEET ======
const AUTH_BASE = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3";
const API_BASES = {
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1",
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com/api/1",
  ap: "https://fleet-api.prd.apac.vn.cloud.tesla.com/api/1",
};
const API_BASE = API_BASES[TESLA_REGION?.toLowerCase()] || API_BASES.eu;

const MS = {
  s: 1000, m: 60_000, h: 3_600_000
};

// ====== UTIL ======
const ensureDir = async (p) => fs.mkdir(path.dirname(p), { recursive: true }).catch(()=>{});
const readJSON = async (p, fallback = null) => {
  try { const t = await fs.readFile(p, "utf-8"); return JSON.parse(t); }
  catch { return fallback; }
};
const writeJSON = async (p, obj) => { await ensureDir(p); await fs.writeFile(p, JSON.stringify(obj, null, 2)); };
const nowISO = () => new Date().toISOString();
const isNumeric = (x) => /^\d+$/.test(String(x||"").trim());

function parseQuietWindow(s=QUIET_WINDOW){
  // "HH:MM-HH:MM"
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(s.trim());
  if(!m) return null;
  const [ , h1, m1, h2, m2 ] = m.map(Number);
  return { start: h1*60+m1, end: h2*60+m2 };
}
function minutesOfDay(d=new Date()){
  return d.getHours()*60 + d.getMinutes();
}
function inQuietWindow(){
  const qw = parseQuietWindow(QUIET_WINDOW);
  if(!qw) return false;
  const tod = minutesOfDay(new Date()); // timezone del runner (getto TZ=Europe/Rome nel workflow)
  if (qw.start <= qw.end){
    return tod >= qw.start && tod < qw.end;
  } else {
    // finestra che passa la mezzanotte (non nel nostro caso, ma gestito)
    return tod >= qw.start || tod < qw.end;
  }
}

// ====== WAKE COUNTER ======
async function getWakeState(){
  const obj = await readJSON(DAILY_WAKE_FILE, { date: "", count: 0 });
  const today = new Date().toISOString().slice(0,10);
  if (obj.date !== today){
    obj.date = today; obj.count = 0;
    await writeJSON(DAILY_WAKE_FILE, obj);
  }
  return obj;
}
async function incWake(){
  const s = await getWakeState();
  s.count += 1;
  await writeJSON(DAILY_WAKE_FILE, s);
  return s.count;
}

// ====== TOKENS ======
async function getTokens(){
  const t = await readJSON(TOKENS_PATH);
  if (!t || !t.refresh_token){
    throw new Error("Refresh token mancante. Inietta TESLA_REFRESH_TOKEN nel tokens.json tramite workflow (step Seed).");
  }
  return t;
}
async function saveTokens(obj){
  await writeJSON(TOKENS_PATH, obj);
}

async function refreshAccessToken(){
  const t = await getTokens();

  const payload = new URLSearchParams();
  payload.set("grant_type", "refresh_token");
  payload.set("refresh_token", t.refresh_token);
  payload.set("client_id", TESLA_CLIENT_ID);
  if (TESLA_CLIENT_SECRET) payload.set("client_secret", TESLA_CLIENT_SECRET);
  if (TESLA_REDIRECT_URI) payload.set("redirect_uri", TESLA_REDIRECT_URI);

  const { data } = await axios.post(`${AUTH_BASE}/token`, payload.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30_000
  });

  const { access_token, refresh_token, expires_in } = data;
  const expires_at = Date.now() + (Number(expires_in) || 3600)*1000 - 60*1000; // 60s margine
  const out = {
    access_token, refresh_token: refresh_token || t.refresh_token, expires_at
  };
  await saveTokens(out);
  return out;
}
async function getValidAccessToken(){
  let t = await getTokens();
  if (!t.access_token || !t.expires_at || Date.now() >= t.expires_at){
    t = await refreshAccessToken();
  }
  return t.access_token;
}

// ====== API WRAPPER ======
async function apiGet(pathname, token){
  const url = `${API_BASE}${pathname}`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000
  });
  return data;
}
async function apiPost(pathname, token, body){
  const url = `${API_BASE}${pathname}`;
  const { data } = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    timeout: 30_000
  });
  return data;
}

// ====== PARTNER REGISTER (una tantum) ======
async function ensurePartnerRegistered(token){
  if ((AUTO_PARTNER_REGISTER||"").toString().toLowerCase() !== "true") return;

  if (!TESLA_PARTNER_DOMAIN){
    console.warn("AUTO_PARTNER_REGISTER attivo ma TESLA_PARTNER_DOMAIN non impostato — salto.");
    return;
  }
  try {
    // Proviamo a registrare — se è già registrato, Tesla risponde comunque 200/409 senza problemi
    await apiPost("/partner_accounts", token, { domain: TESLA_PARTNER_DOMAIN });
    console.log(`Partner domain verificato/registrato: ${TESLA_PARTNER_DOMAIN}`);
  } catch (e) {
    // Non bloccare il run se la registrazione fallisce
    const msg = e?.response?.data?.error || e?.message || String(e);
    console.warn(`Warn: partner_accounts non completato: ${msg}`);
  }
}

// ====== VEHICLE ======
async function resolveVehicleId(token){
  // Se l'utente ha messo un vehicle_id numerico, usalo diretto
  if (isNumeric(TESLA_VEHICLE_TAG)) return TESLA_VEHICLE_TAG;

  // Altrimenti cerca per VIN
  const list = await apiGet("/vehicles", token);
  const vehicles = list?.response || list?.vehicles || [];
  if (!Array.isArray(vehicles) || vehicles.length===0){
    throw new Error("Nessun veicolo trovato sull'account.");
  }
  const vinUpper = (TESLA_VEHICLE_TAG||"").trim().toUpperCase();
  const found = vehicles.find(v =>
    (v.vin || "").toUpperCase() === vinUpper ||
    String(v.id || v.vehicle_id || "").trim() === TESLA_VEHICLE_TAG
  );
  if (!found){
    const vins = vehicles.map(v=>v.vin).filter(Boolean).join(", ");
    throw new Error(`Veicolo non trovato. VIN disponibili: ${vins}`);
  }
  return String(found.id || found.vehicle_id);
}

async function readVehicleData(token, vehicleId){
  // /vehicle_data è "pesante" ma comodo
  const data = await apiGet(`/vehicles/${vehicleId}/vehicle_data`, token);
  return data?.response || data;
}

async function wakeVehicle(token, vehicleId){
  try {
    await apiPost(`/vehicles/${vehicleId}/wake_up`, token, {});
  } catch (e) {
    // alcune regioni possono rispondere 409/4xx anche se il wake è partito
    console.warn("Wake_up POST: warning: " + (e?.response?.data?.error || e.message));
  }
  // Poll: prova a leggere fino a 6 volte (circa 60-70s)
  for (let i=0;i<6;i++){
    await new Promise(r=>setTimeout(r, 10*1000));
    try {
      const vd = await readVehicleData(token, vehicleId);
      return vd; // successo
    } catch (e) {
      const err = (e?.response?.data?.error || e.message || "").toLowerCase();
      if (err.includes("vehicle unavailable") || err.includes("asleep") || err.includes("offline")){
        continue; // ancora addormentato
      } else {
        // errore diverso: propaga
        throw e;
      }
    }
  }
  // ultimo tentativo one-shot
  return await readVehicleData(token, vehicleId);
}

// ====== LOG ======
async function appendLog(entry){
  await ensureDir(LOG_FILE);
  await fs.appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

// ====== MAIN ======
async function main(){
  // sanity env
  if (!TESLA_CLIENT_ID) throw new Error("TESLA_CLIENT_ID mancante nello .env");
  if (!TESLA_REDIRECT_URI) throw new Error("TESLA_REDIRECT_URI mancante nello .env");
  if (!TESLA_VEHICLE_TAG) throw new Error("TESLA_VEHICLE_TAG mancante nello .env");

  // token
  let token = await getValidAccessToken();

  // Partner register: safe no-op se già fatto
  await ensurePartnerRegistered(token);

  // vehicle id
  let vehicleId;
  try {
    vehicleId = await resolveVehicleId(token);
  } catch (e) {
    const emsg = e?.response?.data?.error || e.message || String(e);
    // Alcuni errori arrivano qui con "must be registered in the current region"
    if (/must be registered in the current region/i.test(emsg)) {
      console.log("Registro partner per la regione e riprovo…");
      await ensurePartnerRegistered(token);
      vehicleId = await resolveVehicleId(token);
    } else {
      throw e;
    }
  }

  const QUIET = inQuietWindow();
  const maxWake = parseInt(String(MAX_WAKE_PER_DAY),10) || 0;
  const allowWakeNow = WAKE_POLICY !== "never" && (!QUIET);

  let usedWake = false;
  let data;

  // 1) Primo tentativo di lettura
  try {
    data = await readVehicleData(token, vehicleId);
  } catch (e) {
    const errText = (e?.response?.data?.error || e.message || "").toLowerCase();

    // Se in quiet window e la causa è "asleep/offline", non sveglio e (opzione) esco 0
    if (QUIET && (errText.includes("vehicle unavailable") || errText.includes("asleep") || errText.includes("offline"))){
      console.warn(`Lettura SKIPPATA: veicolo non disponibile durante quiet window (${QUIET_WINDOW}).`);
      if ((EXIT_ZERO_ON_QUIET||"true").toLowerCase()==="true"){
        process.exit(0);
      } else {
        process.exit(1);
      }
    }

    // non in quiet: valutiamo wake in base a policy & tetto
    if (allowWakeNow && (WAKE_POLICY==="always" || WAKE_POLICY==="onfail")){
      const ws = await getWakeState();
      if (ws.count >= maxWake){
        console.warn(`Wake non eseguito: tetto giornaliero raggiunto (${ws.count}/${maxWake}).`);
        // Non fallire il job, semplicemente skippo
        process.exit(0);
      }
      // prova wake
      console.log("Provo wake_up…");
      await wakeVehicle(token, vehicleId);
      await incWake();
      usedWake = true;

      // riprova lettura dopo wake
      data = await readVehicleData(token, vehicleId);
    } else {
      // policy "never" o quiet -> non sveglio
      throw new Error("Veicolo non disponibile e policy non consente wake in questo momento.");
    }
  }

  // 2) Estrazione campi utili
  const charge = data?.charge_state || {};
  const drive  = data?.drive_state || {};
  const vehicle_state = data?.vehicle_state || {};

  const soc = Number(charge.battery_level);
  const charging_state = charge.charging_state || "";
  const is_charging = charging_state.toLowerCase() === "charging";
  const odometer_km = Number(data?.vehicle_state?.odometer || 0); // spesso in km già su Fleet
  const online_state = (data?.state || vehicle_state?.vehicle_state || "").toString();

  const entry = {
    ts: nowISO(),
    soc_percent: Number.isFinite(soc) ? soc : null,
    is_charging,
    charging_state,
    odometer_km: Number.isFinite(odometer_km) ? +odometer_km.toFixed(1) : null,
    awake_via: usedWake ? "wake" : "none",
    api_region: TESLA_REGION,
    online_state
  };

  await appendLog(entry);
  console.log("✓ Log scritto:", entry);
}

main().catch(err=>{
  const msg = err?.response?.data?.error || err?.message || String(err);
  console.error("Errore:", msg);
  process.exit(1);
});
