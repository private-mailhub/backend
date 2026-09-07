'use strict';

const fs = require('node:fs');
const path = require('node:path');

const release = process.env.MAILHUB_RELEASE;
const apiPort = process.env.API_PORT;

if (typeof release !== 'string' || !path.isAbsolute(release) || release === path.parse(release).root) {
  throw new Error('MAILHUB_RELEASE must be an absolute release directory');
}

if (!fs.existsSync(release) || !fs.statSync(release).isDirectory()) {
  throw new Error(`MAILHUB_RELEASE does not exist: ${release}`);
}

if (apiPort !== '8080' && apiPort !== '8081') {
  throw new Error('API_PORT must be 8080 or 8081');
}

const port = Number(apiPort);

module.exports = {
  apps: [
    {
      name: `mailhub-server-${apiPort}`,
      cwd: release,
      script: './dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: port,
        WORKER_MODE: 'false',
      },
      error_file: '/var/log/pm2/mailhub-web-error.log',
      out_file: '/var/log/pm2/mailhub-web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
    },
    {
      name: 'mailhub-worker',
      cwd: release,
      script: './dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: port,
        WORKER_MODE: 'true',
      },
      error_file: '/var/log/pm2/mailhub-worker-error.log',
      out_file: '/var/log/pm2/mailhub-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
    },
  ],
};
