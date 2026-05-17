// PM2 process manager config — use with: `pm2 start ecosystem.config.cjs --env production`
module.exports = {
    apps: [
        {
            name: 'mediater',
            script: 'server.js',
            exec_mode: 'fork',
            instances: 1,
            watch: false,
            autorestart: true,
            max_memory_restart: '1G',
            kill_timeout: 10000,
            wait_ready: false,
            env: {
                NODE_ENV: 'development'
            },
            env_production: {
                NODE_ENV: 'production'
            },
            error_file: './logs/error.log',
            out_file: './logs/out.log',
            merge_logs: true,
            time: true
        }
    ]
};
