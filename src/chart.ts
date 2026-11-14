// Tiny dependency-free SVG line chart with a hover readout.

export interface Series {
  label: string;
  color: string; // CSS color or var()
  points: [number, number | null][]; // [unix seconds, value]
  width?: number;
}

export interface ChartOpts {
  title: string;
  series: Series[];
  fmt: (v: number) => string;
  zeroLine?: boolean;
  height?: number;
}

const W = 720;
const PAD = { l: 64, r: 12, t: 10, b: 24 };

function niceTime(t: number, span: number): string {
  const d = new Date(t * 1000);
  const iso = d.toISOString();
  return span > 3 * 86400 ? iso.slice(5, 10) : iso.slice(11, 16);
}

export function renderChart(host: HTMLElement, opts: ChartOpts): void {
  const H = opts.height ?? 200;
  const all = opts.series.flatMap((s) => s.points.filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1])));
  const legend = opts.series
    .filter((s) => s.points.some((p) => p[1] !== null))
    .map((s) => `<span class="lg"><i style="background:${s.color}"></i>${s.label}</span>`)
    .join("");
  if (all.length < 2) {
    host.innerHTML = `<div class="chart"><div class="chart-head"><h3>${opts.title}</h3><div class="legend">${legend}</div></div><p class="muted empty">Not enough history yet. A snapshot is taken every 15 minutes.</p></div>`;
    return;
  }
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  let y0 = Math.min(...all.map((p) => p[1]));
  let y1 = Math.max(...all.map((p) => p[1]));
  if (opts.zeroLine) {
    y0 = Math.min(y0, 0);
    y1 = Math.max(y1, 0);
  }
  if (y0 === y1) {
    const d = Math.abs(y0) * 0.05 || 1;
    y0 -= d;
    y1 += d;
  }
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);

  const paths = opts.series
    .map((s) => {
      let d = "";
      let pen = false;
      let prevT = -Infinity;
      for (const [t, v] of s.points) {
        // Break the line over gaps (missing value or a hole longer than 3 hours).
        if (v === null || !Number.isFinite(v) || t - prevT > 3 * 3600) pen = false;
        if (v === null || !Number.isFinite(v)) continue;
        d += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
        prevT = t;
      }
      return d ? `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.6}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : "";
    })
    .join("");

  const ticks = [y1, (y0 + y1) / 2, y0]
    .map((v) => `<text x="${PAD.l - 6}" y="${y(v) + 4}" text-anchor="end">${opts.fmt(v)}</text><line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`)
    .join("");
  const zero = opts.zeroLine && y0 < 0 && y1 > 0 ? `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}" class="zero"/>` : "";
  const xt = `<text x="${PAD.l}" y="${H - 6}">${niceTime(t0, span)}</text><text x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${niceTime(t1, span)}</text>`;

  host.innerHTML = `<div class="chart"><div class="chart-head"><h3>${opts.title}</h3><div class="legend">${legend}</div></div>
<div class="chart-box"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${opts.title}">${ticks}${zero}${paths}${xt}<line class="cursor" y1="${PAD.t}" y2="${H - PAD.b}" x1="-10" x2="-10"/></svg><div class="tip" hidden></div></div></div>`;

  const svg = host.querySelector("svg")!;
  const tip = host.querySelector<HTMLDivElement>(".tip")!;
  const cursor = host.querySelector<SVGLineElement>(".cursor")!;
  const times = [...new Set(opts.series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const move = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((sx - PAD.l) / (W - PAD.l - PAD.r)) * span;
    let best = times[0];
    for (const tt of times) if (Math.abs(tt - t) < Math.abs(best - t)) best = tt;
    cursor.setAttribute("x1", String(x(best)));
    cursor.setAttribute("x2", String(x(best)));
    const rows = opts.series
      .map((s) => {
        const p = s.points.find((q) => q[0] === best);
        return p && p[1] !== null ? `<div><i style="background:${s.color}"></i>${s.label}<b>${opts.fmt(p[1])}</b></div>` : "";
      })
      .join("");
    tip.innerHTML = `<div class="tip-t">${new Date(best * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC</div>${rows}`;
    tip.hidden = false;
    const left = (x(best) / W) * r.width;
    tip.style.left = `${Math.min(Math.max(0, left + 12), r.width - tip.offsetWidth)}px`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cursor.setAttribute("x1", "-10");
    cursor.setAttribute("x2", "-10");
  });
}
