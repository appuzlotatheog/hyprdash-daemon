import 'dotenv/config';
import { io, Socket } from 'socket.io-client';
import fs from 'fs/promises';
import path from 'path';
import { ProcessManager } from './process/ProcessManager.js';
import { ResourceMonitor } from './monitor/ResourceMonitor.js';
import { FileManager } from './filesystem/FileManager.js';
import { InstallManager } from './install/InstallManager.js';
import { BackupManager } from './backup/BackupManager.js';

interface DaemonConfig {
    panel_url: string;
    token: string;
    data_directory: string;
    backup_directory: string;
    log_directory: string;
    port: number;
    ssl: {
        enabled: boolean;
        cert: string;
        key: string;
    };
    system: {
        check_interval: number;
        memory_padding: number;
    };
}

class Daemon {
    private config!: DaemonConfig;
    private socket!: Socket;
    private processManager!: ProcessManager;
    private resourceMonitor!: ResourceMonitor;
    private fileManager!: FileManager;
    private installManager!: InstallManager;
    private backupManager!: BackupManager;

    async start() {
        console.log('🚀 Starting Game Panel Daemon...');

        // Load configuration
        await this.loadConfig();

        // Ensure directories exist
        await this.ensureDirectories();

        // Initialize managers
        this.processManager = new ProcessManager(this.config.data_directory);
        this.resourceMonitor = new ResourceMonitor();
        this.fileManager = new FileManager(this.config.data_directory);
        this.installManager = new InstallManager(this.config.data_directory);
        this.backupManager = new BackupManager(
            this.config.data_directory,
            this.config.backup_directory,
            this.fileManager
        );

        // Connect to panel
        await this.connectToPanel();

        // Start system monitoring
        this.startSystemMonitoring();

        console.log('✅ Daemon started successfully');
    }

    private async loadConfig() {
        const configPath = process.env.CONFIG_PATH || './config.json';

        try {
            const configData = await fs.readFile(configPath, 'utf-8');
            this.config = JSON.parse(configData);
            console.log(`📋 Loaded configuration from ${configPath}`);
        } catch (error) {
            console.error('Failed to load config.json. Copy config.example.json to config.json');
            process.exit(1);
        }
    }

    private async ensureDirectories() {
        const dirs = [
            this.config.data_directory,
            this.config.backup_directory,
            this.config.log_directory,
        ];

        for (const dir of dirs) {
            await fs.mkdir(dir, { recursive: true });
        }
    }

    private async connectToPanel() {
        return new Promise<void>((resolve, reject) => {
            console.log(`🔌 Connecting to panel at ${this.config.panel_url}...`);

            this.socket = io(this.config.panel_url, {
                auth: {
                    nodeToken: this.config.token,
                },
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionAttempts: Infinity,
            });

            this.socket.on('connect', () => {
                console.log('✅ Connected to panel');
                resolve();
            });

            this.socket.on('connect_error', (error) => {
                console.error('❌ Connection error:', error.message);
            });

            this.socket.on('disconnect', (reason) => {
                console.log(`⚠️ Disconnected from panel: ${reason}`);
            });

            // Handle server events from panel
            this.setupEventHandlers();

            // Timeout after 30 seconds
            setTimeout(() => {
                if (!this.socket.connected) {
                    reject(new Error('Connection timeout'));
                }
            }, 30000);
        });
    }

    private setupEventHandlers() {
        // Server creation
        this.socket.on('server:create', async (data: { serverId: string; config: any }) => {
            console.log(`📦 Creating server ${data.serverId}`);
            try {
                await this.processManager.createServerDirectory(data.serverId);
                this.socket.emit('server:status', { serverId: data.serverId, status: 'OFFLINE' });
            } catch (error) {
                console.error(`Failed to create server ${data.serverId}:`, error);
                this.socket.emit('server:error', {
                    serverId: data.serverId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        // Server installation
        this.socket.on('server:install', async (data: {
            serverId: string;
            egg: { name: string; startup: string; scriptInstall?: string; scriptContainer?: string };
            variables: Record<string, string>;
        }) => {
            console.log(`📥 Installing server ${data.serverId}`);

            this.socket.emit('server:install:progress', {
                serverId: data.serverId,
                progress: 0,
                message: 'Starting installation...'
            });

            try {
                await this.installManager.installServer(
                    {
                        serverId: data.serverId,
                        egg: data.egg,
                        variables: data.variables,
                    },
                    (serverId, progress, message) => {
                        this.socket.emit('server:install:progress', { serverId, progress, message });
                    }
                );

                this.socket.emit('server:install:complete', { serverId: data.serverId });
            } catch (error) {
                console.error(`Installation failed for ${data.serverId}:`, error);
                this.socket.emit('server:install:error', {
                    serverId: data.serverId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        // Power actions
        this.socket.on('server:power', async (data: { serverId: string; action: string; config: any }) => {
            console.log(`⚡ Power action ${data.action} for server ${data.serverId}`);

            try {
                switch (data.action) {
                    case 'start':
                        await this.handleServerStart(data.serverId, data.config);
                        break;
                    case 'stop':
                        await this.processManager.stopServer(data.serverId);
                        break;
                    case 'restart':
                        await this.processManager.stopServer(data.serverId);
                        setTimeout(() => this.handleServerStart(data.serverId, data.config), 2000);
                        break;
                    case 'kill':
                        await this.processManager.killServer(data.serverId);
                        break;
                }
            } catch (error) {
                console.error(`Power action failed for ${data.serverId}:`, error);
                this.socket.emit('server:error', {
                    serverId: data.serverId,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        });

        // Console commands
        this.socket.on('server:command', (data: { serverId: string; command: string }) => {
            console.log(`💬 Command for ${data.serverId}: ${data.command}`);
            this.processManager.sendCommand(data.serverId, data.command);
        });

        // Server deletion
        this.socket.on('server:delete', async (data: { serverId: string }) => {
            console.log(`🗑️ Deleting server ${data.serverId}`);
            try {
                await this.processManager.killServer(data.serverId);
                await this.processManager.deleteServerDirectory(data.serverId);
            } catch (error) {
                console.error(`Failed to delete server ${data.serverId}:`, error);
            }
        });

        // File operations
        this.socket.on('files:list', async (data: { serverId: string; path: string; requestId: string }) => {
            try {
                const files = await this.fileManager.listDirectory(data.serverId, data.path);
                this.socket.emit('files:list:response', { requestId: data.requestId, files });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:read', async (data: { serverId: string; path: string; requestId: string }) => {
            try {
                const content = await this.fileManager.readFile(data.serverId, data.path);
                this.socket.emit('files:read:response', { requestId: data.requestId, content });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:write', async (data: { serverId: string; path: string; content: string; isBinary?: boolean; requestId: string }) => {
            try {
                let fileContent: string | Buffer = data.content;

                // If binary flag is set, decode base64 to buffer
                if (data.isBinary) {
                    fileContent = Buffer.from(data.content, 'base64');
                    console.log(`[Files] Writing binary file: ${data.path} (${fileContent.length} bytes)`);
                } else {
                    console.log(`[Files] Writing text file: ${data.path} (${data.content.length} chars)`);
                }

                await this.fileManager.writeFile(data.serverId, data.path, fileContent);
                this.socket.emit('files:write:response', { requestId: data.requestId, success: true });
            } catch (error) {
                console.error(`[Files] Write error:`, error);
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:mkdir', async (data: { serverId: string; path: string; requestId: string }) => {
            try {
                await this.fileManager.createDirectory(data.serverId, data.path);
                this.socket.emit('files:mkdir:response', { requestId: data.requestId, success: true });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:rename', async (data: { serverId: string; from: string; to: string; requestId: string }) => {
            try {
                await this.fileManager.renameFile(data.serverId, data.from, data.to);
                this.socket.emit('files:rename:response', { requestId: data.requestId, success: true });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:copy', async (data: { serverId: string; from: string; to: string; requestId: string }) => {
            try {
                await this.fileManager.copyFile(data.serverId, data.from, data.to);
                this.socket.emit('files:copy:response', { requestId: data.requestId, success: true });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:delete', async (data: { serverId: string; paths: string[]; requestId: string }) => {
            try {
                for (const path of data.paths) {
                    await this.fileManager.deleteFile(data.serverId, path);
                }
                this.socket.emit('files:delete:response', { requestId: data.requestId, success: true });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:compress', async (data: { serverId: string; paths: string[]; destination: string; requestId: string }) => {
            try {
                await this.fileManager.createArchive(data.serverId, data.paths, data.destination);
                this.socket.emit('files:compress:response', { requestId: data.requestId, success: true });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('files:decompress', async (data: { serverId: string; file: string; destination: string; requestId: string }) => {
            try {
                await this.fileManager.extractArchive(data.serverId, data.file, data.destination);
                this.socket.emit('files:decompress:response', { requestId: data.requestId, success: true });
            } catch (error) {
                this.socket.emit('files:error', {
                    requestId: data.requestId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        // Backup operations
        this.socket.on('backup:create', async (data: {
            serverId: string;
            backupId: string;
            ignoredFiles?: string[];
            s3?: any;
        }) => {
            console.log(`📦 Creating backup for server ${data.serverId}`);
            try {
                this.socket.emit('backup:status', { backupId: data.backupId, status: 'IN_PROGRESS' });

                const result = await this.backupManager.createBackup({
                    serverId: data.serverId,
                    backupId: data.backupId,
                    ignoredFiles: data.ignoredFiles,
                    s3: data.s3,
                }, (progress: number, message: string) => {
                    // Send progress updates (optional, or just log)
                    // this.socket.emit('backup:progress', { backupId: data.backupId, progress, message });
                });

                this.socket.emit('backup:complete', {
                    backupId: data.backupId,
                    size: result.size,
                    storagePath: result.path,
                    isS3: result.isS3,
                });
            } catch (error) {
                console.error(`Backup failed for ${data.serverId}:`, error);
                this.socket.emit('backup:error', {
                    backupId: data.backupId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('backup:restore', async (data: {
            serverId: string;
            backupId: string;
            storagePath: string;
            isS3?: boolean;
            s3?: any;
        }) => {
            console.log(`📦 Restoring backup for server ${data.serverId}`);
            try {
                await this.backupManager.restoreBackup(
                    data.serverId,
                    data.storagePath,
                    !!data.isS3,
                    data.s3
                );

                this.socket.emit('backup:restore:complete', { backupId: data.backupId });
            } catch (error) {
                console.error(`Restore failed for ${data.serverId}:`, error);
                this.socket.emit('backup:restore:error', {
                    backupId: data.backupId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        this.socket.on('backup:delete', async (data: { serverId: string; backupId: string; storagePath: string; isS3?: boolean; s3?: any }) => {
            console.log(`🗑️ Deleting backup ${data.backupId}`);
            try {
                await this.backupManager.deleteBackup(data.serverId, data.backupId, data.storagePath, data.isS3, data.s3);
            } catch (error) {
                console.error(`Failed to delete backup file:`, error);
                this.socket.emit('backup:delete:error', {
                    backupId: data.backupId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });
    }

    private async handleServerStart(serverId: string, config: any) {
        // Build startup command with variables
        let startup = config.startup;

        // Replace system variables first
        startup = startup.replace(/{{SERVER_MEMORY}}/g, config.memory.toString());

        // Replace variables in startup command
        if (config.variables) {
            for (const variable of config.variables) {
                startup = startup.replace(
                    new RegExp(`{{${variable.envVariable}}}`, 'g'),
                    variable.value
                );
            }
        }

        // Replace allocation variables
        if (config.allocation) {
            startup = startup.replace(/{{SERVER_IP}}/g, config.allocation.ip);
            startup = startup.replace(/{{SERVER_PORT}}/g, config.allocation.port.toString());
        }

        // Fallback defaults for common vars
        startup = startup.replace(/{{SERVER_JARFILE}}/g, 'server.jar');
        startup = startup.replace(/{{MC_VERSION}}/g, 'latest');

        // Build environment variables
        const env: Record<string, string> = {
            SERVER_MEMORY: config.memory.toString(),
        };
        if (config.variables) {
            for (const variable of config.variables) {
                env[variable.envVariable] = variable.value;
            }
        }
        if (config.allocation) {
            env.SERVER_IP = config.allocation.ip;
            env.SERVER_PORT = config.allocation.port.toString();
        }

        // Start the process
        await this.processManager.startServer(serverId, {
            command: startup,
            env,
            memory: config.memory,
            cpu: config.cpu,
            mounts: config.mounts,
            onOutput: (line: string) => {
                this.socket.emit('server:console', { serverId, line });
            },
            onStatusChange: (status: string) => {
                this.socket.emit('server:status', { serverId, status });
            },
        });
    }

    private startSystemMonitoring() {
        // Send system stats periodically
        setInterval(async () => {
            const stats = await this.resourceMonitor.getSystemStats();
            this.socket.emit('node:stats', stats);

            // Get stats for all running servers
            const serverStats = await this.processManager.getAllServerStats();
            for (const [serverId, stats] of Object.entries(serverStats)) {
                this.socket.emit('server:stats', { serverId, ...stats });
            }
        }, this.config.system.check_interval);
    }

    async shutdown() {
        console.log('🛑 Shutting down daemon...');

        // Stop all servers gracefully
        await this.processManager.stopAllServers();

        // Disconnect from panel
        this.socket.disconnect();

        console.log('👋 Daemon stopped');
        process.exit(0);
    }
}

// Main entry point
const daemon = new Daemon();

process.on('SIGINT', () => daemon.shutdown());
process.on('SIGTERM', () => daemon.shutdown());

daemon.start().catch((error) => {
    console.error('Failed to start daemon:', error);
    process.exit(1);
});
