# flow

**flow** is an interactive visualization of electricity consumption in a household.

> Status: idea / concept phase. No code yet.

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

## Suggested Approach

A **web app** is recommended:

- Runs in any browser, and can also be run locally on your own machine
- Good fit for animations (SVG or Canvas)
- Easy to share and to extend later (e.g. with real smart-meter data)

The exact tech stack is still to be decided.

## Getting Started

```bash
git clone https://github.com/barlum15/flow.git
cd flow
```

## Contributing

Contributions are welcome. Please create a separate branch for your changes and open a pull request.
