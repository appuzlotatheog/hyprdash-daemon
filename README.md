# HyprDash Daemon (Node)

The lightweight agent responsible for managing game server processes, file systems, and stats monitoring. It connects to the HyprDash Panel via Socket.IO.

## Features

-   **Process Management**: Starts, stops, and monitors game server processes.
-   **File Management**: Secure file access (read/write/tar/zip) with path traversal protection.
-   **Stats Monitoring**: Real-time CPU, Memory, and Disk usage tracking.
-   **Auto-Installation**: Handles server installation scripts.

## Tech Stack

-   **Runtime**: Node.js
-   **Communication**: Socket.IO Client (connects to Panel)
-   **Utils**: `systeminformation`, `pidusage`, `archiver`

## Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/appuzlotatheog/hyprdash-daemon.git
    cd hyprdash-daemon
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Configuration**
    Create a `.env` file:
    ```env
    PANEL_URL="http://localhost:3001"
    AUTH_TOKEN="your-node-secret-token-from-panel"
    SERVER_DATA_DIR="./data/servers"
    PORT=3002
    ```

    *Note: The `AUTH_TOKEN` is generated when you create a new Node in the HyprDash Panel.*

## Running the Daemon

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm run build
npm start
```

## Security
The daemon implements strict path validation to ensure file operations are restricted to the assigned server directories.

