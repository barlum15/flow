// Small canvas line chart of the totals recorded by the smart meter.

export function drawChart(canvas, records, currentMinute) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const styles = getComputedStyle(document.documentElement);
  const axis = styles.getPropertyValue("--muted").trim();
  const line = styles.getPropertyValue("--energy").trim();

  const pad = { left: 56, right: 20, top: 12, bottom: 24 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const maxWatts = Math.max(1000, ...records.map((r) => r.watts)) * 1.1;

  const x = (minute) => pad.left + (minute / 1440) * w;
  const y = (watts) => pad.top + h - (watts / maxWatts) * h;

  // Axes and labels
  ctx.strokeStyle = axis;
  ctx.fillStyle = axis;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui, sans-serif";
  for (let hour = 0; hour <= 24; hour += 6) {
    ctx.beginPath();
    ctx.moveTo(x(hour * 60), pad.top);
    ctx.lineTo(x(hour * 60), pad.top + h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "center";
  for (let hour = 0; hour <= 24; hour += 6) ctx.fillText(`${hour}:00`, x(hour * 60), height - 6);
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(maxWatts)} W`, pad.left - 6, pad.top + 10);
  ctx.fillText("0", pad.left - 6, pad.top + h);

  // Current time marker
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(x(currentMinute), pad.top);
  ctx.lineTo(x(currentMinute), pad.top + h);
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (records.length < 2) return;

  // Recorded totals
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  records.forEach((r, i) => (i === 0 ? ctx.moveTo(x(r.minute), y(r.watts)) : ctx.lineTo(x(r.minute), y(r.watts))));
  ctx.stroke();
}
