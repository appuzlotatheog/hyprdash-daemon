import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import https from 'https';
import http from 'http';

interface InstallConfig {
    serverId: string;
    egg: {
        name: string;
        startup: string;
        scriptInstall?: string;
        scriptContainer?: string;
    };
    variables: Record<string, string>;
}

interface ProgressCallback {
    (serverId: string, progress: number, message: string): void;
}

export class InstallManager {
    private baseDirectory: string;
    private activeInstalls: Map<string, ChildProcess> = new Map();

    constructor(baseDirectory: string) {
        this.baseDirectory = path.resolve(baseDirectory);
    }

    async installServer(
        config: InstallConfig,
        onProgress: ProgressCallback
    ): Promise<void> {
        const serverDir = path.join(this.baseDirectory, config.serverId);

        console.log(`📥 Starting installation for server ${config.serverId}`);
        onProgress(config.serverId, 0, 'Starting installation...');

        try {
            // Ensure server directory exists
            await fs.mkdir(serverDir, { recursive: true });
            onProgress(config.serverId, 10, 'Created server directory');

            // Check if we have an install script
            if (config.egg.scriptInstall) {
                onProgress(config.serverId, 20, 'Running installation script...');
                await this.runInstallScript(config, serverDir, onProgress);
            } else {
                // No install script - try to download based on egg name
                onProgress(config.serverId, 20, 'Downloading server files...');
                await this.downloadServerFiles(config, serverDir, onProgress);
            }

            onProgress(config.serverId, 100, 'Installation complete!');
            console.log(`✅ Installation complete for server ${config.serverId}`);
        } catch (error) {
            console.error(`❌ Installation failed for ${config.serverId}:`, error);
            throw error;
        }
    }

    private async runInstallScript(
        config: InstallConfig,
        serverDir: string,
        onProgress: ProgressCallback
    ): Promise<void> {
        return new Promise(async (resolve, reject) => {
            const script = config.egg.scriptInstall!;

            // Create a temporary script file
            const scriptPath = path.join(serverDir, '.install.sh');
            await fs.writeFile(scriptPath, script, { mode: 0o755 });

            // Prepare environment variables
            const env: Record<string, string> = {
                ...process.env as Record<string, string>,
                SERVER_MEMORY: config.variables.SERVER_MEMORY || '1024',
                SERVER_IP: config.variables.SERVER_IP || '0.0.0.0',
                SERVER_PORT: config.variables.SERVER_PORT || '25565',
                SERVER_JARFILE: config.variables.SERVER_JARFILE || 'server.jar',
                MC_VERSION: config.variables.MC_VERSION || 'latest',
                PAPER_BUILD: config.variables.PAPER_BUILD || 'latest',
                ...config.variables,
            };

            console.log(`🔧 Running install script for ${config.serverId}`);
            console.log(`📁 Script path: ${scriptPath}`);
            console.log(`📁 Server dir: ${serverDir}`);

            const child = spawn('bash', [scriptPath], {
                cwd: serverDir,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            this.activeInstalls.set(config.serverId, child);

            let output = '';
            let progress = 30;

            child.stdout?.on('data', (data: Buffer) => {
                const line = data.toString();
                output += line;
                console.log(`[Install ${config.serverId}] ${line.trim()}`);

                // Update progress based on output
                if (line.includes('Downloading')) progress = Math.min(progress + 10, 80);
                if (line.includes('Installing')) progress = Math.min(progress + 10, 80);
                if (line.includes('complete') || line.includes('Complete')) progress = 90;

                onProgress(config.serverId, progress, line.trim());
            });

            child.stderr?.on('data', (data: Buffer) => {
                console.error(`[Install ${config.serverId} ERR] ${data.toString().trim()}`);
            });

            child.on('close', async (code) => {
                this.activeInstalls.delete(config.serverId);

                // Clean up install script
                try {
                    await fs.unlink(scriptPath);
                } catch { }

                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Install script exited with code ${code}`));
                }
            });

            child.on('error', (error) => {
                this.activeInstalls.delete(config.serverId);
                reject(error);
            });

            // Timeout after 10 minutes
            setTimeout(() => {
                if (this.activeInstalls.has(config.serverId)) {
                    child.kill();
                    this.activeInstalls.delete(config.serverId);
                    reject(new Error('Installation timed out after 10 minutes'));
                }
            }, 10 * 60 * 1000);
        });
    }

    private async downloadServerFiles(
        config: InstallConfig,
        serverDir: string,
        onProgress: ProgressCallback
    ): Promise<void> {
        const eggName = config.egg.name.toLowerCase();
        const jarFile = config.variables.SERVER_JARFILE || 'server.jar';

        if (eggName.includes('paper')) {
            await this.downloadPaper(config, serverDir, jarFile, onProgress);
        } else if (eggName.includes('vanilla')) {
            await this.downloadVanilla(config, serverDir, jarFile, onProgress);
        } else if (eggName.includes('forge')) {
            onProgress(config.serverId, 50, 'Forge download requires install script');
            // Create a placeholder - Forge is complex
            await fs.writeFile(
                path.join(serverDir, 'README.txt'),
                'Forge server requires manual installation or Docker-based install script.\n'
            );
        } else {
            onProgress(config.serverId, 50, `Unknown egg type: ${config.egg.name}`);
        }
    }

    private async downloadPaper(
        config: InstallConfig,
        serverDir: string,
        jarFile: string,
        onProgress: ProgressCallback
    ): Promise<void> {
        let version = config.variables.MC_VERSION || 'latest';
        let build = config.variables.PAPER_BUILD || 'latest';

        onProgress(config.serverId, 30, 'Fetching Paper version info...');

        try {
            // Get latest version if needed
            if (version === 'latest') {
                const versions = await this.fetchJson('https://api.papermc.io/v2/projects/paper');
                version = versions.versions[versions.versions.length - 1];
            }

            // Get latest build if needed
            if (build === 'latest') {
                const builds = await this.fetchJson(
                    `https://api.papermc.io/v2/projects/paper/versions/${version}`
                );
                build = builds.builds[builds.builds.length - 1].toString();
            }

            onProgress(config.serverId, 50, `Downloading Paper ${version} build ${build}...`);

            // Get download URL
            const buildInfo = await this.fetchJson(
                `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${build}`
            );

            const downloadName = buildInfo.downloads?.application?.name;
            if (!downloadName) {
                throw new Error('Could not find download URL');
            }

            const downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${build}/downloads/${downloadName}`;

            // Download the JAR
            const jarPath = path.join(serverDir, jarFile);
            await this.downloadFile(downloadUrl, jarPath, (progress) => {
                onProgress(config.serverId, 50 + Math.floor(progress * 0.4), `Downloading: ${Math.floor(progress)}%`);
            });

            onProgress(config.serverId, 95, 'Creating EULA file...');

            // Create eula.txt
            await fs.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');

            console.log(`✅ Downloaded Paper ${version} build ${build}`);
        } catch (error) {
            console.error('Paper download failed:', error);
            throw new Error(`Failed to download Paper: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async downloadVanilla(
        config: InstallConfig,
        serverDir: string,
        jarFile: string,
        onProgress: ProgressCallback
    ): Promise<void> {
        const version = config.variables.MC_VERSION || '1.20.4';

        onProgress(config.serverId, 30, 'Fetching Minecraft version info...');

        try {
            // Get version manifest
            const manifest = await this.fetchJson(
                'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
            );

            let targetVersion = version;
            if (version === 'latest') {
                targetVersion = manifest.latest.release;
            }

            const versionInfo = manifest.versions.find((v: any) => v.id === targetVersion);
            if (!versionInfo) {
                throw new Error(`Version ${targetVersion} not found`);
            }

            // Get version details
            const versionDetails = await this.fetchJson(versionInfo.url);
            const serverUrl = versionDetails.downloads?.server?.url;

            if (!serverUrl) {
                throw new Error('Server download URL not found');
            }

            onProgress(config.serverId, 50, `Downloading Minecraft ${targetVersion}...`);

            const jarPath = path.join(serverDir, jarFile);
            await this.downloadFile(serverUrl, jarPath, (progress) => {
                onProgress(config.serverId, 50 + Math.floor(progress * 0.4), `Downloading: ${Math.floor(progress)}%`);
            });

            onProgress(config.serverId, 95, 'Creating EULA file...');
            await fs.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');

            console.log(`✅ Downloaded Minecraft Vanilla ${targetVersion}`);
        } catch (error) {
            console.error('Vanilla download failed:', error);
            throw new Error(`Failed to download Vanilla: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private fetchJson(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;

            protocol.get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    // Follow redirect
                    return this.fetchJson(res.headers.location!).then(resolve).catch(reject);
                }

                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Failed to parse JSON response'));
                    }
                });
            }).on('error', reject);
        });
    }

    private downloadFile(
        url: string,
        destPath: string,
        onProgress: (progress: number) => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;

            protocol.get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return this.downloadFile(res.headers.location!, destPath, onProgress)
                        .then(resolve)
                        .catch(reject);
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const totalSize = parseInt(res.headers['content-length'] || '0', 10);
                let downloadedSize = 0;

                const file = fsSync.createWriteStream(destPath);

                res.on('data', (chunk: Buffer) => {
                    downloadedSize += chunk.length;
                    if (totalSize > 0) {
                        onProgress((downloadedSize / totalSize) * 100);
                    }
                });

                res.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve();
                });

                file.on('error', (err: Error) => {
                    fs.unlink(destPath).catch(() => { });
                    reject(err);
                });
            }).on('error', reject);
        });
    }

    cancelInstall(serverId: string): boolean {
        const process = this.activeInstalls.get(serverId);
        if (process) {
            process.kill();
            this.activeInstalls.delete(serverId);
            return true;
        }
        return false;
    }
}
