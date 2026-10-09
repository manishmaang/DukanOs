// This entry point cannot silently fall back to development cookie semantics.
if (process.env.NODE_ENV !== 'production') {
  console.error('Production start requires NODE_ENV=production.');
  process.exitCode = 1;
} else {
  require('../apps/api/dist/main.js');
}
