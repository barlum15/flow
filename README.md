# flow

**flow** is an interactive visualization of electricity consumption in a household.

> Status: first prototype.

## Idea

A house contains several electrical devices (e.g. fridge, washing machine, oven, TV, lighting). Every device is connected to a central **smart meter** by a cable.

- **Devices** have a stored **consumption curve** (power over time) in a database in the background.
- When a device needs electricity, it **requests** that consumption from the smart meter.
- The flow of electricity is visualized: **yellow balls travel through the cable** from the device to the smart meter. The more power a device draws, the more (or faster) balls flow.
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
- SVG for the house, cables and animated balls; Canvas for the consumption chart
- `data/devices.json` acts as the database for the devices' consumption curves
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
| `src/view.js` | SVG rendering of devices, cables and the yellow balls |
| `src/chart.js` | Chart of the totals recorded by the smart meter |
| `src/main.js` | Loads data and runs the animation loop |
| `src/style.css` | Styling (light and dark mode) |
| `data/devices.json` | Devices with position and hourly consumption curve (24 values in watts) |

## How the Prototype Works

1. A simulated clock runs through the day (speed: 1 min/s, 10 min/s or 1 h/s).
2. On every step, each device looks up its current power in its consumption curve and **requests** it from the smart meter.
3. The smart meter **only adds up** the requested watts. It never knows which device asked. Every 5 simulated minutes it stores the total.
4. Each cable shows yellow balls flowing towards the smart meter; more power means more balls.
5. Devices can be switched off in the side panel to see how the total changes.

## Contributing

Contributions are welcome. Please create a separate branch for your changes and open a pull request.
