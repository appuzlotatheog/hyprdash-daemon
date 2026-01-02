# 🔧 HyprDash Daemon

Node agent for HyprDash game server management. Runs on each server node to manage game server processes.

> **Panel Required**: This daemon requires the [HyprDash Panel](https://github.com/appuzlotatheog/hyprdash-panel) to operate.

---

## ✨ Features

- 🎮 **Process Management** - Start, stop, restart, and kill game servers
- 📊 **Resource Monitoring** - Real-time CPU, RAM, and disk usage
- 📁 **File System Operations** - Full file management via WebSocket
- 💾 **Backup & Restore** - Create and restore server backups
- 🔌 **WebSocket Communication** - Real-time connection with panel
- 📝 **Console Streaming** - Live console output to panel
- 🎯 **Server Query** - Query Minecraft and other game servers

---

## 📋 Requirements

- **Node.js 18+**
- **npm**
- **Linux** (recommended) or Windows
- **Network access** to the HyprDash Panel

---

## 🛠️ Development Setup

### 1. Clone the Repository

```bash
git clone https://github.com/appuzlotatheog/hyprdash-daemon.git
cd hyprdash-daemon
```

### 2. Configure

```bash
# Copy example config
cp config.json.example config.json

# Edit configuration
nano config.json
```

Configuration file:
```json
{
  "panel": {
    "url": "http://localhost:3000",
    "token": "your-node-token-from-panel"
  },
  "system": {
    "check_interval": 5000,
    "data_directory": "./servers",
    "backup_directory": "./backups",
    "log_directory": "./logs"
  }
}
```

### 3. Install & Run

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev
```

---

## 🔑 Getting Your Node Token

1. Login to the **HyprDash Panel** as an admin
2. Navigate to **Admin → Nodes**
3. Click **Add Node**
4. Fill in the node details (name, FQDN, ports)
5. **Copy the generated token**
6. Paste the token into your `config.json`

---

## 🌐 Production Deployment

### Option 1: Systemd Service (Recommended for Linux)

#### 1. Install Node.js

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

#### 2. Clone and Build

```bash
# Create directory
sudo mkdir -p /var/lib/hyprdash
cd /var/lib/hyprdash

# Clone daemon
git clone https://github.com/appuzlotatheog/hyprdash-daemon.git daemon
cd daemon

# Configure
cp config.json.example config.json
sudo nano config.json  # Set panel URL and token

# Install and build
npm install
npm run build
```

#### 3. Create Systemd Service

```bash
sudo nano /etc/systemd/system/hyprdash-daemon.service
```

```ini
[Unit]
Description=HyprDash Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/lib/hyprdash/daemon
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable hyprdash-daemon
sudo systemctl start hyprdash-daemon

# Check status
sudo systemctl status hyprdash-daemon

# View logs
sudo journalctl -u hyprdash-daemon -f
```

### Option 2: PM2

```bash
# Install PM2
sudo npm install -g pm2

# Build daemon
npm run build

# Start with PM2
pm2 start dist/index.js --name "hyprdash-daemon"
pm2 save
pm2 startup
```

### Option 3: Docker (Coming Soon)

Docker support will be added in a future release.

---

## 📁 Directory Structure

```
hyprdash-daemon/
├── src/
│   ├── index.ts           # Entry point & socket connection
│   ├── process/           # Process spawning & management
│   │   └── ProcessManager.ts
│   ├── monitor/           # Resource monitoring
│   │   └── ResourceMonitor.ts
│   ├── filesystem/        # File operations
│   │   └── FileManager.ts
│   ├── backup/            # Backup system
│   │   └── BackupManager.ts
│   └── install/           # Server installation
│       └── InstallManager.ts
├── servers/               # Game server data directories
├── backups/               # Backup storage
├── logs/                  # Daemon logs
└── config.json            # Configuration file
```

---

## 🔒 Security Notes

- Run the daemon as `root` or a dedicated user with appropriate permissions
- Ensure the panel URL is correct and accessible
- Keep your node token secure - it provides full access to this node
- Use HTTPS in production between panel and daemon

---

## 🔧 Troubleshooting

### Daemon won't connect to panel
1. Check if panel is running and accessible
2. Verify `panel.url` in config is correct
3. Ensure `panel.token` matches the token from the panel
4. Check firewall rules (port 3000 for panel)

### Servers won't start
1. Check server logs in `./logs/`
2. Ensure Java is installed for Minecraft servers
3. Verify server files exist in `./servers/{serverId}/`

### Permission denied errors
1. Run daemon as root or with proper permissions
2. Ensure `servers/` and `backups/` directories are writable

---

## 🔗 Related

- **Panel**: [https://github.com/appuzlotatheog/hyprdash-panel](https://github.com/appuzlotatheog/hyprdash-panel)

---

## 📄 License

MIT License - Feel free to use, modify, and distribute.
