import fs from "fs/promises";

// Uso: node analyze.mjs [tesla_soc.jsonl]
// ENV (opzionale): DAYS_REPORT (default 14)
const INPUT = process.argv[2] || "./tesla_soc.jsonl";
const DAYS_REPORT = parseInt(process.env.DAYS_REPORT || "14", 10);
const MS_HOUR = 3600000;
const MS_DAY = 24 * MS_HOUR;

/* --- Helpers tempo (local time) --- */
function pad(n){ return String(n).padStart(2,"0"); }
function toLocalDate(d){ return new Date(d); }
function ymd(d=new Date()){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

/* --- Carica log (JSON Lines) --- */
async function loadPoints(file){
  const txt = await fs.readFile(file, "utf-8").catch(()=>null);
  if(!txt) throw new Error(`File non trovato: ${file}`);
  const pts = [];
  for (const line of txt.split(/\r?\n/)){
    const t = line.trim(); if(!t) continue;
    try {
      const j = JSON.parse(t);
      if (j.error) continue;
      if (typeof j.soc_percent !== "number") continue;
      pts.push(j);
    } catch {}
  }
  if (pts.length < 2) throw new Error("Log insufficiente (servono almeno 2 letture).");
  pts.sort((a,b)=> new Date(a.ts) - new Date(b.ts));
  return pts;
}

/* --- Resampling orario con interpolazione lineare --- */
function resampleHourly(points, hoursMax){
  if (!points.length) return { labels: [], values: [] };

  // ts numerici e soc
  const ts = points.map(p => +new Date(p.ts));
  const vs = points.map(p => p.soc_percent);

  // griglia oraria: ultime 'hoursMax' ore, allineata all'ultima ora piena del dataset
  const endHour = Math.floor(ts[ts.length-1] / MS_HOUR) * MS_HOUR;
  const startHour = endHour - (hoursMax - 1) * MS_HOUR; // es. 72 punti = 72 ore
  const grid = [];
  for (let t = startHour; t <= endHour; t += MS_HOUR) grid.push(t);

  // interpolazione lineare piecewise
  const out = [];
  let i = 0;
  for (const t of grid){
    while (i < ts.length - 2 && ts[i+1] < t) i++;
    if (t <= ts[0]) {
      out.push(vs[0]);
    } else if (t >= ts[ts.length-1]) {
      out.push(vs[vs.length-1]);
    } else {
      const t1 = ts[i],     v1 = vs[i];
      const t2 = ts[i+1],   v2 = vs[i+1];
      const ratio = (t - t1) / (t2 - t1);
      const v = v1 + (v2 - v1) * Math.max(0, Math.min(1, ratio));
      out.push(+v.toFixed(2));
    }
  }

  const labels = grid.map(t => new Date(t).toISOString());
  return { labels, values: out };
}

/* --- Costruisci intervalli e aggrega per giorno --- */
function analyze(points){
  const intervalsUsed = [];
  const intervalsExcluded = [];

  for (let i=1;i<points.length;i++){
    const A = points[i-1], B = points[i];
    const t1 = +new Date(A.ts), t2 = +new Date(B.ts);
    if (!isFinite(t1) || !isFinite(t2) || t2<=t1){
      intervalsExcluded.push({ prev_ts:A.ts, curr_ts:B.ts, reason:"timestamp non valido/duplicato" });
      continue;
    }
    if (A.is_charging || B.is_charging){
      const hours = (t2 - t1)/MS_HOUR;
      const drop  = Math.max((A.soc_percent ?? 0) - (B.soc_percent ?? 0), 0);
      intervalsExcluded.push({
        prev_ts:A.ts, curr_ts:B.ts, hours:+hours.toFixed(3),
        drop_pct:+drop.toFixed(3), reason:"in carica"
      });
      continue;
    }
    const hours = (t2 - t1)/MS_HOUR;
    const drop  = Math.max((A.soc_percent ?? 0) - (B.soc_percent ?? 0), 0);
    const mid   = new Date((t1+t2)/2);
    const day   = ymd(toLocalDate(mid));
    intervalsUsed.push({
      day, prev_ts:A.ts, curr_ts:B.ts, hours:+hours.toFixed(3), drop_pct:+drop.toFixed(3),
      start_soc:A.soc_percent, end_soc:B.soc_percent
    });
  }

  // Aggregazione per giorno
  const byDay = {};
  const pointsByDay = {};
  for (const p of points){
    const d = ymd(toLocalDate(p.ts));
    (pointsByDay[d] ||= []).push(p);
  }
  for (const d of Object.keys(pointsByDay)){
    pointsByDay[d].sort((a,b)=> new Date(a.ts) - new Date(b.ts));
    const first = pointsByDay[d][0], last = pointsByDay[d][pointsByDay[d].length-1];
    const min_soc = Math.min(...pointsByDay[d].map(x=>x.soc_percent));
    const max_soc = Math.max(...pointsByDay[d].map(x=>x.soc_percent));
    byDay[d] = {
      day: d,
      drop: 0,
      first_ts: first.ts,
      last_ts: last.ts,
      first_soc: first.soc_percent,
      last_soc: last.soc_percent,
      min_soc, max_soc,
      intervals: []
    };
  }
  for (const itv of intervalsUsed){
    (byDay[itv.day] ||= {day:itv.day, drop:0, intervals:[]});
    byDay[itv.day].drop += itv.drop_pct;
    byDay[itv.day].intervals.push(itv);
  }

  // Ordine cronologico + serie
  const days = Object.keys(byDay).sort();
  const dailyDates = [];
  const dailyDrop  = [];
  const dailyFirst = [];
  const dailyLast  = [];
  const dailyMin   = [];
  const dailyMax   = [];
  for (const d of days){
    const s = byDay[d];
    dailyDates.push(d);
    dailyDrop.push(+s.drop.toFixed(2));
    dailyFirst.push(s.first_soc ?? null);
    dailyLast.push(s.last_soc ?? null);
    dailyMin.push(s.min_soc ?? null);
    dailyMax.push(s.max_soc ?? null);
  }

  const seriesTs  = points.map(p=>p.ts);
  const seriesSoc = points.map(p=>p.soc_percent);

  // Serie oraria max 72h
  const hourly72 = resampleHourly(points, 72);

  return {
    days, dailyDates, dailyDrop, dailyFirst, dailyLast, dailyMin, dailyMax,
    seriesTs, seriesSoc, intervalsUsed, intervalsExcluded,
    hourly72
  };
}

/* --- Genera CSV e HTML --- */
async function writeCSV(summary){
  const { days, dailyDrop, dailyFirst, dailyLast, dailyMin, dailyMax } = summary;
  const rows = [["day","delta_soc_pts","soc_first","soc_last","soc_min","soc_max"]];
  for (let i=0;i<days.length;i++){
    rows.push([
      days[i],
      dailyDrop[i]?.toString().replace(".",","),
      dailyFirst[i],
      dailyLast[i],
      dailyMin[i],
      dailyMax[i]
    ]);
  }
  await fs.writeFile("daily_summary.csv", rows.map(r=>r.join(";")).join("\n"), "utf-8");
}

async function writeHTML(summary){
  const { dailyDates, dailyDrop, dailyFirst, dailyLast, dailyMin, dailyMax,
          seriesTs, seriesSoc, intervalsUsed, intervalsExcluded, hourly72 } = summary;

  // Timestamp ultimo dato e momento generazione pagina
  const lastTsISO = seriesTs[seriesTs.length - 1];
  const genISO = new Date().toISOString();

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tesla — Consumo SoC</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;color:#111}
 h1{font-size:1.6rem;margin:0 0 6px}
 .muted{color:#666}
 .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 16px;align-items:center}
 button{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
 button.active{background:#f1f1f1}
 .grid{display:grid;grid-template-columns:1fr;gap:18px}
 .card{border:1px solid #e6e6e6;border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
 canvas{max-width:100%;height:360px}
 table{width:100%;border-collapse:collapse;margin-top:8px}
 th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
 th{background:#fafafa}
 .hidden{display:none}
 @media(min-width:900px){ .grid{grid-template-columns:1fr 1fr} }
</style>
</head>
<body>
  <h1>Consumo batteria</h1>
  <div class="muted" id="timestamps">
    Ultimo aggiornamento dati: <b id="lastData">—</b> &middot;
    Pagina generata: <b id="genTime">—</b><br/>
    Periodo analizzato (vista giornaliera): ultimi ${DAYS_REPORT} giorni (se insufficienti dati recenti, uso l’intero storico).
  </div>

  <div class="toolbar">
    <span class="muted">Vista:</span>
    <button data-view="hourly" class="active">Oraria (ultime ore)</button>
    <button data-view="daily">ΔSoC per giorno</button>
    <button data-view="series">SoC nel tempo</button>
    <button data-view="minmax">Min/Max giornaliero</button>

    <span id="hourCtl" class="muted" style="margin-left:16px">Ore:
      <button data-hours="24" class="hr">24</button>
      <button data-hours="48" class="hr">48</button>
      <button data-hours="72" class="hr active">72</button>
    </span>
  </div>

  <div class="grid">
    <div class="card">
      <h3 id="chartTitle">SoC — ultime 72 ore (oraria)</h3>
      <canvas id="mainChart"></canvas>
    </div>
    <div class="card">
      <h3>Dettaglio giorno selezionato</h3>
      <div class="muted">Clicca una barra nella vista giornaliera per i dettagli. Le righe in carica non sono incluse nel calcolo del drop.</div>
      <table>
        <thead><tr><th>Giorno</th><th>SoC primo</th><th>SoC ultimo</th><th>ΔSoC giorno</th></tr></thead>
        <tbody id="daySummary"><tr><td colspan="4" class="muted">—</td></tr></tbody>
      </table>
      <table style="margin-top:10px">
        <thead><tr><th>Da</th><th>A</th><th>h</th><th>ΔSoC</th></tr></thead>
        <tbody id="intervalsBody"><tr><td colspan="4" class="muted">—</td></tr></tbody>
      </table>
    </div>
  </div>

<script>
const dailyDates = ${JSON.stringify(dailyDates)};
const dailyDrop  = ${JSON.stringify(dailyDrop)};
const dailyFirst = ${JSON.stringify(dailyFirst)};
const dailyLast  = ${JSON.stringify(dailyLast)};
const dailyMin   = ${JSON.stringify(dailyMin)};
const dailyMax   = ${JSON.stringify(dailyMax)};
const seriesTs   = ${JSON.stringify(seriesTs)};
const seriesSoc  = ${JSON.stringify(seriesSoc)};
const intervals  = ${JSON.stringify(intervalsUsed)};
const excluded   = ${JSON.stringify(intervalsExcluded)};
const lastTsISO  = ${JSON.stringify(seriesTs[seriesTs.length - 1])};
const genISO     = ${JSON.stringify(new Date().toISOString())};
// oraria max 72h (base); i filtri 24/48 sono slice su questa serie
const hourlyBaseTs  = ${JSON.stringify(hourly72.labels)};
const hourlyBaseSoc = ${JSON.stringify(hourly72.values)};

// Mostra timestamp in locale browser
(function(){
  function fmt(iso){
    try { return new Date(iso).toLocaleString(undefined, { hour12:false }); }
    catch { return iso; }
  }
  document.getElementById('lastData').textContent = fmt(lastTsISO);
  document.getElementById('genTime').textContent  = fmt(genISO);
})();

// Stato UI
let currentView  = "hourly"; // hourly|daily|series|minmax
let hourRange = 72; // 24|48|72

const chartEl = document.getElementById('mainChart');
const titleEl = document.getElementById('chartTitle');
let chart;

function mkLine(labels, data, label){
  return new Chart(chartEl, {
    type: 'line',
    data: { labels, datasets: [{ label, data, pointRadius: 0, borderWidth: 2, tension: .15 }] },
    options: { responsive:true, plugins:{ legend:{display:false} }, scales:{ y:{ beginAtZero:false } } }
  });
}
function mkBar(labels, data, label){
  return new Chart(chartEl, {
    type: 'bar',
    data: { labels, datasets: [{ label, data }] },
    options: {
      responsive: true,
      scales: { y: { beginAtZero: true } },
      plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:(ctx)=> 'Δ ' + ctx.parsed.y + ' punti' } } },
      onClick: (_, elements)=>{
        if (!elements.length) return;
        const idx = elements[0].index;
        const day = labels[idx];
        showDayDetail(day);
      }
    }
  });
}

function renderChart(){
  if (chart) chart.destroy();

  // toggle controlli ore
  document.getElementById('hourCtl').classList.toggle('hidden', currentView !== 'hourly');

  if (currentView === 'hourly'){
    // slice finale in base a hourRange
    const n = hourlyBaseTs.length;
    const k = Math.min(hourRange, n);
    const labels = hourlyBaseTs.slice(n-k).map(iso => {
      const d = new Date(iso);
      return d.toLocaleString(undefined,{ hour12:false, day:'2-digit', month:'2-digit', hour:'2-digit' });
    });
    const data = hourlyBaseSoc.slice(n-k);
    titleEl.textContent = 'SoC — ultime ' + k + ' ore (oraria)';
    chart = mkLine(labels, data, 'SoC');
  } else if (currentView === 'daily'){
    titleEl.textContent = 'ΔSoC per giorno';
    chart = mkBar(dailyDates, dailyDrop, 'ΔSoC (punti)');
  } else if (currentView === 'series'){
    titleEl.textContent = 'SoC nel tempo';
    chart = mkLine(seriesTs, seriesSoc, 'SoC');
  } else {
    titleEl.textContent = 'Min/Max giornaliero';
    chart = new Chart(chartEl, {
      type: 'line',
      data: { labels: dailyDates, datasets: [
        { label: 'Max SoC', data: dailyMax, pointRadius: 2, borderWidth: 2, tension: .1 },
        { label: 'Min SoC', data: dailyMin, pointRadius: 2, borderWidth: 2, tension: .1 }
      ]},
      options: { responsive:true, plugins:{ legend:{display:true} }, scales:{ y:{ beginAtZero:false } } }
    });
  }

  // reset dettaglio
  document.getElementById('daySummary').innerHTML = '<tr><td colspan="4" class="muted">—</td></tr>';
  document.getElementById('intervalsBody').innerHTML = '<tr><td colspan="4" class="muted">—</td></tr>';
}

// Dettaglio giorno (per vista giornaliera)
function showDayDetail(day){
  const i = dailyDates.indexOf(day);
  if (i<0) return;
  const first = dailyFirst[i], last = dailyLast[i], drop = dailyDrop[i];

  document.getElementById('daySummary').innerHTML =
    '<tr><td>'+day+'</td><td>'+first+'</td><td>'+last+'</td><td>'+drop+'</td></tr>';

  const rows = intervals.filter(r => r.day === day);
  const tbody = document.getElementById('intervalsBody');
  if (!rows.length){
    tbody.innerHTML = '<tr><td colspan="4" class="muted">nessun intervallo utile (forse solo carica)</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const r of rows){
    const tr = document.createElement('tr');
    ['prev_ts','curr_ts','hours','drop_pct'].forEach(k=>{
      const td = document.createElement('td');
      td.textContent = r[k];
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

// Bottoni vista
document.querySelectorAll('button[data-view]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('button[data-view]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.getAttribute('data-view');
    renderChart();
  });
});

// Bottoni ore (24/48/72)
document.querySelectorAll('button.hr').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('button.hr').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    hourRange = parseInt(btn.getAttribute('data-hours'),10);
    renderChart();
  });
});

renderChart();
</script>
</body>
</html>`;

  await fs.writeFile("index.html", html, "utf-8");
}

/* --- main --- */
async function main(){
  // Carica tutti i punti
  const allPts = await loadPoints(INPUT);

  // Finestra ultimi DAYS_REPORT giorni con fallback all'intero storico (per la parte "giornaliera")
  const cutoff = Date.now() - DAYS_REPORT * MS_DAY;
  const recent = allPts.filter(p => +new Date(p.ts) >= cutoff);
  const pts = recent.length >= 2 ? recent : allPts;

  const summary = analyze(pts);
  await writeCSV(summary);
  await writeHTML(summary);
  console.log("✅ Creati:");
  console.log(" - index.html (grafici interattivi)");
  console.log(" - daily_summary.csv");
}
main().catch(e=>{ console.error(e.message || e); process.exit(1); });
