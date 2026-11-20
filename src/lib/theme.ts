// Julian Unified UI theming: follow prefers-color-scheme until the user picks a theme, then remember it.
// No data-theme attribute = follow the system (tokens.css handles that).
export type ThemeChoice = 'system' | 'dark' | 'light';
const KEY = 'imaginarium-theme';

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage blocked: the theme still applies for this page view */
  }
  applyTheme(choice);
}

export function initTheme(): void {
  applyTheme(getTheme());
}
