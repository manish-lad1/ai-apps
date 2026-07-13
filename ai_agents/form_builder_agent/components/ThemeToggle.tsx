"use client";

type Theme = "light" | "dark";

// Reads the DOM directly rather than mirroring it into React state — the
// button doesn't need to re-render when the theme changes elsewhere, so this
// avoids a setState-in-effect just to know what to flip on click.
function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ThemeToggle() {
  function toggle() {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle color theme"
      className="border-2 border-[var(--line)] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--ink)] hover:border-[var(--accent)]"
    >
      Theme
    </button>
  );
}
