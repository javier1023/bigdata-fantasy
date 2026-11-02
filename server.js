'use strict';
// Punto de entrada. Vercel detecta la app de Express en este archivo (import de express + export default).
// En local / Render, además, arranca el servidor en PORT.
require('express');
const app = require('./src/app');

module.exports = app;

if (!process.env.VERCEL) {
  try { process.loadEnvFile('.env'); } catch (e) { /* sin .env: se usan las variables del entorno */ }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Fantasy app en http://localhost:' + PORT));
}

