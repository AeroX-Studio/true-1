const { handleCors } = require('./utils');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;

  return res.status(200).json({
    status: 'ok',
    service: 'veltrix-vercel-api',
    timestamp: new Date().toISOString()
  });
};
