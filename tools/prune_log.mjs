import fs from "fs/promises";

const file = process.argv[2] || ".runner_state/tesla_soc.jsonl";
const days = parseInt(process.argv[3] || "30", 10);
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

async function main() {
  let txt;
  try { txt = await fs.readFile(file, "utf-8"); }
  catch { return; } // niente da potare

  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t);
      const ts = +new Date(j.ts);
      if (!Number.isFinite(ts)) continue;
      if (ts >= cutoff) out.push(t);
    } catch { /* linea malformata: salta */ }
  }
  await fs.writeFile(file, out.join("\n") + (out.length ? "\n" : ""), "utf-8");
  console.log(`Prune: tenute ${out.length} righe (ultimi ${days} giorni).`);
}

main().catch(e => { console.error(e); process.exit(1); });
