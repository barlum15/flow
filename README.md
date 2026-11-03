# flow

**flow** is an interactive visualization of electricity consumption in a household.

> Status: first prototype.

## Idea

A house contains several electrical devices (e.g. fridge, washing machine, oven, TV, lighting). Every device is connected to a central **smart meter** by a cable.

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

flow is a **web app** that runs in any browser and also locally on your own machine.

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
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser. A local web server is needed because browsers block loading `data/devices.json` from `file://`.

## Project Structure

| Path | Purpose |
| --- | --- |
| `index.html` | Page layout and controls |
| `src/simulation.js` | Devices, smart meter and simulated clock |
| `src/view.js` | Isometric SVG rendering of the house, devices, cables and the yellow balls |
| `src/chart.js` | Live and daily charts of the totals recorded by the smart meter |
| `src/main.js` | Loads data and runs the animation loop |
| `src/theme.js` | Light/dark mode switch |
| `src/style.css` | Styling (light and dark mode) |
| `data/devices.json` | Floor plan, smart meter position and devices (shape, plug position, hourly consumption curve with 24 values in watts) |

## How the Prototype Works

1. A simulated clock runs through the day (speed: 1 min/s, 10 min/s or 1 h/s).
2. On every step, each device looks up its current power in its consumption curve and **requests** it from the smart meter.
3. The smart meter **only adds up** the requested watts. It never knows which device asked. Every simulated minute it stores the average total of that minute (1-minute resolution).
4. Each cable shows yellow balls flowing from the smart meter to the device that draws the power; more power means more balls.
5. Devices can be switched off below the house to see how the total changes.

### Smart Meter Display

- **Current power** as a large live value, plus energy today, peak today and the meter reading (total kWh since start, like a real counter)
- **Chart** with two ranges, switchable above the chart:
  - **Live**: scrolling view of the last 60 simulated minutes with the current value as the newest point
  - **Today**: the whole day from 00:00 to 24:00 at 1-minute resolution with a marker for the current time
- The meter keeps the last two simulated days of records

### Layout and Theme

- The house and the smart meter panel sit side by side. The house panel sets the height and the smart meter panel matches it; on narrow screens they stack.
- A switch in the header toggles between light and dark mode. Without a saved choice the page follows the system setting; the choice is remembered in the browser.

## Isometric View

The house is drawn in an isometric projection. All positions in `data/devices.json` are world coordinates in meters:

- `x` runs along the back wall, `y` along the left wall, `z` is the height above the floor.
- A device consists of one or more boxes `[x0, y0, z0, x1, y1, z1]`. A box can have its own `color`, and `"glow": true` makes it light up while the device is on (e.g. a lamp shade).
- `wall` (`"left"` or `"back"`) tells along which wall the cable is routed, and `plug` is where the cable enters the device.
- Cables run from the smart meter along the walls in parallel lanes and are ordered automatically so they never cross.

## Contributing

Contributions are welcome. Please create a separate branch for your changes and open a pull request.
