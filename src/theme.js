// Light/dark mode switch. Without a saved choice the page follows the system
// setting; the switch stores an explicit choice in localStorage.

const STORAGE_KEY = "flow-theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return systemDark.matches ? "dark" : "light";
}

export function initThemeSwitch(button) {
  const sync = () => button.setAttribute("aria-checked", String(currentTheme() === "dark"));

  button.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable (e.g. private mode): the choice lasts for this visit only.
    }
    sync();
  });

  systemDark.addEventListener("change", sync);
  sync();
}
