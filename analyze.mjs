import fs from "fs/promises";

// Uso: node analyze.mjs [tesla_soc.jsonl]
const INPUT = process.argv[2] || "./tesla_soc.jsonl";

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
      const hours = (t2 - t1)/3600000;
      const drop  = Math.max((A.soc_percent ?? 0) - (B.soc_percent ?? 0), 0);
      intervalsExcluded.push({
        prev_ts:A.ts, curr_ts:B.ts, hours:+hours.toFixed(3),
        drop_pct:+drop.toFixed(3), reason:"in carica"
      });
      continue;
    }
    const hours = (t2 - t1)/3600000;
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

  return {
    days, dailyDates, dailyDrop, dailyFirst, dailyLast, dailyMin, dailyMax,
    seriesTs, seriesSoc, intervalsUsed, intervalsExcluded
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
          seriesTs, seriesSoc, intervalsUsed, intervalsExcluded } = summary;

  // Timestamp ultimo dato e momento generazione pagina
  const lastTsISO = seriesTs[seriesTs.length - 1];
  const genISO = new Date().toISOString();

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tesla — Consumo giornaliero SoC</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;color:#111}
 h1{font-size:1.6rem;margin:0 0 6px}
 .muted{color:#666}
 .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 16px}
 button{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
 button.active{background:#f1f1f1}
 .grid{display:grid;grid-template-columns:1fr;gap:18px}
 .card{border:1px solid #e6e6e6;border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
 canvas{max-width:100%;height:360px}
 table{width:100%;border-collapse:collapse;margin-top:8px}
 th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
 th{background:#fafafa}
 @media(min-width:900px){ .grid{grid-template-columns:1fr 1fr} }
</style>
</head>
<body>
  <h1>Consumo batteria: vista giornaliera</h1>
  <div class="muted" id="timestamps">
    Ultimo aggiornamento dati: <b id="lastData">—</b> &middot;
    Pagina generata: <b id="genTime">—</b>
  </div>
  <div class="muted">Mostro quanto è sceso il SoC ogni giorno (punti %). Intervalli in carica esclusi dall'analisi.</div>

  <div class="toolbar">
    <span class="muted">Intervallo:</span>
    <button data-range="7">Ultimi 7</button>
    <button data-range="30">Ultimi 30</button>
    <button data-range="90">Ultimi 90</button>
    <button data-range="all" class="active">Tutti</button>
    <span style="width:12px"></span>
    <span class="muted">Vista:</span>
    <button data-view="daily" class="active">ΔSoC per giorno</button>
    <button data-view="series">SoC nel tempo</button>
    <button data-view="minmax">Min/Max giornaliero</button>
  </div>

  <div class="grid">
    <div class="card">
      <h3 id="chartTitle">ΔSoC per giorno</h3>
      <canvas id="mainChart"></canvas>
    </div>
    <div class="card">
      <h3>Dettaglio giorno selezionato</h3>
      <div class="muted">Clicca una barra per aprire i dettagli. Le righe in carica non sono incluse nel calcolo del drop.</div>
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
let currentRange = "all"; // 7|30|90|all
let currentView  = "daily"; // daily|series|minmax

const chartEl = document.getElementById('mainChart');
const titleEl = document.getElementById('chartTitle');
let chart;

// Utils range
function sliceRange(labels, data, range){
  const n = labels.length;
  if (range === "all") return {labels:[...labels], data:[...data]};
  const k = parseInt(range,10);
  const start = Math.max(0, n - k);
  return {labels: labels.slice(start), data: data.slice(start)};
}

// Render chart
function renderChart(){
  if (chart) chart.destroy();
  if (currentView === 'daily'){
    titleEl.textContent = 'ΔSoC per giorno';
    const sliced = sliceRange(dailyDates, dailyDrop, currentRange);
    chart = new Chart(chartEl, {
      type: 'bar',
      data: { labels: sliced.labels, datasets: [{ label: 'ΔSoC (punti)', data: sliced.data }] },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true } },
        plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:(ctx)=> 'Δ ' + ctx.parsed.y + ' punti' } } },
        onClick: (_, elements)=>{
          if (!elements.length) return;
          const idx = elements[0].index;
          const day = sliced.labels[idx];
          showDayDetail(day);
        }
      }
    });
  } else if (currentView === 'series'){
    titleEl.textContent = 'SoC nel tempo';
    chart = new Chart(chartEl, {
      type: 'line',
      data: { labels: seriesTs, datasets: [{ label: 'SoC', data: seriesSoc, pointRadius: 0, borderWidth: 2, tension: .15 }] },
      options: { responsive:true, plugins:{ legend:{display:false} }, scales:{ y:{ beginAtZero:false } } }
    });
  } else {
    titleEl.textContent = 'Min/Max giornaliero';
    const minS = sliceRange(dailyDates, dailyMin, currentRange);
    const maxS = sliceRange(dailyDates, dailyMax, currentRange);
    chart = new Chart(chartEl, {
      type: 'line',
      data: { labels: maxS.labels, datasets: [
        { label: 'Max SoC', data: maxS.data, pointRadius: 2, borderWidth: 2, tension: .1 },
        { label: 'Min SoC', data: minS.data, pointRadius: 2, borderWidth: 2, tension: .1 }
      ]},
      options: { responsive:true, plugins:{ legend:{display:true} }, scales:{ y:{ beginAtZero:false } } }
    });
  }
  // reset dettaglio
  document.getElementById('daySummary').innerHTML = '<tr><td colspan="4" class="muted">—</td></tr>';
  document.getElementById('intervalsBody').innerHTML = '<tr><td colspan="4" class="muted">—</td></tr>';
}

// Dettaglio giorno
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

// Bottoni toolbar
document.querySelectorAll('button[data-range]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('button[data-range]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.getAttribute('data-range');
    renderChart();
  });
});
document.querySelectorAll('button[data-view]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('button[data-view]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.getAttribute('data-view');
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
  const pts = await loadPoints(INPUT);
  const summary = analyze(pts);
  await writeCSV(summary);
  await writeHTML(summary);
  console.log("✅ Creati:");
  console.log(" - index.html (grafici interattivi)");
  console.log(" - daily_summary.csv");
}
main().catch(e=>{ console.error(e.message || e); process.exit(1); });
