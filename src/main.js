import { Device, SmartMeter, Simulation, MINUTES_PER_DAY } from "./simulation.js";
import { HouseView } from "./view.js";
import { drawChart } from "./chart.js";
import { initThemeSwitch } from "./theme.js";
import { FhmmDisaggregator, NilmMetrics } from "./disaggregation.js";
import { NilmView } from "./nilm-view.js";
import { initZoom } from "./zoom.js";

initThemeSwitch(document.getElementById("theme-switch"));
initZoom(document.querySelector("main"));

const MAX_STEP_MINUTES = 1; // simulation resolution per step
const LIVE_WINDOW_MINUTES = 60; // range of the live chart

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.json();
}

async function loadData() {
  const [data, library] = await Promise.all([fetchJson("data/devices.json"), fetchJson("data/appliance-library.json")]);
  return {
    devices: data.devices.map((d) => new Device(d)),
    layout: { house: data.house, meter: data.meter },
    library,
  };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function formatTime(minuteOfDay) {
  const h = Math.floor(minuteOfDay / 60);
  const m = Math.floor(minuteOfDay % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Formats the meter reading like a mechanical counter: 00012.345 */
function formatReading(kWh) {
  const [whole, fraction] = kWh.toFixed(3).split(".");
  return `${whole.padStart(5, "0")}.${fraction}`;
}

function buildDeviceList(container, devices) {
  for (const device of devices) {
    const label = document.createElement("label");
    label.className = "device-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = device.enabled;
    input.addEventListener("change", () => (device.enabled = input.checked));
    label.append(input, ` ${device.name}`);
    container.appendChild(label);
  }
}

async function start() {
  const { devices, layout, library } = await loadData();
  const meter = new SmartMeter();
  const sim = new Simulation(devices, meter);
  const view = new HouseView(document.getElementById("house"), devices, layout);

  const $ = (id) => document.getElementById(id);
  const playButton = $("play");
  const speedSelect = $("speed");

  buildDeviceList($("devices"), devices);

  // Load disaggregation: fed with every new smart meter record (one per minute).
  const nilm = new FhmmDisaggregator(library);
  const metrics = new NilmMetrics();
  const nilmView = new NilmView($("nilm"), nilm.appliances);
  let lastFedMinute = -Infinity;

  function feedDisaggregation() {
    const records = meter.records;
    let i = records.length;
    while (i > 0 && records[i - 1].t > lastFedMinute) i--;
    let latest = null;
    for (; i < records.length; i++) {
      const record = records[i];
      const result = nilm.update(record.watts);
      const truth = sim.truth.get(record.t);
      if (truth) metrics.add(record.t, result, truth);
      nilmView.push(record.t, result, truth);
      lastFedMinute = record.t;
      latest = { result, truth };
    }
    if (latest) nilmView.update(latest.result, latest.truth, metrics, nilm.lastUpdateMs);
  }

  let playing = true;
  function setPlaying(value) {
    playing = value;
    playButton.textContent = playing ? "Pause" : "Play";
    $("live-badge").classList.toggle("paused", !playing);
    if (playing) nilmView.clearSelection(); // resuming returns to the live view
  }
  playButton.addEventListener("click", () => setPlaying(!playing));
  // Clicking into the disaggregation chart pauses the program; Play resumes.
  nilmView.onSelect = () => setPlaying(false);

  const CHART_HINTS = {
    live: "last 60 min · 1-minute resolution",
    day: "00:00 – 24:00 · 1-minute resolution",
  };
  let chartRange = "live";
  const tabs = document.querySelectorAll(".segmented button");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      chartRange = tab.dataset.range;
      for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
      $("chart-hint").textContent = CHART_HINTS[chartRange];
    });
  }

  sim.step(0);
  let last = performance.now();

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    if (playing) {
      let minutes = dt * Number(speedSelect.value); // simulated minutes per real second
      while (minutes > 0) {
        const step = Math.min(minutes, MAX_STEP_MINUTES);
        sim.step(step);
        minutes -= step;
      }
    }

    feedDisaggregation();
    view.render(playing ? dt : 0, meter.total);

    setText($("clock"), formatTime(sim.minuteOfDay));
    setText($("day"), `Day ${sim.day}`);
    setText($("total"), Math.round(meter.total).toLocaleString("en-US"));
    setText($("energy"), meter.energyKWh.toFixed(2));
    setText($("peak"), Math.round(meter.peakW).toLocaleString("en-US"));
    setText($("reading"), formatReading(meter.readingKWh));

    const live = { t: sim.time, watts: meter.total };
    const range =
      chartRange === "live"
        ? { from: sim.time - LIVE_WINDOW_MINUTES, to: sim.time, tickEvery: 15 }
        : { from: sim.dayStart, to: sim.dayStart + MINUTES_PER_DAY, tickEvery: 180 };
    drawChart($("chart"), {
      records: meter.records,
      live,
      now: chartRange === "day" ? sim.time : undefined,
      marker: nilmView.selectedT,
      ...range,
    });
    nilmView.draw(range);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

start().catch((error) => {
  document.getElementById("error").textContent = error.message;
  console.error(error);
});
