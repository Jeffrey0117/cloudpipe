module.exports = {
  apps: [{
    name: 'cloudpipe',
    script: './index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,           // 增加到 10 次（原因：端口釋放需要時間）
    min_uptime: '10s',
    max_memory_restart: '500M',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    kill_timeout: 8000,         // 增加到 8 秒（確保舊進程完全關閉）
    wait_ready: false,
    listen_timeout: 15000,      // 增加到 15 秒（給更多時間啟動）
    restart_delay: 5000,        // 增加到 5 秒（等待端口釋放）
    env: {
      NODE_ENV: 'production'
    }
  }]
};
