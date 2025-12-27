import { spawn, ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import pidusage from 'pidusage';

interface ServerProcess {
    process: ChildProcess;
    serverId: string;
    startedAt: Date;
    status: 'STARTING' | 'RUNNING' | 'STOPPING' | 'OFFLINE';
    config: StartConfig;
}

interface StartConfig {
    command: string;
    env: Record<string, string>;
    memory: number;
    cpu: number;
    mounts?: Array<{ source: string; target: string; readOnly: boolean }>;
    onOutput: (line: string) => void;
    onStatusChange: (status: string) => void;
}

export class ProcessManager {
    private dataDirectory: string;
    private servers: Map<string, ServerProcess> = new Map();

    constructor(dataDirectory: string) {
        this.dataDirectory = dataDirectory;
    }

    async createServerDirectory(serverId: string): Promise<void> {
        const serverPath = this.getServerPath(serverId);
        await fs.mkdir(serverPath, { recursive: true });
    }

    async deleteServerDirectory(serverId: string): Promise<void> {
        const serverPath = this.getServerPath(serverId);
        await fs.rm(serverPath, { recursive: true, force: true });
    }

    getServerPath(serverId: string): string {
        return path.join(this.dataDirectory, serverId);
    }

    async startServer(serverId: string, config: StartConfig): Promise<void> {
        // Check if already running
        if (this.servers.has(serverId)) {
            const existing = this.servers.get(serverId)!;
            if (existing.status === 'RUNNING' || existing.status === 'STARTING') {
                throw new Error('Server is already running');
            }
        }

        const serverPath = this.getServerPath(serverId);

        // Ensure server directory exists
        await fs.mkdir(serverPath, { recursive: true });

        // Setup mounts (symlinks)
        if (config.mounts) {
            for (const mount of config.mounts) {
                try {
                    const targetPath = path.join(serverPath, mount.target);
                    // Remove existing symlink or directory if it exists to avoid conflicts
                    try {
                        await fs.rm(targetPath, { recursive: true, force: true });
                    } catch { }

                    // Ensure parent directory exists
                    await fs.mkdir(path.dirname(targetPath), { recursive: true });

                    // Create symlink
                    await fs.symlink(mount.source, targetPath);
                    console.log(`[Mount] Linked ${mount.source} to ${targetPath}`);
                } catch (error) {
                    console.error(`[Mount] Failed to mount ${mount.source}:`, error);
                    config.onOutput(`[DAEMON] Failed to mount ${mount.source}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        }

        // Parse command
        const [cmd, ...args] = this.parseCommand(config.command);

        // Merge environment
        const env = {
            ...process.env,
            ...config.env,
            HOME: serverPath,
        };

        console.log(`Starting server ${serverId}: ${cmd} ${args.join(' ')}`);
        config.onStatusChange('STARTING');

        // Spawn the process
        const childProcess = spawn(cmd, args, {
            cwd: serverPath,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
        });

        const serverProcess: ServerProcess = {
            process: childProcess,
            serverId,
            startedAt: new Date(),
            status: 'STARTING',
            config,
        };

        this.servers.set(serverId, serverProcess);

        // Handle stdout
        childProcess.stdout?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                config.onOutput(line);
            }
        });

        // Handle stderr
        childProcess.stderr?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                config.onOutput(`[ERROR] ${line}`);
            }
        });

        // Mark as running after a short delay (process started successfully)
        setTimeout(() => {
            if (serverProcess.status === 'STARTING' && !childProcess.killed) {
                serverProcess.status = 'RUNNING';
                config.onStatusChange('RUNNING');
            }
        }, 3000);

        // Handle process exit
        childProcess.on('exit', (code, signal) => {
            console.log(`Server ${serverId} exited with code ${code}, signal ${signal}`);
            serverProcess.status = 'OFFLINE';
            config.onStatusChange('OFFLINE');
            this.servers.delete(serverId);
        });

        // Handle errors
        childProcess.on('error', (error) => {
            console.error(`Server ${serverId} error:`, error);
            config.onOutput(`[DAEMON] Error: ${error.message}`);
            serverProcess.status = 'OFFLINE';
            config.onStatusChange('OFFLINE');
            this.servers.delete(serverId);
        });
    }

    async stopServer(serverId: string): Promise<void> {
        const serverProcess = this.servers.get(serverId);
        if (!serverProcess) {
            return; // Already stopped
        }

        serverProcess.status = 'STOPPING';
        serverProcess.config.onStatusChange('STOPPING');

        // Try graceful shutdown first
        // Send stop command if available (e.g., "stop" for Minecraft)
        if (serverProcess.process.stdin?.writable) {
            serverProcess.process.stdin.write('stop\n');
        }

        // Give it time to stop gracefully
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                // Force kill if still running
                if (!serverProcess.process.killed) {
                    console.log(`Force killing server ${serverId}`);
                    serverProcess.process.kill('SIGKILL');
                }
                resolve();
            }, 10000);

            serverProcess.process.on('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    async killServer(serverId: string): Promise<void> {
        const serverProcess = this.servers.get(serverId);
        if (!serverProcess) {
            return;
        }

        serverProcess.process.kill('SIGKILL');
        serverProcess.status = 'OFFLINE';
        serverProcess.config.onStatusChange('OFFLINE');
        this.servers.delete(serverId);
    }

    sendCommand(serverId: string, command: string): void {
        const serverProcess = this.servers.get(serverId);
        if (!serverProcess || !serverProcess.process.stdin?.writable) {
            console.log(`Cannot send command to ${serverId}: not running or stdin not available`);
            return;
        }

        serverProcess.process.stdin.write(command + '\n');
    }

    async stopAllServers(): Promise<void> {
        const stopPromises = Array.from(this.servers.keys()).map(serverId =>
            this.stopServer(serverId)
        );
        await Promise.all(stopPromises);
    }

    async getAllServerStats(): Promise<Record<string, { cpu: number; memory: number }>> {
        const stats: Record<string, { cpu: number; memory: number }> = {};

        for (const [serverId, serverProcess] of this.servers) {
            if (serverProcess.process.pid && serverProcess.status === 'RUNNING') {
                try {
                    const usage = await pidusage(serverProcess.process.pid);
                    stats[serverId] = {
                        cpu: Math.round(usage.cpu * 100) / 100,
                        memory: Math.round(usage.memory / (1024 * 1024)), // Convert to MB
                    };
                } catch (error) {
                    // Process might have exited
                    stats[serverId] = { cpu: 0, memory: 0 };
                }
            }
        }

        return stats;
    }

    getServerStatus(serverId: string): string {
        const serverProcess = this.servers.get(serverId);
        return serverProcess?.status || 'OFFLINE';
    }

    isServerRunning(serverId: string): boolean {
        const serverProcess = this.servers.get(serverId);
        return serverProcess?.status === 'RUNNING' || serverProcess?.status === 'STARTING';
    }

    private parseCommand(command: string): string[] {
        // Simple parsing - split on spaces but respect quotes
        const parts: string[] = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';

        for (const char of command) {
            if ((char === '"' || char === "'") && !inQuotes) {
                inQuotes = true;
                quoteChar = char;
            } else if (char === quoteChar && inQuotes) {
                inQuotes = false;
                quoteChar = '';
            } else if (char === ' ' && !inQuotes) {
                if (current) {
                    parts.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }

        if (current) {
            parts.push(current);
        }

        return parts;
    }
}
