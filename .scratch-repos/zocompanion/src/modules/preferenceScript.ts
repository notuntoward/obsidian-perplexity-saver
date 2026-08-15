export function registerPrefsScripts(_window: Window): void {
  addon.data.prefs = {
    window: _window,
    columns: [],
    rows: [],
  };
}
