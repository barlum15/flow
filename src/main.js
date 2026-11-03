import { Device, SmartMeter, Simulation } from "./simulation.js";
import { HouseView } from "./view.js";
import { drawChart } from "./chart.js";

const MAX_STEP_MINUTES = 1; // simulation resolution per step

async function loadData() {
  const response = await fetch("data/devices.json");
  if (!response.ok) throw new Error(`Could not load devices (${response.status})`);
  const data = await response.json();
  return {
    devices: data.devices.map((d) => new Device(d)),
    layout: { house: data.house, meter: data.meter },
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
  const { devices, layout } = await loadData();
  const meter = new SmartMeter();
  const sim = new Simulation(devices, meter);
  const view = new HouseView(document.getElementById("house"), devices, layout);

  const clock = document.getElementById("clock");
  const day = document.getElementById("day");
  const total = document.getElementById("total");
  const energy = document.getElementById("energy");
  const chart = document.getElementById("chart");
  const playButton = document.getElementById("play");
  const speedSelect = document.getElementById("speed");

  buildDeviceList(document.getElementById("devices"), devices);

  let playing = true;
  playButton.addEventListener("click", () => {
    playing = !playing;
    playButton.textContent = playing ? "Pause" : "Play";
  });

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

    view.render(playing ? dt : 0, meter.total);
    setText(clock, formatTime(sim.minuteOfDay));
    setText(day, `Day ${sim.day}`);
    setText(total, `${Math.round(meter.total)} W`);
    setText(energy, `${meter.energyKWh.toFixed(2)} kWh`);
    drawChart(chart, meter.records, sim.minuteOfDay);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

start().catch((error) => {
  document.getElementById("error").textContent = error.message;
  console.error(error);
});
