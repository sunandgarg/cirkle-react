export type ThemePreference = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "cirkle-theme";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export const readThemePreference = (): ThemePreference => {
  if (typeof window === "undefined") return "system";
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  return storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
    ? storedTheme
    : "system";
};

const resolveTheme = (theme: ThemePreference): "light" | "dark" => {
  if (theme !== "system") return theme;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches ? "dark" : "light";
};

const renderTheme = (theme: ThemePreference) => {
  const resolvedTheme = resolveTheme(theme);
  const themeColor = resolvedTheme === "dark" ? "#0d0e10" : "#f5f7f9";
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  document.documentElement.style.colorScheme = resolvedTheme;
  document.documentElement.style.backgroundColor = themeColor;
  document.body.style.backgroundColor = themeColor;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColor);
};

export const applyThemePreference = (theme: ThemePreference) => {
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  renderTheme(theme);
};

export const initializeTheme = () => {
  if (typeof window === "undefined") return;
  renderTheme(readThemePreference());

  const systemTheme = window.matchMedia(SYSTEM_DARK_QUERY);
  systemTheme.addEventListener("change", () => {
    if (readThemePreference() === "system") renderTheme("system");
  });

  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY) renderTheme(readThemePreference());
  });
};
