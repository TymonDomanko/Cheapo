// Light / dark / auto (follow the device). Loaded before the page draws, so it
// never flashes the wrong colours. The choice is kept on this device.
(function () {
  const ORDER = ['auto', 'light', 'dark'];
  const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const svg = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
    light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  };
  const saved = () => {
    try {
      return ORDER.includes(localStorage.getItem('theme')) ? localStorage.getItem('theme') : 'auto';
    } catch {
      return 'auto';
    }
  };
  const dark = matchMedia('(prefers-color-scheme: dark)');

  function apply(theme) {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.dataset.theme = theme;
    const isDark = theme === 'dark' || (theme === 'auto' && dark.matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isDark ? '#1a1a19' : '#2a78d6';
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.innerHTML = ICON[theme];
      btn.title = `Colours: ${LABEL[theme]} — tap to change`;
      btn.setAttribute('aria-label', `Colours: ${LABEL[theme]}. Change`);
    }
  }

  apply(saved());
  dark.addEventListener('change', () => apply(saved()));
  document.addEventListener('DOMContentLoaded', () => {
    apply(saved());
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      const next = ORDER[(ORDER.indexOf(saved()) + 1) % ORDER.length];
      try {
        localStorage.setItem('theme', next);
      } catch {
        /* storage blocked: still switch for now */
      }
      apply(next);
      document.dispatchEvent(new CustomEvent('themechange'));
    });
  });
})();
