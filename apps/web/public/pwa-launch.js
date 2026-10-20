// Launched as the installed app? Then play the logo intro. Set before first paint
// so a browser tab never flashes it. main.tsx dismisses it once the app is up.
// A file rather than an inline script, so the Content-Security-Policy can forbid
// inline scripts entirely.
try {
  if (matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: window-controls-overlay)').matches ||
      navigator.standalone === true) {
    document.documentElement.classList.add('pwa-launch');
  }
} catch (e) {}
