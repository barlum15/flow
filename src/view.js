// SVG rendering: devices, cables to the smart meter, and the yellow balls
// that travel along each cable while a device draws power.

const SVG_NS = "http://www.w3.org/2000/svg";
const METER_POS = { x: 820, y: 300 };

const BALLS_PER_WATT_SECOND = 0.004; // spawn rate: 1000 W -> 4 balls per second
const BALL_SPEED = 220; // px per real second
const MAX_BALLS_PER_CABLE = 60;

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function cablePath(from, to) {
  const midX = (from.x + to.x) / 2;
  return `M ${from.x + 70} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - 70} ${to.y}`;
}

export class HouseView {
  constructor(svg, devices) {
    this.svg = svg;
    this.cables = new Map();

    el("rect", { class: "house", x: 40, y: 40, width: 920, height: 520, rx: 16 }, svg);
    el("text", { class: "house-label", x: 940, y: 72, "text-anchor": "end" }, svg).textContent = "House";

    const cableLayer = el("g", {}, svg);
    this.ballLayer = el("g", {}, svg);
    const deviceLayer = el("g", {}, svg);

    for (const device of devices) {
      const path = el("path", { class: "cable", d: cablePath(device.position, METER_POS) }, cableLayer);
      this.cables.set(device.id, {
        device,
        path,
        length: path.getTotalLength(),
        balls: [],
        spawnBudget: 0,
      });

      const g = el("g", { class: "device", transform: `translate(${device.position.x} ${device.position.y})` }, deviceLayer);
      el("rect", { x: -70, y: -28, width: 140, height: 56, rx: 10 }, g);
      el("text", { class: "device-name", y: -4 }, g).textContent = device.name;
      const watts = el("text", { class: "device-watts", y: 16 }, g);
      this.cables.get(device.id).label = watts;
      this.cables.get(device.id).group = g;
    }

    const meter = el("g", { class: "meter", transform: `translate(${METER_POS.x} ${METER_POS.y})` }, deviceLayer);
    el("rect", { x: -70, y: -50, width: 140, height: 100, rx: 12 }, meter);
    el("text", { class: "device-name", y: -18 }, meter).textContent = "Smart meter";
    this.meterLabel = el("text", { class: "meter-watts", y: 16 }, meter);
  }

  /** Called every animation frame with the elapsed real time in seconds. */
  render(dtSeconds, meterTotal) {
    for (const cable of this.cables.values()) {
      const { device } = cable;
      const active = device.power > 0;

      cable.path.classList.toggle("active", active);
      cable.group.classList.toggle("active", active);
      cable.group.classList.toggle("disabled", !device.enabled);
      cable.label.textContent = `${Math.round(device.power)} W`;

      // Spawn balls proportional to the current power draw.
      cable.spawnBudget += device.power * BALLS_PER_WATT_SECOND * dtSeconds;
      while (cable.spawnBudget >= 1) {
        cable.spawnBudget -= 1;
        if (cable.balls.length < MAX_BALLS_PER_CABLE) {
          const node = el("circle", { class: "ball", r: 5 }, this.ballLayer);
          cable.balls.push({ node, distance: 0 });
        }
      }
      if (!active) cable.spawnBudget = 0;

      // Move balls from the smart meter to the device and remove those that arrived.
      cable.balls = cable.balls.filter((ball) => {
        ball.distance += BALL_SPEED * dtSeconds;
        if (ball.distance >= cable.length) {
          ball.node.remove();
          return false;
        }
        const p = cable.path.getPointAtLength(cable.length - ball.distance);
        ball.node.setAttribute("cx", p.x);
        ball.node.setAttribute("cy", p.y);
        return true;
      });
    }

    this.meterLabel.textContent = `${Math.round(meterTotal)} W`;
  }
}
