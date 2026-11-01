// Vercel Node.js Function catch-all for the existing Express API.
const app = require('../server');

module.exports = (req, res) => app(req, res);
