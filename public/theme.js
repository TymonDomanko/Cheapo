// Light / dark / auto (follow the device). Loaded before the page draws, so it
// never flashes the wrong colours. The choice is kept on this device.
(function () {
  const ORDER = ['auto', 'light', 'dark'];
  const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const ICON = { auto: '◐', light: '☀︎', dark: '☾' };
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
      btn.textContent = ICON[theme];
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
