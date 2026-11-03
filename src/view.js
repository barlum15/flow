// Isometric SVG rendering of the house: rooms, walls, devices, the smart meter,
// the cables between them and the yellow balls that flow from the smart meter
// to each device while it draws power.
//
// World coordinates are in meters: x runs along the back wall, y along the
// left wall, z is the height above the floor.

const SVG_NS = "http://www.w3.org/2000/svg";

const TILE_W = 64; // screen width of 1 m along the floor diagonal
const TILE_H = 32; // screen height of 1 m along the floor diagonal
const Z_SCALE = 38; // screen height of 1 m of elevation

const LANE_START = 1.4; // distance of the first cable lane from the wall (m)
const LANE_GAP = 0.12; // distance between neighbouring cable lanes (m)
const METER_LANE_START = 0.15; // where the first cable leaves the meter (m)

const BALLS_PER_WATT_SECOND = 0.004; // spawn rate: 1000 W -> 4 balls per second
const BALL_SPEED = 160; // px per real second
const MAX_BALLS_PER_CABLE = 80;

/** Projects a world point (meters) to screen coordinates. */
export function iso(x, y, z = 0) {
  return {
    x: (x - y) * (TILE_W / 2),
    y: (x + y) * (TILE_H / 2) - z * Z_SCALE,
  };
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function points(list) {
  return list.map(([x, y, z]) => {
    const p = iso(x, y, z);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(" ");
}

/** Darkens a hex color by the given factor (0..1). */
function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.round(((n >> shift) & 255) * (1 - factor));
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/**
 * Draws an axis-aligned box. Only the three faces visible from the viewer are
 * drawn: top, the +x side (right) and the +y side (left).
 */
function drawBox(parent, [x0, y0, z0, x1, y1, z1], { color, className = "" } = {}) {
  const g = el("g", { class: `box ${className}`.trim() }, parent);
  const faces = [
    ["face-left", [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], 0.12],
    ["face-right", [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], 0.24],
    ["face-top", [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 0],
  ];
  for (const [cls, corners, darken] of faces) {
    const attrs = { class: cls, points: points(corners) };
    if (color) attrs.fill = shade(color, darken);
    el("polygon", attrs, g);
  }
  return g;
}

/** Text lying flat on the floor, aligned with the x axis. */
function floorText(parent, text, x, y, className) {
  const o = iso(x, y);
  const g = el("g", { transform: `matrix(${TILE_W / 2} ${TILE_H / 2} ${-TILE_W / 2} ${TILE_H / 2} ${o.x} ${o.y})` }, parent);
  el("text", { class: className, "font-size": 0.32 }, g).textContent = text;
}

/** Normalizes a device box entry: either [x0, y0, z0, x1, y1, z1] or { box, color, glow }. */
function boxSpec(entry, device) {
  return Array.isArray(entry) ? { box: entry, color: device.color } : { color: device.color, ...entry };
}

/**
 * Builds the floor route of every cable. Cables leave the meter side by side,
 * run along the left wall and then along the back wall. Lanes are assigned in
 * the order the cables leave the bundle, so that cables never cross.
 */
function routeCables(devices, meterBox) {
  const left = devices.filter((d) => d.wall === "left").sort((a, b) => b.plug.y - a.plug.y);
  const back = devices.filter((d) => d.wall !== "left").sort((a, b) => a.plug.x - b.plug.x);
  const ordered = [...left, ...back];

  const [, meterY0, meterZ0, meterX1] = meterBox;
  const routes = new Map();

  ordered.forEach((device, i) => {
    const lane = LANE_START + i * LANE_GAP;
    const start = meterY0 + METER_LANE_START + i * LANE_GAP;
    const { x: px, y: py } = device.plug;

    const route = [
      [meterX1, start, meterZ0], // bottom of the smart meter
      [meterX1, start, 0], // down the wall
      [lane, start, 0], // out to the lane
    ];
    if (device.wall === "left") {
      route.push([lane, py, 0], [px, py, 0]);
    } else {
      route.push([lane, lane, 0], [px, lane, 0], [px, py, 0]);
    }
    routes.set(device.id, route);
  });

  return routes;
}

export class HouseView {
  constructor(svg, devices, layout) {
    this.svg = svg;
    this.cables = new Map();

    const { house, meter } = layout;
    const W = house.width;
    const D = house.depth;
    const H = house.wallHeight;
    const T = 0.15; // wall thickness

    const root = el("g", {}, svg);

    // Floor slab, rooms and walls
    drawBox(root, [0, 0, -0.25, W, D, 0], { className: "slab" });
    for (const room of house.rooms) {
      el("polygon", {
        class: "room",
        points: points([[room.x0, room.y0, 0], [room.x1, room.y0, 0], [room.x1, room.y1, 0], [room.x0, room.y1, 0]]),
      }, root);
    }
    for (const room of house.rooms) {
      const at = room.label ?? { x: room.x0 + 0.35, y: room.y1 - 0.35 };
      floorText(root, room.name, at.x, at.y, "room-label");
    }
    drawBox(root, [-T, -T, -0.25, W, 0, H], { className: "wall" });
    drawBox(root, [-T, 0, -0.25, 0, D, H], { className: "wall" });

    // Smart meter on the left wall
    this.meterGroup = drawBox(root, meter.box, { className: "meter" });

    // Cables and balls (on the floor, below the devices)
    const cableLayer = el("g", {}, root);
    this.ballLayer = el("g", {}, root);
    const routes = routeCables(devices, meter.box);

    for (const device of devices) {
      const route = routes.get(device.id);
      const d = route.map(([x, y, z], i) => {
        const p = iso(x, y, z);
        return `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      }).join(" ");
      const path = el("path", { class: "cable", d }, cableLayer);
      this.cables.set(device.id, { device, path, length: path.getTotalLength(), balls: [], spawnBudget: 0 });
    }

    // Devices, back to front
    const deviceLayer = el("g", {}, root);
    const labelLayer = el("g", {}, root);
    const depth = (device) => {
      const [x0, y0, , x1, y1] = boxSpec(device.boxes[0], device).box;
      return (x0 + x1) / 2 + (y0 + y1) / 2;
    };

    for (const device of [...devices].sort((a, b) => depth(a) - depth(b))) {
      const cable = this.cables.get(device.id);
      const group = el("g", { class: "device" }, deviceLayer);
      let top = { x: 0, y: Infinity };

      for (const entry of device.boxes) {
        const spec = boxSpec(entry, device);
        drawBox(group, spec.box, { color: spec.color, className: spec.glow ? "glow" : "" });
        const [x0, y0, , x1, y1, z1] = spec.box;
        const p = iso((x0 + x1) / 2, (y0 + y1) / 2, z1);
        if (p.y < top.y) top = p;
      }

      const label = el("g", { class: "device-label", transform: `translate(${top.x} ${top.y - 14})` }, labelLayer);
      el("text", { class: "device-name", y: -16 }, label).textContent = device.name;
      cable.label = el("text", { class: "device-watts", y: 0 }, label);
      cable.group = group;
      cable.labelGroup = label;
    }

    // Smart meter label
    const [mx0, my0, mz0, mx1, my1, mz1] = meter.box;
    const mSide = iso(mx0, (my0 + my1) / 2, (mz0 + mz1) / 2);
    const meterLabel = el("g", { class: "device-label meter-label", transform: `translate(${mSide.x - 34} ${mSide.y})` }, labelLayer);
    el("text", { class: "device-name", y: -10 }, meterLabel).textContent = "Smart meter";
    this.meterLabel = el("text", { class: "meter-watts", y: 12 }, meterLabel);

    this.placeLabels(labelLayer);

    // Fit the drawing into the view
    const bbox = root.getBBox();
    const pad = 24;
    svg.setAttribute("viewBox", `${bbox.x - pad} ${bbox.y - pad - 20} ${bbox.width + pad * 2} ${bbox.height + pad * 2 + 20}`);
  }

  /**
   * Moves labels up until they no longer overlap a label that is already
   * placed. Labels that moved get a thin leader line to their device.
   */
  placeLabels(layer) {
    const placed = [];
    const groups = [...layer.children].map((g) => {
      const [, x, y] = g.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/).map(Number);
      return { g, x, y, box: g.getBBox() };
    });
    groups.sort((a, b) => b.y - a.y); // front (lower on screen) first

    const gap = 4;
    for (const label of groups) {
      let dy = 0;
      const rect = () => ({
        x0: label.x + label.box.x - gap,
        x1: label.x + label.box.x + label.box.width + gap,
        y0: label.y + dy + label.box.y - gap,
        y1: label.y + dy + label.box.y + label.box.height + gap,
      });
      let hit;
      while ((hit = placed.find((r) => {
        const a = rect();
        return a.x0 < r.x1 && a.x1 > r.x0 && a.y0 < r.y1 && a.y1 > r.y0;
      }))) {
        dy = hit.y0 - (label.box.y + label.box.height + gap) - label.y - 0.5;
      }
      if (dy !== 0) {
        label.g.setAttribute("transform", `translate(${label.x} ${label.y + dy})`);
        el("line", { class: "leader", x1: 0, y1: 4, x2: 0, y2: -dy + 6 }, label.g);
      }
      placed.push(rect());
    }
  }

  /** Called every animation frame with the elapsed real time in seconds. */
  render(dtSeconds, meterTotal) {
    for (const cable of this.cables.values()) {
      const { device } = cable;
      const active = device.power > 0;

      cable.path.classList.toggle("active", active);
      cable.group.classList.toggle("active", active);
      cable.group.classList.toggle("disabled", !device.enabled);
      cable.labelGroup.classList.toggle("disabled", !device.enabled);
      cable.label.textContent = `${Math.round(device.power)} W`;

      // Spawn balls at the smart meter proportional to the current power draw.
      cable.spawnBudget += device.power * BALLS_PER_WATT_SECOND * dtSeconds;
      while (cable.spawnBudget >= 1) {
        cable.spawnBudget -= 1;
        if (cable.balls.length < MAX_BALLS_PER_CABLE) {
          const node = el("circle", { class: "ball", r: 3.5 }, this.ballLayer);
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
        const p = cable.path.getPointAtLength(ball.distance);
        ball.node.setAttribute("cx", p.x);
        ball.node.setAttribute("cy", p.y);
        return true;
      });
    }

    this.meterGroup.classList.toggle("active", meterTotal > 0);
    this.meterLabel.textContent = `${Math.round(meterTotal)} W`;
  }
}
