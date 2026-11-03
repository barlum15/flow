import { Device, SmartMeter, Simulation, MINUTES_PER_DAY } from "./simulation.js";
import { HouseView } from "./view.js";
import { drawChart } from "./chart.js";
import { initThemeSwitch } from "./theme.js";
import { FhmmDisaggregator, NilmMetrics } from "./disaggregation.js";
import { NilmView } from "./nilm-view.js";
import { initZoom } from "./zoom.js";
import { MockSource, RecordedSource } from "./data-source.js";

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
  const [data, library, recorded] = await Promise.all([
    fetchJson("data/devices.json"),
    fetchJson("data/appliance-library.json"),
    RecordedSource.load(), // null when data/real/ holds no imported data
  ]);
  return {
    devices: data.devices.map((d) => new Device(d)),
    layout: { house: data.house, meter: data.meter },
    library,
    recorded,
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

function buildDeviceList(container, devices, onChange) {
  const inputs = new Map();
  for (const device of devices) {
    const label = document.createElement("label");
    label.className = "device-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = device.enabled;
    input.addEventListener("change", () => {
      device.enabled = input.checked;
      onChange();
    });
    label.append(input, ` ${device.name}`);
    container.appendChild(label);
    inputs.set(device.id, { label, input });
  }
  return inputs;
}

async function start() {
  const { devices, layout, library, recorded } = await loadData();
  const sources = { mock: new MockSource(), ...(recorded ? { recorded } : {}) };
  const view = new HouseView(document.getElementById("house"), devices, layout);

  const $ = (id) => document.getElementById(id);
  const playButton = $("play");
  const speedSelect = $("speed");
  const sourceSelect = $("source-select");
  const dateJump = $("date-jump");
  const repeatDay = $("repeat-day");
  const repeatToggle = $("repeat-toggle");

  const toggles = buildDeviceList($("devices"), devices, () => rebuildDisaggregation());
  const nilmView = new NilmView($("nilm"), []);

  // Everything that depends on the data source and the start time. Rebuilt
  // when the source changes or when jumping to another recorded day.
  let source, meter, sim, nilm, metrics, lastFedMinute;

  function run(nextSource, startTime = nextSource.startTime) {
    source = nextSource;
    meter = new SmartMeter();
    sim = new Simulation(devices, meter, source, { startTime });
    metrics = new NilmMetrics();
    lastFedMinute = -Infinity;
    nilmView.reset();

    // Devices without recorded data stay off in recorded mode.
    for (const device of devices) {
      const { label, input } = toggles.get(device.id);
      const available = source.hasDevice(device.id);
      device.enabled = available;
      input.checked = available;
      input.disabled = !available;
      label.classList.toggle("no-data", !available);
      label.title = available ? "" : "No recorded data for this device";
    }

    dateJump.hidden = source.kind !== "recorded";
    repeatDay.hidden = source.kind !== "recorded";
    repeatToggle.checked = Boolean(source.repeating);
    if (source.kind === "recorded") {
      dateJump.min = source.manifest.start;
      dateJump.max = source.manifest.end;
    }
    source.prefetch(sim.time);
    rebuildDisaggregation();
  }

  // The disaggregation only models (and lists) the appliances that are
  // switched on in the house. Changing the selection restarts the filter;
  // it settles again within a few readings.
  function rebuildDisaggregation() {
    const active = devices.filter((d) => d.enabled).map((d) => d.id);
    nilm = new FhmmDisaggregator(library, { only: active });
    nilmView.setAppliances(nilm.appliances);
  }

  // Data source selection
  if (recorded) {
    const option = document.createElement("option");
    option.value = "recorded";
    option.textContent = `${recorded.label} (${recorded.range})`;
    sourceSelect.append(option);
    sourceSelect.value = "recorded"; // real data wins when it exists
  } else {
    sourceSelect.disabled = true;
    sourceSelect.closest("label").title =
      "No recorded data found in data/real/. Convert your .h5 files with tools/import_h5.py.";
  }
  sourceSelect.addEventListener("change", () => run(sources[sourceSelect.value]));
  dateJump.addEventListener("change", () => {
    const index = source.days?.indexOf(dateJump.value);
    if (index >= 0) {
      source.jumpTo(index); // the chosen day becomes simulation day 1
      run(source, 6 * 60);
    }
  });
  // "Repeat day": after midnight the same recorded day starts again.
  repeatToggle.addEventListener("change", () => source.setRepeat?.(sim.day - 1, repeatToggle.checked));

  run(sources[sourceSelect.value]);

  // Load disaggregation: fed with every new smart meter record (one per minute).
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

  // The smart meter chart works the same way and shares the selected minute,
  // so both panels always show the same point in time.
  const meterCanvas = $("chart");
  let meterLayout = null;
  meterCanvas.addEventListener("click", (event) => {
    if (!meterLayout) return;
    const { from, to, left, width } = meterLayout;
    if (event.offsetX < left || event.offsetX > left + width) return;
    nilmView.select(Math.floor(from + ((event.offsetX - left) / width) * (to - from)));
  });
  meterCanvas.addEventListener("keydown", (event) => {
    if (nilmView.selectedT === null || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    nilmView.select(nilmView.selectedT + (event.key === "ArrowLeft" ? -1 : 1));
  });

  const CHART_HINTS = {
    live: "last 60 min · 1-minute resolution",
    day: "00:00 – 24:00 · 1-minute resolution",
  };
  let chartRange = "day"; // default view: the whole day
  const tabs = document.querySelectorAll(".segmented button");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      chartRange = tab.dataset.range;
      for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
      $("chart-hint").textContent = CHART_HINTS[chartRange];
    });
  }

  let last = performance.now();

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    let waiting = false;
    if (playing) {
      let minutes = dt * Number(speedSelect.value); // simulated minutes per real second
      while (minutes > 0) {
        // Recorded days are loaded on demand; wait until the current one is there.
        source.prefetch(sim.time);
        if (!source.isReady(sim.time)) {
          waiting = true;
          break;
        }
        const step = Math.min(minutes, MAX_STEP_MINUTES);
        sim.step(step);
        minutes -= step;
      }
    }

    feedDisaggregation();
    view.render(playing && !waiting ? dt : 0, meter.total);

    const dayIndex = sim.day - 1;
    setText($("clock"), formatTime(sim.minuteOfDay));
    const dayText = source.repeating ? `${source.dayLabel(dayIndex)} · run ${sim.day}` : source.dayLabel(dayIndex);
    setText($("day"), waiting ? "Loading…" : dayText);
    if (source.kind === "recorded" && document.activeElement !== dateJump) dateJump.value = source.dateOf(dayIndex);
    // While a minute is selected, the readout shows the power of that minute.
    const selected = nilmView.selectedT !== null ? nilmView.entryAt(nilmView.selectedT) : null;
    setText($("power-label"), selected ? `Power at ${formatTime(selected.t % MINUTES_PER_DAY)}` : "Current power");
    setText($("total"), Math.round(selected ? selected.total : meter.total).toLocaleString("en-US"));
    setText($("energy"), meter.energyKWh.toFixed(2));
    setText($("peak"), Math.round(meter.peakW).toLocaleString("en-US"));
    setText($("reading"), formatReading(meter.readingKWh));

    const live = { t: sim.time, watts: meter.total };
    const range =
      chartRange === "live"
        ? { from: sim.time - LIVE_WINDOW_MINUTES, to: sim.time, tickEvery: 15 }
        : { from: sim.dayStart, to: sim.dayStart + MINUTES_PER_DAY, tickEvery: 180 };
    meterLayout = drawChart(meterCanvas, {
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
