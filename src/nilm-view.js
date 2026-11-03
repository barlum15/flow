// Panel for the load disaggregation: per-appliance probabilities and power
// estimates, model confidence, accuracy against the ground truth and a
// stacked chart of the estimated contributions.

import { niceStep, formatClock, formatWatts, MIN_GRID_SPACING } from "./chart.js";

const UNEXPLAINED_COLOR = "#8a93a3";

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
    this.appliances = appliances;
    this.history = []; // { t, total, parts: [watts per appliance], unexplained }
    this.rows = new Map();

    const table = root.querySelector("#nilm-rows");
    for (const a of appliances) {
      const row = make("div", "nilm-row", table);
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

    const rest = make("div", "nilm-row nilm-rest", table);
    const restName = make("div", "nilm-name", rest);
    make("span", "swatch", restName).style.background = UNEXPLAINED_COLOR;
    make("span", "", restName, "Unexplained");
    make("div", "nilm-state", rest, "");
    make("div", "nilm-prob", rest, "");
    this.restEstimate = make("div", "nilm-estimate", rest, "–");
    make("div", "nilm-actual", rest, "");

    this.confidence = root.querySelector("#nilm-confidence");
    this.onOff = root.querySelector("#nilm-onoff");
    this.energy = root.querySelector("#nilm-energy");
    this.speed = root.querySelector("#nilm-speed");
    this.canvas = root.querySelector("#nilm-chart");
  }

  /** Stores one disaggregation result (one minute) for the chart. */
  push(t, result) {
    this.history.push({
      t,
      total: result.total,
      parts: result.appliances.map((a) => a.estimate),
      unexplained: Math.max(0, result.unexplained),
    });
    if (this.history.length > 2 * 1440) this.history.shift();
  }

  /** Updates the table with the latest result. */
  update(result, truth, metrics, updateMs) {
    for (const a of result.appliances) {
      const r = this.rows.get(a.id);
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
    const rest = result.unexplained;
    setText(this.restEstimate, `${rest >= 0 ? "" : "−"}${Math.abs(Math.round(rest))} W`);

    setText(this.confidence, percent(result.confidence));
    setText(this.onOff, percent(metrics.onOffAccuracy));
    setText(this.energy, percent(metrics.energyAccuracy));
    // Browsers round performance.now(), so show a running average.
    this.avgMs = this.avgMs === undefined ? updateMs : this.avgMs * 0.95 + updateMs * 0.05;
    setText(this.speed, this.avgMs < 0.1 ? "< 0.1 ms" : `${this.avgMs.toFixed(1)} ms`);
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
    const peak = Math.max(400, ...points.map((p) => Math.max(p.total, p.parts.reduce((a, b) => a + b, 0) + p.unexplained))) * 1.05;
    const targetLines = Math.max(2, Math.min(5, Math.floor(h / MIN_GRID_SPACING)));
    const step = niceStep(peak / targetLines);
    const gridLines = Math.ceil(peak / step);
    const maxWatts = step * gridLines;
    const x = (t) => pad.left + ((t - from) / (to - from)) * w;
    const y = (watts) => pad.top + h - (watts / maxWatts) * h;

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
    const layers = [...this.appliances.map((a, i) => ({ color: a.color, value: (p) => p.parts[i] })), {
      color: UNEXPLAINED_COLOR,
      value: (p) => p.unexplained,
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
    ctx.restore();
  }
}
