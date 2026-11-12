(function() {
  try {
    const savedTheme = localStorage.getItem('assignment-theme');
    const theme = ['system', 'dark', 'light'].includes(savedTheme) ? savedTheme : 'system';
    const resolvedTheme = theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    if (resolvedTheme === 'dark') {
      document.documentElement.classList.add('theme-dark');
    }
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = theme;
  } catch {}
})();
