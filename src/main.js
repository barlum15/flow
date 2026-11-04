import { Device, SmartMeter, Simulation, MINUTES_PER_DAY } from "./simulation.js";
import { HouseView } from "./view.js";
import { drawChart } from "./chart.js";
import { initThemeSwitch } from "./theme.js";
import { FhmmDisaggregator, NilmMetrics } from "./disaggregation.js";
import { NilmView } from "./nilm-view.js";
import { initZoom } from "./zoom.js";
import { MockSource, RecordedSource } from "./data-source.js";
import { TimeZoom, wasDrag } from "./chart-zoom.js";
import { loadExternalModels, requestDisaggregation, toResults } from "./external-models.js";

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
  const [data, library, recorded, evaluation] = await Promise.all([
    fetchJson("data/devices.json"),
    fetchJson("data/appliance-library.json"),
    RecordedSource.load(), // null when data/real/ holds no imported data
    fetchJson("data/evaluation.json").catch(() => ({ periods: [] })),
  ]);
  return {
    evaluation,
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
  const { devices, layout, library, recorded, evaluation } = await loadData();
  const external = await loadExternalModels(); // models served by tools/serve.py, if configured

  /** Training / gap / test period of a date (YYYY-MM-DD), or null. */
  const periodOf = (date) => evaluation.periods.find((p) => date >= p.start && date <= p.end) ?? null;
  const sources = { mock: new MockSource(), ...(recorded ? { recorded } : {}) };
  const view = new HouseView(document.getElementById("house"), devices, layout);

  const $ = (id) => document.getElementById(id);
  const playButton = $("play");
  const speedSelect = $("speed");

  // Speed is a time-lapse factor. The open list explains each step
  // ("600× · 1 s = 10 min"), the closed field shows only "600×".
  const speedLabels = (long) => {
    for (const option of speedSelect.options) {
      option.textContent = long ? option.dataset.long : `${option.value}×`;
    }
  };
  speedSelect.addEventListener("mousedown", () => speedLabels(true));
  speedSelect.addEventListener("keydown", () => speedLabels(true));
  speedSelect.addEventListener("change", () => speedLabels(false));
  speedSelect.addEventListener("blur", () => speedLabels(false));
  const sourceSelect = $("source-select");
  const dateJump = $("date-jump");
  const repeatDay = $("repeat-day");
  const repeatToggle = $("repeat-toggle");

  const toggles = buildDeviceList($("devices"), devices, () => scheduleRecompute());
  const nilmView = new NilmView($("nilm"), []);

  // Everything that depends on the data source and the start time. Rebuilt
  // when the source changes or when jumping to another recorded day.
  let source, meter, sim, nilm, metrics, metricsDay, lastFedMinute;

  // ---- Disaggregation model: built-in FHMM (in the browser) or an external one ----
  const modelSelect = $("model-select");
  const modelsById = Object.fromEntries(external.models.map((m) => [m.id, m]));
  let model = null; // null = built-in FHMM
  let ext = { busy: false, sentLastT: null, sentAt: 0, error: null, token: 0, notice: null };

  const BUILTIN_SUBTITLE = $("nilm-subtitle").textContent.trim();
  const applianceInfo = (id) => {
    const a = library.appliances.find((x) => x.id === id);
    return { id, name: a?.name ?? id, color: a?.color ?? "#8a93a3" };
  };

  // Model list, grouped as in the framework; models that cannot run are disabled.
  {
    const groups = new Map();
    for (const m of external.models) {
      if (!groups.has(m.group)) {
        const group = document.createElement("optgroup");
        group.label = m.group || "External models";
        groups.set(m.group, group);
        modelSelect.append(group);
      }
      const option = document.createElement("option");
      option.value = m.id;
      groups.get(m.group).append(option);
    }
    modelSelect.title = external.available
      ? "Built-in model or a trained model from the local model server"
      : `Only the built-in model: ${external.reason || "no model server"} (see README, External NILM Models)`;
  }

  function refreshModelOptions() {
    for (const option of modelSelect.options) {
      const m = modelsById[option.value];
      if (!m) continue;
      const needsQ = m.needsReactive && !source.hasReactive;
      option.disabled = m.available === false || needsQ;
      option.textContent = m.name + (m.available === false ? " (not available)" : needsQ ? " (needs reactive power)" : "");
      option.title = m.available === false ? m.reason || "" : needsQ ? "Needs recorded data with reactive power" : "";
    }
    if (model && model.needsReactive && !source.hasReactive) {
      ext.notice = `${model.name} needs reactive power, which this data source does not have - switched to the built-in model.`;
      model = null;
      modelSelect.value = "";
    }
  }

  /** Prepares the table for the current model (called whenever the simulation restarts). */
  function setupEngine() {
    if (!model) {
      rebuildDisaggregation();
      return;
    }
    nilm = null;
    const notInHouse = new Set(devices.filter((d) => !d.enabled).map((d) => d.id));
    nilmView.setAppliances(model.devices.map(applianceInfo), { notInHouse, thresholds: model.thresholds ?? {} });
    ext = { ...ext, busy: false, sentLastT: null, error: null, token: ext.token + 1 };
  }

  /** Date (YYYY-MM-DD) of a simulation day, as the model server expects it. */
  function dateOfDay(dayIndex) {
    if (source.kind === "recorded") return source.dateOf(dayIndex);
    return new Date(Date.UTC(2019, 10, 4 + dayIndex)).toISOString().slice(0, 10); // mock data: any date
  }

  // External models re-estimate the whole day at once (window models and
  // Viterbi decoding may still change earlier minutes), at most about once per
  // second and never while the day is being recalculated.
  function maybeRequestExternal() {
    if (!model || recompute || ext.busy) return;
    const records = meter.records;
    if (!records.length) return;
    const lastT = records[records.length - 1].t;
    if (lastT === ext.sentLastT || performance.now() - ext.sentAt < 1000) return;

    const window = Math.max(1, model.window ?? 1);
    const dayStart = lastT - (lastT % MINUTES_PER_DAY);
    const send = records.filter((r) => r.t >= dayStart - window); // a little of the previous day to fill windows
    const token = ext.token;
    ext.busy = true;
    ext.sentAt = performance.now();
    ext.sentLastT = lastT;
    requestDisaggregation(model, send, {
      dateOfDay,
      timezone: source.manifest?.timezone ?? "Europe/Zurich",
      withReactive: source.hasReactive,
    })
      .then((answer) => {
        if (token !== ext.token) return; // model or day changed meanwhile
        ext.error = null;
        applyExternal(answer, send);
      })
      .catch((error) => {
        if (token === ext.token) ext.error = error.message;
      })
      .finally(() => {
        if (token === ext.token) ext.busy = false;
      });
  }

  function applyExternal(answer, send) {
    const results = toResults(model, answer, send, model.devices.map(applianceInfo));
    const lastT = send[send.length - 1].t;
    const dayStart = lastT - (lastT % MINUTES_PER_DAY);
    // Window models estimate the middle of their window: the latest minutes are provisional.
    const provisionalFrom = model.center ? lastT - Math.floor((model.window ?? 1) / 2) + 1 : null;

    metrics = new NilmMetrics({ thresholds: model.thresholds ?? {} });
    const entries = [];
    send.forEach((record, i) => {
      if (record.t < dayStart) return; // warm-up minutes of the previous day
      const truth = sim.truth.get(record.t);
      if (truth && (provisionalFrom === null || record.t < provisionalFrom)) metrics.add(record.t, results[i], truth);
      entries.push({ t: record.t, result: results[i], truth, vars: record.vars });
    });
    nilmView.replaceHistory(entries, provisionalFrom);
    const last = entries[entries.length - 1];
    if (last) nilmView.update(last.result, last.truth, metrics, answer.ms ?? 0);
  }

  modelSelect.addEventListener("change", () => {
    model = modelsById[modelSelect.value] ?? null;
    ext.notice = null;
    if (model) {
      setupEngine(); // results arrive with the next answer of the model server
    } else {
      startRecompute(); // the built-in model has to run through the day again
    }
  });

  /**
   * (Re)starts the simulation. `keepSelection` keeps the devices the user has
   * switched on or off (used when the day is recalculated).
   */
  function run(nextSource, startTime = nextSource.startTime, { keepSelection = false } = {}) {
    source = nextSource;
    meter = new SmartMeter();
    sim = new Simulation(devices, meter, source, { startTime });
    metrics = new NilmMetrics();
    metricsDay = null;
    lastFedMinute = -Infinity;
    nilmView.reset();

    // Devices without recorded data stay off in recorded mode.
    for (const device of devices) {
      const { label, input } = toggles.get(device.id);
      const available = source.hasDevice(device.id);
      device.enabled = keepSelection ? device.enabled && available : available;
      input.checked = device.enabled;
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
    refreshModelOptions();
    setupEngine();
  }

  // The disaggregation only models (and lists) the appliances that are
  // switched on in the house.
  function rebuildDisaggregation() {
    const active = devices.filter((d) => d.enabled).map((d) => d.id);
    nilm = new FhmmDisaggregator(library, { only: active });
    nilmView.setAppliances(nilm.appliances);
    nilmView.provisionalFrom = null;
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
  // Changing the device selection recalculates the current day from 00:00 up
  // to the current time, so the smart meter, the house, the disaggregation and
  // all key figures refer to the selected devices only. Several clicks in a
  // row cause one recalculation; it runs in slices so the page stays fluid.
  let recompute = null; // { target, selected, readingBase }
  let lastFed = null; // latest disaggregation result, for refreshing the key figures
  let recomputeTimer = null;

  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(startRecompute, 300);
  }

  function startRecompute() {
    const target = recompute ? recompute.target : sim.time;
    const selected = recompute ? recompute.selected : nilmView.selectedT;
    // Keep the meter reading of the previous days; only today is recalculated.
    const readingBase = recompute ? recompute.readingBase : meter.readingKWh - meter.energyKWh;
    run(source, target - (target % MINUTES_PER_DAY), { keepSelection: true });
    meter.readingKWh = readingBase;
    recompute = { target, selected, readingBase };
  }

  /** Advances the recalculation for at most `budgetMs`; returns true when it is done. */
  function continueRecompute(budgetMs) {
    const deadline = performance.now() + budgetMs;
    while (sim.time < recompute.target && performance.now() < deadline) {
      source.prefetch(sim.time);
      if (!source.isReady(sim.time)) return false;
      sim.step(Math.min(MAX_STEP_MINUTES, recompute.target - sim.time));
      feedDisaggregation({ render: false });
    }
    if (sim.time < recompute.target) return false;
    feedDisaggregation();
    if (!model && lastFed) nilmView.update(lastFed.result, lastFed.truth, metrics, nilm.lastUpdateMs); // fresh key figures
    if (recompute.selected !== null) nilmView.select(recompute.selected);
    recompute = null;
    return true;
  }

  function feedDisaggregation({ render = true } = {}) {
    if (model) return; // external models are asked for the whole day instead (maybeRequestExternal)
    const records = meter.records;
    let i = records.length;
    while (i > 0 && records[i - 1].t > lastFedMinute) i--;
    let latest = null;
    for (; i < records.length; i++) {
      const record = records[i];
      const result = nilm.update(record.watts);
      const truth = sim.truth.get(record.t);
      // Key figures refer to the current day: start fresh at midnight.
      const day = Math.floor(record.t / MINUTES_PER_DAY);
      if (day !== metricsDay) {
        metrics = new NilmMetrics();
        metricsDay = day;
      }
      if (truth) metrics.add(record.t, result, truth);
      nilmView.push(record.t, result, truth, record.vars);
      lastFedMinute = record.t;
      latest = { result, truth };
      lastFed = latest;
    }
    if (latest && render) nilmView.update(latest.result, latest.truth, metrics, nilm.lastUpdateMs);
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
    if (!meterLayout || wasDrag(meterCanvas)) return;
    const { from, to, left, width } = meterLayout;
    if (event.offsetX < left || event.offsetX > left + width) return;
    nilmView.select(Math.floor(from + ((event.offsetX - left) / width) * (to - from)));
  });
  // Shared time zoom: zooming or dragging in one chart changes both.
  const timeZoom = new TimeZoom();
  timeZoom.attach(meterCanvas, () => meterLayout);
  timeZoom.attach(nilmView.canvas, () => nilmView.layout);
  for (const bar of document.querySelectorAll(".time-zoom")) timeZoom.attachButtons(bar);

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
      timeZoom.reset(); // a new range starts unzoomed
      for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
      $("chart-hint").textContent = CHART_HINTS[chartRange];
    });
  }

  const dayIndexNow = () => sim.day - 1;

  /** Subtitle, status and notices of the disaggregation panel. */
  function updateModelInfo(dayIndex) {
    setText($("nilm-subtitle"), model ? `${model.name} · ${model.group} · ${model.trained ? "trained model, " : ""}computed by the local model server` : BUILTIN_SUBTITLE);
    setText($("model-status"), !model ? "" : ext.busy ? "computing…" : ext.error ? "error" : "");

    const notices = [];
    if (ext.notice) notices.push(ext.notice);
    if (model && ext.error) notices.push(`Model error: ${ext.error}`);
    if (model?.trained && source.kind === "recorded" && periodOf(source.dateOf(dayIndex))?.kind === "train") {
      notices.push("This model saw this day in training - its accuracy here is optimistic. Test days give a fair picture.");
    }
    if (model?.center && model.window > 1) {
      notices.push(`Window model: the last ${Math.floor(model.window / 2)} minutes are provisional and are re-estimated as new readings arrive.`);
    }
    if (model && devices.some((d) => !d.enabled && model.devices.includes(d.id))) {
      notices.push("Devices switched off in the house are still estimated by this model (shown as \"not in house\").");
    }
    const notice = $("nilm-notice");
    notice.hidden = notices.length === 0;
    setText(notice, notices.join(" "));
  }

  let last = performance.now();

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    let waiting = false;
    if (recompute) {
      continueRecompute(25); // a slice of the recalculation per frame
    } else if (playing) {
      let minutes = (dt * Number(speedSelect.value)) / 60; // time-lapse factor -> simulated minutes
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
    maybeRequestExternal();
    updateModelInfo(dayIndexNow());

    // While a minute is selected, the house shows the actual device power of
    // that minute, with the balls flowing at that minute's rate; otherwise the
    // live values.
    const selected = nilmView.selectedT !== null ? nilmView.entryAt(nilmView.selectedT) : null;
    if (selected) {
      view.render(dt, selected.total, { key: selected.t, powers: selected.truth });
    } else {
      view.render(playing && !waiting ? dt : 0, meter.total);
    }
    $("house-snapshot").hidden = !selected;
    if (selected) setText($("house-snapshot-time"), formatTime(selected.t % MINUTES_PER_DAY));

    const dayIndex = sim.day - 1;
    setText($("clock"), formatTime(sim.minuteOfDay));
    const dayText = source.repeating ? `${source.dayLabel(dayIndex)} · run ${sim.day}` : source.dayLabel(dayIndex);
    const recalculating = recompute
      ? `Recalculating… ${Math.round((100 * (sim.time % MINUTES_PER_DAY)) / Math.max(1, recompute.target % MINUTES_PER_DAY))} %`
      : null;
    setText($("day"), recalculating ?? (waiting ? "Loading…" : dayText));
    if (source.kind === "recorded" && document.activeElement !== dateJump) dateJump.value = source.dateOf(dayIndex);

    // Training / gap / test day of the external NILM models (recorded data only).
    const period = source.kind === "recorded" ? periodOf(source.dateOf(dayIndex)) : null;
    const splitBadge = $("split-badge");
    splitBadge.hidden = !period;
    if (period) {
      setText(splitBadge, period.label);
      splitBadge.className = `split-badge split-${period.kind}`;
      splitBadge.title =
        period.kind === "train"
          ? `Trained models saw this day (training ${period.start} – ${period.end}): their accuracy here is optimistic.`
          : period.kind === "test"
            ? `Test period ${period.start} – ${period.end}: not seen in training, a fair evaluation.`
            : `Gap between training and test (${period.start} – ${period.end}).`;
    }
    // While a minute is selected, the readout shows the power of that minute.
    setText($("power-label"), selected ? `Power at ${formatTime(selected.t % MINUTES_PER_DAY)}` : "Current power");
    setText($("total"), Math.round(selected ? selected.total : meter.total).toLocaleString("en-US"));
    $("reactive-stat").hidden = !source.hasReactive;
    if (source.hasReactive) {
      setText($("reactive"), Math.round(selected ? selected.vars : meter.totalReactive).toLocaleString("en-US"));
    }
    setText($("energy"), meter.energyKWh.toFixed(2));
    setText($("peak"), Math.round(meter.peakW).toLocaleString("en-US"));
    setText($("reading"), formatReading(meter.readingKWh));

    const live = { t: sim.time, watts: meter.total };
    const base =
      chartRange === "live"
        ? { from: sim.time - LIVE_WINDOW_MINUTES, to: sim.time }
        : { from: sim.dayStart, to: sim.dayStart + MINUTES_PER_DAY };
    const range = timeZoom.apply(base); // the same zoomed window for both charts
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
