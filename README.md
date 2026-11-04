# Enerlyza

**Enerlyza** is an interactive visualization of electricity consumption in a household.

> Status: first prototype.

## Idea

A house contains several electrical devices (AHU, coffee maker, dishwasher, electric stove, fridge, tumble dryer, washing machine, TV, lighting). Every device is connected to a central **smart meter** by a cable.

- **Devices** have a stored **consumption curve** (power over time) in a database in the background.
- When a device needs electricity, it **requests** that consumption from the smart meter.
- The flow of electricity is visualized: **yellow balls travel through the cable** from the smart meter to the device, because the device draws the electricity. The more power a device draws, the more (or faster) balls flow.
- The **smart meter only sees the sum**. It does not know which device consumed what. It records the aggregated total consumption over time and stores it.

This shows how individual devices add up to the single total that a real smart meter measures.

## Core Concepts

| Concept | Role |
| --- | --- |
| Device | Has a consumption curve; requests power from the smart meter |
| Cable | Connects a device to the smart meter; shows the flow as animated yellow balls |
| Smart meter | Receives all requests, sums them up, and stores only the total |
| Database | Holds the devices' consumption curves and the smart meter's recorded totals |

## Possible Features

- Visual house layout with devices, cables and the smart meter
- Animation speed / ball density proportional to the current power draw
- Simulated time with play / pause / speed controls
- Live display of the current total at the smart meter
- Chart of the recorded total consumption over time
- Add, remove and configure devices and their consumption curves

## Tech Stack

Enerlyza is a **web app** that runs in any browser and also locally on your own machine.

**Prototype (current):**

- Plain HTML, CSS and JavaScript (ES modules), no build step, no dependencies
- Isometric SVG view of the house (rooms, walls, devices, cables and animated balls); Canvas for the consumption chart
- `data/devices.json` acts as the database for the floor plan, the devices' 3D shapes and their consumption curves
- The smart meter keeps its recorded totals in memory

**Planned next step:**

- A small backend (Node.js) with a real database (SQLite) for device curves and the smart meter's recorded totals
- Optionally TypeScript and a build tool (Vite) once the project grows

## Getting Started

```bash
git clone https://github.com/barlum15/flow.git
cd flow
python3 tools/serve.py
```

Windows:

```bash
py tools\serve.py
```

Then open http://localhost:8000 in your browser. A local web server is needed because browsers block loading `data/devices.json` from `file://`.

`tools/serve.py` tells the browser not to cache any file, so a normal reload always shows the latest changes. With `python -m http.server` the browser may keep old JavaScript and CSS files: changes then only appear in a private window or after a hard reload (Ctrl+Shift+R, on macOS Cmd+Shift+R). If an old version still shows up once, do one hard reload or clear the cached files for localhost.

## Project Structure

| Path | Purpose |
| --- | --- |
| `index.html` | Page layout and controls |
| `src/simulation.js` | Devices, smart meter and simulated clock |
| `src/view.js` | Isometric SVG rendering of the house, devices, cables and the yellow balls |
| `src/chart.js` | Live and daily charts of the totals recorded by the smart meter |
| `src/main.js` | Loads data and runs the animation loop |
| `src/theme.js` | Light/dark mode switch |
| `src/zoom.js` | Zoom into a single panel and back to the overview |
| `src/external-models.js` | Talks to the model server and converts its answers for the table |
| `src/chart-zoom.js` | Shared time-axis zoom of the smart meter and disaggregation charts |
| `src/data-source.js` | Data sources: mock curves or recorded data from `data/real/` |
| `tools/serve.py` | Local web server (no browser caching) and API for external NILM models |
| `tools/nilm_adapter_demo.py` | Demo models for testing the model API |
| `tools/nilm_adapter_template.py` | Template adapter for the local NILM framework |
| `tools/import_h5.py` | Converts recorded `.h5` files into `data/real/` (local only, never committed) |
| `.gitignore` | Keeps `data/real/` and all `.h5` files out of the repository |
| `src/disaggregation.js` | FHMM load disaggregation and accuracy metrics |
| `src/nilm-view.js` | Load disaggregation panel (table and stacked chart) |
| `src/style.css` | Styling (light and dark mode) |
| `data/appliance-library.json` | Appliance library for the disaggregation (power states, spread, durations, transitions) |
| `data/evaluation.json` | Training / gap / test periods of the external NILM models |
| `data/devices.json` | Floor plan, smart meter position and devices (shape, plug position, daily consumption curve in watts) |

## How the Prototype Works

1. A simulated clock runs through the day. *Speed* is a time-lapse factor: 1× (real time), 60× (1 s = 1 min), 600× (1 s = 10 min, default) or 3600× (1 s = 1 h).
2. On every step, each device looks up its current power in its consumption curve and **requests** it from the smart meter.
3. The smart meter **only adds up** the requested watts. It never knows which device asked. Every simulated minute it stores the average total of that minute (1-minute resolution).
4. Each cable shows yellow balls flowing from the smart meter to the device that draws the power; more power means more balls. Every device that is on gets at least a few balls, so small loads (e.g. the AHU at 45 W) stay visible.
5. Devices can be switched off below the house to see how the total changes.

### Smart Meter Display

- **Current power** as a large live value, plus energy today, peak today and the meter reading (total kWh since start, like a real counter)
- **Chart** with two ranges, switchable above the chart (default: Today):
  - **Live**: scrolling view of the last 60 simulated minutes with the current value as the newest point
  - **Today**: the whole day from 00:00 to 24:00 at 1-minute resolution with a marker for the current time
- The meter keeps the last two simulated days of records

### Load Disaggregation

Next to the house and the smart meter, a panel estimates which appliances are running, using **only the smart meter readings** (one total value per minute). This is known as load disaggregation or NILM (non-intrusive load monitoring).

**Algorithm: Factorial Hidden Markov Model (FHMM) with an online forward filter** (`src/disaggregation.js`)

- Every appliance is a small Markov chain over its power states, e.g. washing machine: Off → Heating → Washing → Spinning.
- The reading is modelled as the sum of the state powers of all appliances plus noise.
- After every reading, one filter step updates the probability of every combination of appliance states (38,880 combinations with the nine appliances). From that it derives, per appliance, the probability of being on, the most likely state, and the estimated power with its uncertainty (±).
- The transition step is applied per appliance, so an update takes about 1 ms in the browser.
- The spread of a state is treated as a persistent deviation from the nominal power, not as new noise every minute. Otherwise the model drifts towards whichever explanation has the narrowest spread.

**Only the selected appliances:** the disaggregation models and lists only the appliances that are switched on with the chips below the house. Unchecking e.g. the TV removes it from the table, the chart and the model (the appliance inventory of the house is known, as in real NILM setups). Fewer appliances also mean fewer state combinations, so the estimates get faster and usually more accurate. Changing the selection recalculates the current day from 00:00 up to the current time with only the selected appliances (the day label shows *Recalculating… %*). Afterwards the smart meter curve, the house, the disaggregation, the chart and all key figures refer to the selected appliances only, and the simulation continues where it was. Several clicks in a row cause a single recalculation; earlier days are dropped, the meter reading keeps counting.

**What the algorithm knows:** only `data/appliance-library.json`, a "data sheet" with the typical power states, their spread, typical durations and possible next states. It never sees the consumption curves in `data/devices.json`.

**Display**

- Per appliance: most likely state, probability of being on, estimated power ± uncertainty, and the actual power from the simulation (ground truth, shown in red when on/off was misclassified)
- Residual = measured − sum of all estimates, so appliances + residual always add up to the reading. Positive: consumption that no appliance explains (shown in grey on top of the stacked chart). Negative: the appliances are estimated higher than what the smart meter measured, e.g. because a device runs below its nominal power or the model is unsure whether it is on.
- Model confidence: probability of the most likely combination of states
- On/off accuracy and energy accuracy (1 − Σ|estimate − actual| / (2 · Σ actual)) of the current day (since 00:00)
- Stacked chart of the estimated contributions with the measured total as a dashed line; it follows the Live/Today switch of the smart meter chart

**Zooming the time axis:** the smart meter chart and the *Estimated breakdown* share one time axis. Scroll with the mouse wheel over either chart to zoom in or out around the mouse position, drag to move the visible window, or use the − / + / Reset buttons above each chart. Zooming or moving one chart always does the same to the other. The labels adapt to the visible span (down to 10 minutes); switching between Live and Today resets the zoom.

**Inspecting a point in time:** click into the *Estimated breakdown* chart or into the smart meter chart to look at a specific minute. Both charts share the selection, and the smart meter readout then shows the power of that minute (*Power at 09:29* instead of *Current power*). The house shows the actual power of every device in that minute, with the balls flowing at that minute's rate, so you can compare what really ran (house) with what the disaggregation estimated (table below). The whole program pauses, the table shows the estimates and the actual values of that minute, and both charts mark it. While paused, the arrow keys ← / → step through the minutes. Press **Play** to continue; the table then returns to the live values.

On the simulated placeholder day the model reaches about 86 % on/off accuracy and 64 % energy accuracy. The hardest moments are minutes in which several appliances switch at the same time, or in which different appliances have similar power (e.g. electric stove ~2350 W vs. tumble dryer ~2400 W, dishwasher 1800 W vs. washing machine 2000 W). In such cases the panel splits the probability between the candidates instead of guessing.

### Layout and Theme

- Left column: the house, with the smart meter below it (fixed height of 440 px). Right column: the load disaggregation over the full height, with the table on top and the chart below. On narrow screens all three panels stack. When zoomed, the load disaggregation shows table and chart side by side.
- Every panel (house, smart meter, load disaggregation) has a zoom button in its top-right corner. It shows that panel alone in the whole window; the same button (now labelled *Overview*, with a small grid icon) or the Escape key returns to the overview. The simulation keeps running while zoomed.
- A switch in the header toggles between light and dark mode. Without a saved choice the page follows the system setting; the choice is remembered in the browser.

## Devices

| ID | Name | Room |
| --- | --- | --- |
| `ahu` | AHU (air handling unit / ventilation) | Utility room |
| `coffee_maker` | Coffee maker | Kitchen |
| `dishwasher` | Dishwasher | Kitchen |
| `electric_stove` | Electric stove | Kitchen |
| `fridge` | Fridge | Kitchen |
| `tumble_dryer` | Tumble dryer | Utility room |
| `washing_machine` | Washing machine | Utility room |
| `tv` | TV | Living room |
| `lighting` | Lighting | Living room |

The IDs are the same in `data/devices.json` and `data/appliance-library.json`. The consumption curves are placeholders until real measurements are imported. A curve splits the day into equal steps, so it can have any resolution: 24 values (hourly), 96 (every 15 minutes) or 1440 (every minute).

## Using Recorded Data (.h5)

The app can replay real appliance measurements instead of the mock curves. It was built for the [SmartNIALMeter dataset](https://zenodo.org/records/10875988) (one HDF5 file per appliance, `<type>/building_<x>/<appliance>.h5`, 5-second samples), but works with any pandas HDF5 files that contain a time index and a power column.

> **The recorded data must never be committed or uploaded.** The import writes to `data/real/`, which is listed in `.gitignore` together with `data/raw/` and all `*.h5` files. Everyone converts the data locally.

> **The app does not read `.h5` files directly.** Copying them into `data/raw/` is not enough: run the import script (step 3) first. Only when it has written `data/real/manifest.json` does the recorded data appear in the *Data* selection in the header.

**Folder structure**

```
flow/
├── data/
│   ├── raw/                     ← your original .h5 files (never committed)
│   │   └── building_1/
│   │       ├── ahu.h5
│   │       ├── coffee_maker.h5
│   │       ├── dishwasher.h5
│   │       ├── electric_stove.h5
│   │       ├── fridge.h5
│   │       ├── tumble_dryer.h5
│   │       └── washing_machine.h5
│   ├── real/                    ← written by the import script (never committed)
│   │   ├── manifest.json
│   │   └── days/2019-01-01.json …
│   ├── devices.json             ← floor plan and mock curves (in git)
│   └── appliance-library.json   ← appliance library (in git)
└── tools/import_h5.py
```

The file names decide which device a file belongs to. Use the device IDs above, or keep the original names and map them with `--map original_name=device_id`. The files may also stay anywhere outside the project; just pass that path to the script.

Run all commands in the project folder (`flow`, the repository name). On Windows, use `py` (or `python`) and backslashes in paths, as shown in the Windows blocks.

**1. Install the requirements (once)**

```bash
pip install pandas tables h5py
```

Windows:

```bash
py -m pip install pandas tables h5py
```

**2. Look at the files**

```bash
python tools/import_h5.py --inspect data/raw/building_1
```

Windows:

```bash
py tools\import_h5.py --inspect data\raw\building_1
```

This lists every file with its HDF key, columns, chosen power column(s), first timestamp and sampling interval, and the device ID it maps to.

**3. Convert**

```bash
python tools/import_h5.py data/raw/building_1 --label "SmartNIALMeter building 1"
```

Windows:

```bash
py tools\import_h5.py data\raw\building_1 --label "SmartNIALMeter building 1"
```

At the end the script prints `Wrote … days … to …/data/real/`. Run it again whenever the `.h5` files change; it replaces the earlier import.

- Per-phase active power columns (e.g. `active power L1/L2/L3`) are summed; apparent power is ignored. Use `--column` to choose the active power columns yourself.
- **Reactive power** (`Reactive Power`, var) is exported too when a file has it. The smart meter then sums active **and** reactive power, and the smart meter panel shows *Reactive power*. Several external NILM models need both (see below). Imports made before this change contain active power only: run the import again to add reactive power.
- File names are mapped to device IDs (`fridge_freezer.h5` → `fridge`, …). Use `--map name=id` to override, `--only` to import some devices, `--start`/`--end` to limit the period.
- Samples are averaged per minute and stored per local day (`--timezone`, default `Europe/Zurich`; timestamps without a time zone are read as `--source-tz`, default UTC). On daylight saving days the skipped hour stays empty and the repeated hour is averaged.
- Output: `data/real/manifest.json` and one file per day in `data/real/days/`. The app loads only the days it needs.
- Days at the start or end with less than 6 hours of data (e.g. a few minutes that land on 1 January of the next year after the time zone conversion) are dropped.
- **Time zone:** the SmartNIALMeter timestamps are naive UTC (nanoseconds since 1970-01-01, no time zone stored; exactly 17,280 samples per day all year, with no gap or repeat at the daylight saving switches). This matches the default `--source-tz UTC`, so no option is needed. For other datasets whose timestamps are already local time, use e.g. `--source-tz Europe/Zurich`.

Example layout of one file (`coffee_maker.h5`, pandas HDFStore, fixed format):

| HDF5 path | Shape | Content |
| --- | --- | --- |
| `data/axis0` | (2,) | column names `Active Power`, `Reactive Power` |
| `data/axis1` | (6307200,) | timestamps, int64 ns since 1970-01-01 (naive UTC), every 5 s |
| `data/block0_values` | (6307200, 2) | active power (W), reactive power (var) |

Converting one such year takes a few seconds and about 0.5 GB of memory per file.

**Training, gap and test days**

`data/evaluation.json` holds the chronological holdout split used to train the external NILM models: training 2019-01-01 – 2019-10-19, gap 2019-10-20 – 2019-10-26, test 2019-10-27 – 2019-12-31. With recorded data the header marks the current day as *Training day*, *Gap day* or *Test day*. On training days, trained models have seen the data, so their accuracy is optimistic; the test period gives a fair evaluation.

**4. Start the server in the project folder and open the app**

```bash
python3 tools/serve.py
```

Windows:

```bash
py tools\serve.py
```

Open http://localhost:8000 (or reload the page if it is already open). When `data/real/manifest.json` exists, the app starts with the recorded data; otherwise it uses the mock curves. In the header you can:

- switch between *Mock* and the recorded data,
- jump to a recorded day with the date field,
- turn on **Repeat day** to replay one day again and again (a "fixed date"): at midnight the same recorded day starts over, and the day label shows the run (e.g. `Sun, 26 Mar 2023 · run 3`). Picking another date while it is on repeats that day instead. Turning it off continues with the following day.

Devices without recorded data are switched off and greyed out. Gaps in the recordings count as 0 W. After the last recorded day the replay starts again with the first one. The smart meter still only sees the sum of the devices, and the load disaggregation still only sees the smart meter.

**Troubleshooting: the *Data* selection only offers "Mock"**

1. Check that `data/real/manifest.json` and the folder `data/real/days/` exist. If not, the import (step 3) has not run or failed; run it again and read its output.
2. Open http://localhost:8000/data/real/manifest.json in the browser. If it shows "File not found", the import has not written its output, or (with `python -m http.server`) the server was started in another folder. `tools/serve.py` always serves the project folder.
3. Reload the page after importing (the manifest is read when the page loads).
4. `ModuleNotFoundError: No module named 'tables'` (or `pandas`): install the requirements (step 1) for the same Python you run the script with.
5. A file is imported under an unexpected name or "not a device in data/devices.json": rename the file to a device ID or use `--map original_name=device_id`. `--inspect` shows the mapping.
6. "Could not find a power column": use `--column "Active Power"` (any part of the column name).

## External NILM Models (.pkl)

Trained models from a local NILM framework (e.g. hmmlearn, scikit-learn or PyTorch models stored as `.pkl`) can be connected through `tools/serve.py`. They run in Python on your machine; the browser only exchanges numbers with the local server.

> **Models never go into the repository.** `models/`, `*.pkl`, `*.pt` and `*.pth` are in `.gitignore`. Loading a pickle runs code from the file: only load your own models.

**How it fits together**

```
App (browser) ──GET /api/models──────► tools/serve.py ──► adapter (Python) ──► your framework + .pkl files
              ──POST /api/disaggregate─►
```

- `GET /api/models` lists the models: name, group, whether they need reactive power, which devices they estimate, what they output (power, on/off, probability), window length and on/off thresholds.
- `POST /api/disaggregate` takes the smart meter minutes of a day (`start`, `timezone`, `P`, and `Q` if available) and returns, per device and minute, `power`, `on` and `prob` (each may be `null` if the model does not produce it).
- The server checks the model name, whether the model is available and whether it gets the reactive power it needs, and answers with a clear error otherwise.

**Configuration** (`models/config.json`, local only)

```json
{
  "adapter": "models/serve_adapter.py",
  "framework_path": "C:/path/to/the/folder/containing/nilm_framework",
  "settings": { "models_dir": "C:/path/to/the/models", "building": "building_1", "file_pattern": "{model}_model.pkl" }
}
```

Without this file the API answers "not configured" and the app uses its built-in model.

**Adapters**

- `tools/nilm_adapter_demo.py`: three small demo models (combinatorial optimization with P only, with P + Q and probabilities, and with a centred 99-minute window) to test the whole chain without trained models. Use `{"adapter": "tools/nilm_adapter_demo.py", "settings": {}}` as `models/config.json`.
- `tools/nilm_adapter_template.py`: template for the real framework. Copy it to `models/serve_adapter.py` and fill in the places marked `TODO` (decode step of the state-space models, feature step of the classifiers, inference of the PyTorch models). It already lists all models of the framework's specification with their inputs and outputs and loads each pickle once.

The server needs `pandas` (and `numpy`) in the Python it runs with, plus whatever your models need (hmmlearn, scikit-learn, torch, …).

**Choosing a model in the app**

The *Model* field in the load disaggregation panel lists the built-in FHMM (always available, computed in the browser) and, grouped, every model of the model server. Models that cannot run are disabled: *(not available)* when their file is missing, *(needs reactive power)* when the data source has no reactive power (e.g. the mock data).

- The app sends the smart meter minutes of the current day (plus a few minutes of the previous day to fill input windows) and replaces the estimates of the whole day with each answer, at most about once per second. Window models and Viterbi decoding may still change earlier minutes, so nothing is appended.
- The table adapts to what a model delivers: *P(on)* in % for models with probabilities, *on/off* for models without; *Estimate* shows `–` for classifiers without a power estimate, and *Residual* and *Energy accuracy* are then not available. *Model confidence* is only shown for the built-in model.
- Window models that estimate the middle of their window (e.g. Seq2Point, `center: true`): the last `window/2` minutes are **provisional**, drawn faded in the chart and not counted in the accuracy figures.
- On/off accuracy uses the model's own on/off thresholds.
- External models keep estimating devices that are switched off in the house; those rows are greyed out and marked *not in house*.
- Device IDs from the model server are matched case-insensitively (e.g. the framework's `AHU` is the app's `ahu`).
- On training days the panel warns that a trained model's accuracy is optimistic.
- Switching back to the built-in model recalculates the day with it.

## Isometric View

The house is drawn in an isometric projection. All positions in `data/devices.json` are world coordinates in meters:

- `x` runs along the back wall, `y` along the left wall, `z` is the height above the floor.
- A device consists of one or more boxes `[x0, y0, z0, x1, y1, z1]`. A box can have its own `color`, and `"glow": true` makes it light up while the device is on (e.g. a lamp shade).
- `details` draws flat shapes on the visible faces of a box, e.g. the round door of the washing machine (`"shape": "circle"`) the window of the electric stove (`"shape": "rect"`) or the seam between fridge and freezer (`"shape": "line"`). `face` is `"front"` (u = x) or `"side"` (u = y), `v` is the height.
- `wall` (`"left"` or `"back"`) tells along which wall the cable is routed, and `plug` is where the cable enters the device.
- Cables run from the smart meter along the walls in parallel lanes and are ordered automatically so they never cross.

## Contributing

Contributions are welcome. Please create a separate branch for your changes and open a pull request.
