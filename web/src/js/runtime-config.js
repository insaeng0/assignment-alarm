// Public configuration only. Never put API keys, database passwords, or JWT secrets here.
// Empty keeps the existing Express-hosted, same-origin deployment working.
// GitHub Pages builds replace this file from the ASSIGNMENT_API_BASE_URL repository variable.
window.ASSIGNMENT_CONFIG = Object.freeze({
  apiBaseUrl: '',
  authMode: 'cookie'
});
