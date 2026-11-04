// Panel for the load disaggregation: per-appliance probabilities and power
// estimates, model confidence, accuracy against the ground truth and a
// stacked chart of the estimated contributions.

import { niceStep, formatClock, formatWatts, MIN_GRID_SPACING } from "./chart.js";
import { wasDrag } from "./chart-zoom.js";

const RESIDUAL_COLOR = "#8a93a3";

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function percent(value) {
  return value === null ? "–" : `${Math.round(value * 100)} %`;
}

function make(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

export class NilmView {
  constructor(root, appliances) {
    this.root = root;
    this.history = []; // { t, total, vars, parts: { id: watts }, residual, result, truth }
    this.selectedT = null; // minute shown in the table while inspecting
    this.onSelect = null; // called when the user picks a point in time
    this.layout = null; // last chart geometry, used to map clicks to minutes
    this.table = root.querySelector("#nilm-rows");
    this.setAppliances(appliances);

    this.confidence = root.querySelector("#nilm-confidence");

    this.onOff = root.querySelector("#nilm-onoff");
    this.energy = root.querySelector("#nilm-energy");
    this.speed = root.querySelector("#nilm-speed");
    this.canvas = root.querySelector("#nilm-chart");
    this.snapshot = root.querySelector("#nilm-snapshot");
    this.snapshotTime = root.querySelector("#nilm-snapshot-time");

    this.canvas.addEventListener("click", (event) => {
      if (wasDrag(this.canvas)) return; // the mouse was dragged to move the time window
      const t = this.minuteAt(event.offsetX);
      if (t !== null) this.select(t);
    });
    this.canvas.addEventListener("keydown", (event) => {
      if (this.selectedT === null || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      this.select(this.selectedT + (event.key === "ArrowLeft" ? -1 : 1));
    });
  }

  /**
   * Builds one table row per appliance. Only the appliances that are switched
   * on in the house are passed in, so the table and the chart stay focused.
   */
  setAppliances(appliances) {
    this.appliances = appliances;
    this.rows = new Map();
    this.table.replaceChildren();

    for (const a of appliances) {
      const row = make("div", "nilm-row", this.table);
      const name = make("div", "nilm-name", row);
      make("span", "swatch", name).style.background = a.color;
      make("span", "", name, a.name);

      const state = make("div", "nilm-state", row, "–");

      const prob = make("div", "nilm-prob", row);
      const bar = make("div", "prob-bar", prob);
      const fill = make("div", "prob-fill", bar);
      fill.style.background = a.color;
      const pText = make("span", "prob-text", prob, "–");

      const estimate = make("div", "nilm-estimate", row, "–");
      const actual = make("div", "nilm-actual", row, "–");
      this.rows.set(a.id, { row, state, fill, pText, estimate, actual });
    }
    if (appliances.length === 0) {
      make("div", "nilm-empty", this.table, "No appliances selected in the house.");
    }

    const rest = make("div", "nilm-row nilm-rest", this.table);
    const restName = make("div", "nilm-name", rest);
    make("span", "swatch", restName).style.background = RESIDUAL_COLOR;
    make("span", "", restName, "Residual");
    restName.title = "Measured minus the sum of all estimates. Positive: consumption no appliance explains. Negative: the appliances are estimated higher than measured.";
    make("div", "nilm-state residual-hint", rest, "measured − estimated");
    make("div", "nilm-prob", rest, "");
    this.restEstimate = make("div", "nilm-estimate", rest, "–");
    make("div", "nilm-actual", rest, "");

    // Show the current values again in the new rows.
    const entry = this.selectedT !== null ? this.entryAt(this.selectedT) : this.latest;
    if (entry && this.confidence) this.render(entry.result, entry.truth);
  }

  /** Forgets all results, e.g. after switching the data source or jumping to another day. */
  reset() {
    this.history = [];
    this.latest = null;
    this.avgMs = undefined;
    this.clearSelection();
  }

  /** Maps a click position to the minute of the closest stored result. */
  minuteAt(px) {
    if (!this.layout || this.history.length === 0) return null;
    const { from, to, left, width } = this.layout;
    if (px < left || px > left + width) return null;
    return Math.floor(from + ((px - left) / width) * (to - from));
  }

  entryAt(t) {
    // History is sorted by t: binary search for the last entry at or before t.
    let lo = 0;
    let hi = this.history.length - 1;
    if (hi < 0 || t < this.history[0].t) return this.history[0] ?? null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.history[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return this.history[lo];
  }

  /** Shows the stored result of the given minute and notifies the app (to pause). */
  select(t) {
    const entry = this.entryAt(t);
    if (!entry) return;
    this.selectedT = entry.t;
    this.render(entry.result, entry.truth);
    setText(this.snapshotTime, formatClock(entry.t));
    this.snapshot.hidden = false;
    this.root.classList.add("inspecting");
    this.onSelect?.(entry.t);
  }

  /** Returns to the live view. */
  clearSelection() {
    this.selectedT = null;
    this.snapshot.hidden = true;
    this.root.classList.remove("inspecting");
    if (this.latest) this.render(this.latest.result, this.latest.truth);
  }

  /** Stores one disaggregation result (one minute) for the chart and for inspection. */
  push(t, result, truth, vars = 0) {
    this.history.push({
      t,
      total: result.total,
      vars, // reactive power of the smart meter in that minute
      parts: Object.fromEntries(result.appliances.map((a) => [a.id, a.estimate])),
      residual: Math.max(0, result.residual), // only the unexplained (positive) part is stacked
      result,
      truth,
    });
    if (this.history.length > 2 * 1440) this.history.shift();
  }

  /** Receives the latest live result. The table only follows it when not inspecting. */
  update(result, truth, metrics, updateMs) {
    this.latest = { result, truth };
    if (this.selectedT === null) this.render(result, truth);

    setText(this.onOff, percent(metrics.onOffAccuracy));
    setText(this.energy, percent(metrics.energyAccuracy));
    // Browsers round performance.now(), so show a running average.
    this.avgMs = this.avgMs === undefined ? updateMs : this.avgMs * 0.95 + updateMs * 0.05;
    setText(this.speed, this.avgMs < 0.1 ? "< 0.1 ms" : `${this.avgMs.toFixed(1)} ms`);
  }

  /** Fills the table with one result. */
  render(result, truth) {
    for (const a of result.appliances) {
      const r = this.rows.get(a.id);
      if (!r) continue; // appliance no longer selected
      const on = a.pOn >= 0.5;
      r.row.classList.toggle("is-on", on);
      setText(r.state, `${a.state} · ${Math.round(a.stateProbability * 100)} %`);
      r.fill.style.width = `${(a.pOn * 100).toFixed(1)}%`;
      setText(r.pText, `${Math.round(a.pOn * 100)} %`);
      setText(r.estimate, a.estimate < 1 ? "0 W" : `${Math.round(a.estimate)} ± ${Math.round(a.sd)} W`);

      const actual = truth?.[a.id];
      setText(r.actual, actual === undefined ? "–" : `${Math.round(actual)} W`);
      const hit = actual === undefined || (actual > 5) === on;
      r.actual.classList.toggle("miss", !hit);
    }
    const rest = Math.round(result.residual);
    setText(this.restEstimate, `${rest > 0 ? "+" : rest < 0 ? "−" : ""}${Math.abs(rest)} W`);

    setText(this.confidence, percent(result.confidence));
  }

  /** Draws the stacked estimate chart for the given time range. */
  draw({ from, to, tickEvery }) {
    const canvas = this.canvas;
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
    const text = styles.getPropertyValue("--text").trim();

    let first = this.history.findIndex((h) => h.t >= from);
    if (first === -1) first = this.history.length;
    const points = this.history.slice(Math.max(0, first - 1)).filter((h) => h.t <= to);

    const pad = { left: 52, right: 16, top: 12, bottom: 26 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const peak = Math.max(400, ...points.map((p) => Math.max(p.total, Object.values(p.parts).reduce((a, b) => a + b, 0) + p.residual))) * 1.05;
    const targetLines = Math.max(2, Math.min(5, Math.floor(h / MIN_GRID_SPACING)));
    const step = niceStep(peak / targetLines);
    const gridLines = Math.ceil(peak / step);
    const maxWatts = step * gridLines;
    const x = (t) => pad.left + ((t - from) / (to - from)) * w;
    const y = (watts) => pad.top + h - (watts / maxWatts) * h;
    this.layout = { from, to, left: pad.left, width: w };

    ctx.font = "11px system-ui, sans-serif";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= gridLines; i++) {
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(y(step * i)) + 0.5);
      ctx.lineTo(pad.left + w, Math.round(y(step * i)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(formatWatts(step * i), pad.left - 8, y(step * i));
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let t = Math.ceil(from / tickEvery) * tickEvery; t <= to; t += tickEvery) {
      ctx.fillText(formatClock(t), x(t), height - 6);
    }

    if (points.length === 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top - 2, w, h + 4);
    ctx.clip();

    // Each record covers one minute: [t, t + 1).
    const layers = [...this.appliances.map((a) => ({ color: a.color, value: (p) => p.parts[a.id] ?? 0 })), {
      color: RESIDUAL_COLOR,
      value: (p) => p.residual,
    }];
    const base = new Float64Array(points.length);
    for (const layer of layers) {
      ctx.beginPath();
      points.forEach((p, i) => {
        const top = base[i] + layer.value(p);
        if (i === 0) ctx.moveTo(x(p.t), y(top));
        else ctx.lineTo(x(p.t), y(top));
        ctx.lineTo(x(p.t + 1), y(top));
      });
      for (let i = points.length - 1; i >= 0; i--) {
        ctx.lineTo(x(points[i].t + 1), y(base[i]));
        ctx.lineTo(x(points[i].t), y(base[i]));
      }
      ctx.closePath();
      ctx.fillStyle = layer.color;
      ctx.globalAlpha = 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;
      points.forEach((p, i) => (base[i] += layer.value(p)));
    }

    // Measured total from the smart meter
    ctx.strokeStyle = text;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(x(p.t), y(p.total));
      else ctx.lineTo(x(p.t), y(p.total));
      ctx.lineTo(x(p.t + 1), y(p.total));
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Selected minute
    if (this.selectedT !== null && this.selectedT >= from - 1 && this.selectedT <= to) {
      const sx = x(this.selectedT + 0.5);
      ctx.fillStyle = text;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x(this.selectedT), pad.top, Math.max(2, x(this.selectedT + 1) - x(this.selectedT)), h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = text;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(sx) + 0.5, pad.top);
      ctx.lineTo(Math.round(sx) + 0.5, pad.top + h);
      ctx.stroke();
    }
    ctx.restore();

    if (this.selectedT !== null && this.selectedT >= from - 1 && this.selectedT <= to) {
      const label = formatClock(this.selectedT);
      ctx.font = "600 11px system-ui, sans-serif";
      const lw = ctx.measureText(label).width + 12;
      const lx = Math.min(Math.max(x(this.selectedT + 0.5) - lw / 2, pad.left), pad.left + w - lw);
      ctx.fillStyle = text;
      ctx.beginPath();
      ctx.roundRect(lx, pad.top, lw, 18, 4);
      ctx.fill();
      ctx.fillStyle = styles.getPropertyValue("--panel").trim();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + lw / 2, pad.top + 9);
    }
  }
}
