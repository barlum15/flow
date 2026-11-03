// Zoom: shows a single panel (house, smart meter or load disaggregation) on
// its own. The same button - or the Escape key - returns to the overview.

export function initZoom(main) {
  const panels = [...main.querySelectorAll("[data-panel]")];

  function setZoom(name) {
    if (name) main.dataset.zoom = name;
    else delete main.dataset.zoom;

    for (const panel of panels) {
      const zoomed = panel.dataset.panel === name;
      panel.classList.toggle("zoomed", zoomed);
      const button = panel.querySelector(".zoom-btn");
      const label = zoomed ? "Back to overview" : button.dataset.label;
      button.setAttribute("aria-pressed", String(zoomed));
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    window.scrollTo({ top: 0 });
  }

  for (const panel of panels) {
    const button = panel.querySelector(".zoom-btn");
    button.dataset.label = button.getAttribute("aria-label");
    button.addEventListener("click", () => {
      setZoom(main.dataset.zoom === panel.dataset.panel ? null : panel.dataset.panel);
      button.focus();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && main.dataset.zoom) setZoom(null);
  });
}
