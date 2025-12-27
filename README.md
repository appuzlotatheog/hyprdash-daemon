# 🔧 HyprDash Daemon

Node agent for HyprDash game server management. Runs on each node to manage game server processes.

## Features

- 🎮 Process Management (start, stop, restart, kill)
- 📊 Resource Monitoring (CPU, RAM, Disk)
- 📁 File System Operations
- 💾 Backup Creation & Restoration
- 🔌 WebSocket Communication with Panel
- 📝 Real-time Console Streaming

## Quick Start

```bash
# Install dependencies
npm install

# Configure
cp config.example.json config.json
# Edit config.json with panel URL and node token

# Development
npm run dev

# Production
npm run build
npm start
```

## Configuration

Create `config.json`:

```json
{
    "panelUrl": "http://panel-ip:3001",
    "token": "YOUR_NODE_TOKEN_FROM_PANEL",
    "port": 8080,
    "serversDir": "./servers"
}
```

## Project Structure

```
hyprdash-daemon/
├── src/
│   ├── index.ts           # Entry point
│   ├── process/           # Process spawning & management
│   ├── monitor/           # Resource monitoring
│   └── filesystem/        # File operations
├── servers/               # Game server directories
└── config.json            # Node configuration
```

## Getting Node Token

1. Login to HyprDash Panel as admin
2. Go to Nodes → Create Node
3. Copy the generated token
4. Paste into `config.json`

## Panel

This daemon requires the [HyprDash Panel](https://github.com/your-repo/hyprdash-panel) to operate.

## License

MIT
