const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const cfg = {
  database: process.env.DB_NAME || 'firemap',
  user: process.env.DB_USER || 'firemap',
  password: process.env.DB_PASS || '',
  waitForConnections: true,
  connectionLimit: 5, // les mutualisés plafonnent les connexions simultanées
  charset: 'utf8mb4_unicode_ci',
  namedPlaceholders: true,
};
if (process.env.DB_SOCKET) cfg.socketPath = process.env.DB_SOCKET;
else { cfg.host = process.env.DB_HOST || '127.0.0.1'; cfg.port = Number(process.env.DB_PORT) || 3306; }

const pool = mysql.createPool(cfg);

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
}

async function q(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = { pool, q, init };
