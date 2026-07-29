module.exports = {
  apps: [
    {
      name: 'ai-meeting-server',
      script: 'index.js',
      interpreter: 'node',
      cwd: `${__dirname}/server`,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
