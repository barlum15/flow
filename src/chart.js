// Canvas line charts of the totals recorded by the smart meter.

const MIN_GRID_SPACING = 36; // px between horizontal grid lines

/** Rounds a value up to a "nice" step (1, 2 or 5 times a power of ten). */
function niceStep(value) {
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 5, 10]) if (value <= m * exp) return m * exp;
  return 10 * exp;
}

function formatClock(t) {
  const m = ((Math.round(t) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function formatWatts(w) {
  return w >= 1000 ? `${(w / 1000).toFixed(w % 1000 === 0 ? 0 : 1)} kW` : `${Math.round(w)} W`;
}

/**
 * Draws the records between `from` and `to` (minutes since simulation start).
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {{t:number, watts:number}[]} options.records
 * @param {number} options.from
 * @param {number} options.to
 * @param {number} options.tickEvery minutes between x-axis labels
 * @param {{t:number, watts:number}} [options.live] current value, drawn as the last point
 * @param {number} [options.now] position of the "now" marker
 */
export function drawChart(canvas, { records, from, to, tickEvery, live, now }) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue("--muted").trim();
  const grid = styles.getPropertyValue("--grid").trim();
  const energy = styles.getPropertyValue("--energy").trim();

  // Visible points: one before `from` so the line enters from the left edge.
  let first = records.findIndex((r) => r.t >= from);
  if (first === -1) first = records.length;
  const points = records.slice(Math.max(0, first - 1)).filter((r) => r.t <= to);
  if (live) points.push(live);

  const pad = { left: 52, right: 16, top: 12, bottom: 26 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const peak = Math.max(400, ...points.map((p) => p.watts)) * 1.05;
  const targetLines = Math.max(2, Math.min(5, Math.floor(h / MIN_GRID_SPACING)));
  const step = niceStep(peak / targetLines);
  const gridLines = Math.ceil(peak / step);
  const maxWatts = step * gridLines;

  const x = (t) => pad.left + ((t - from) / (to - from)) * w;
  const y = (watts) => pad.top + h - (watts / maxWatts) * h;

  ctx.font = "11px system-ui, sans-serif";
  ctx.lineWidth = 1;

  // Horizontal grid with watt labels
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= gridLines; i++) {
    const watts = step * i;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(pad.left, Math.round(y(watts)) + 0.5);
    ctx.lineTo(pad.left + w, Math.round(y(watts)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(formatWatts(watts), pad.left - 8, y(watts));
  }

  // Time labels
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let t = Math.ceil(from / tickEvery) * tickEvery; t <= to; t += tickEvery) {
    ctx.fillStyle = muted;
    ctx.fillText(formatClock(t), x(t), height - 6);
  }

  // Clip to the plot area so the scrolling line does not overflow the axes.
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top - 2, w, h + 4);
  ctx.clip();

  if (points.length > 1) {
    // Step line: each record holds its value until the next one.
    const path = new Path2D();
    path.moveTo(x(points[0].t), y(points[0].watts));
    for (let i = 1; i < points.length; i++) {
      path.lineTo(x(points[i].t), y(points[i - 1].watts));
      path.lineTo(x(points[i].t), y(points[i].watts));
    }

    const area = new Path2D(path);
    area.lineTo(x(points[points.length - 1].t), y(0));
    area.lineTo(x(points[0].t), y(0));
    area.closePath();
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + h);
    gradient.addColorStop(0, styles.getPropertyValue("--energy-fill").trim());
    gradient.addColorStop(1, "transparent");
    ctx.fillStyle = gradient;
    ctx.fill(area);

    ctx.strokeStyle = energy;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke(path);
  }

  if (now !== undefined) {
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x(now)) + 0.5, pad.top);
    ctx.lineTo(Math.round(x(now)) + 0.5, pad.top + h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  if (live) {
    ctx.fillStyle = energy;
    ctx.beginPath();
    ctx.arc(x(live.t), y(live.watts), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
