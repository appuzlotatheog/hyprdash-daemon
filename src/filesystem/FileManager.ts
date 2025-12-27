import fs from 'fs/promises';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import archiver from 'archiver';
import * as tar from 'tar';

interface FileInfo {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modified: Date;
    permissions: string;
}

export class FileManager {
    private baseDirectory: string;

    constructor(baseDirectory: string) {
        this.baseDirectory = baseDirectory;
    }

    private resolvePath(serverId: string, filePath: string): string {
        // Resolve and validate path to prevent directory traversal
        const serverDir = path.resolve(this.baseDirectory, serverId);

        // Normalize the path - remove leading slashes and handle empty/root path
        let normalizedPath = filePath || '';
        if (normalizedPath === '/' || normalizedPath === '') {
            normalizedPath = '.';
        } else {
            // Remove leading slash to make it relative
            normalizedPath = normalizedPath.replace(/^\/+/, '');
        }

        const resolved = path.resolve(serverDir, normalizedPath);

        // Check that resolved path is within server directory
        // Use path.sep to ensure we're checking the actual directory, not just a prefix
        const normalizedServerDir = path.normalize(serverDir);
        const normalizedResolved = path.normalize(resolved);

        if (normalizedResolved !== normalizedServerDir && !normalizedResolved.startsWith(normalizedServerDir + path.sep)) {
            console.log(`Path traversal blocked: ${normalizedResolved} is not within ${normalizedServerDir}`);
            throw new Error('Access denied: Path traversal attempt detected');
        }

        return resolved;
    }

    async listDirectory(serverId: string, dirPath: string = '/'): Promise<FileInfo[]> {
        const fullPath = this.resolvePath(serverId, dirPath);

        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const files: FileInfo[] = [];

        for (const entry of entries) {
            const entryPath = path.join(fullPath, entry.name);
            const stats = await fs.stat(entryPath);

            files.push({
                name: entry.name,
                path: path.join(dirPath, entry.name),
                isDirectory: entry.isDirectory(),
                size: stats.size,
                modified: stats.mtime,
                permissions: (stats.mode & 0o777).toString(8),
            });
        }

        // Sort: directories first, then alphabetically
        return files.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });
    }

    async readFile(serverId: string, filePath: string): Promise<string> {
        const fullPath = this.resolvePath(serverId, filePath);
        return fs.readFile(fullPath, 'utf-8');
    }

    async writeFile(serverId: string, filePath: string, content: string | Buffer): Promise<void> {
        const fullPath = this.resolvePath(serverId, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        // Write as buffer if binary, otherwise as utf-8 string
        if (Buffer.isBuffer(content)) {
            await fs.writeFile(fullPath, content);
        } else {
            await fs.writeFile(fullPath, content, 'utf-8');
        }
    }

    async createDirectory(serverId: string, dirPath: string): Promise<void> {
        const fullPath = this.resolvePath(serverId, dirPath);
        await fs.mkdir(fullPath, { recursive: true });
    }

    async deleteFile(serverId: string, filePath: string): Promise<void> {
        const fullPath = this.resolvePath(serverId, filePath);
        const stats = await fs.stat(fullPath);

        if (stats.isDirectory()) {
            await fs.rm(fullPath, { recursive: true });
        } else {
            await fs.unlink(fullPath);
        }
    }

    async renameFile(serverId: string, oldPath: string, newPath: string): Promise<void> {
        const fullOldPath = this.resolvePath(serverId, oldPath);
        const fullNewPath = this.resolvePath(serverId, newPath);
        await fs.rename(fullOldPath, fullNewPath);
    }

    async copyFile(serverId: string, sourcePath: string, destPath: string): Promise<void> {
        const fullSourcePath = this.resolvePath(serverId, sourcePath);
        const fullDestPath = this.resolvePath(serverId, destPath);

        const stats = await fs.stat(fullSourcePath);

        if (stats.isDirectory()) {
            await this.copyDirectory(fullSourcePath, fullDestPath);
        } else {
            await fs.mkdir(path.dirname(fullDestPath), { recursive: true });
            await fs.copyFile(fullSourcePath, fullDestPath);
        }
    }

    private async copyDirectory(source: string, dest: string): Promise<void> {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(source, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(source, entry.name);
            const destPath = path.join(dest, entry.name);

            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }

    async createArchive(
        serverId: string,
        filePaths: string[],
        outputName: string,
        format: 'zip' | 'tar.gz' = 'zip'
    ): Promise<string> {
        const serverDir = path.join(this.baseDirectory, serverId);
        const outputPath = path.join(serverDir, outputName);

        return new Promise((resolve, reject) => {
            const output = createWriteStream(outputPath);

            let archive: archiver.Archiver;
            if (format === 'zip') {
                archive = archiver('zip', { zlib: { level: 9 } });
            } else {
                archive = archiver('tar', { gzip: true });
            }

            output.on('close', () => resolve(outputPath));
            archive.on('error', reject);

            archive.pipe(output);

            for (const filePath of filePaths) {
                const fullPath = this.resolvePath(serverId, filePath);
                archive.file(fullPath, { name: path.basename(filePath) });
            }

            archive.finalize();
        });
    }

    async extractArchive(serverId: string, archivePath: string, destPath: string): Promise<void> {
        const fullArchivePath = this.resolvePath(serverId, archivePath);
        const fullDestPath = this.resolvePath(serverId, destPath);

        await fs.mkdir(fullDestPath, { recursive: true });

        const ext = path.extname(archivePath).toLowerCase();

        if (ext === '.tar' || archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
            await tar.extract({
                file: fullArchivePath,
                cwd: fullDestPath,
            });
        } else {
            throw new Error('Unsupported archive format. Use tar, tar.gz, or tgz.');
        }
    }

    async getFileStats(serverId: string, filePath: string): Promise<{
        size: number;
        created: Date;
        modified: Date;
        isDirectory: boolean;
    }> {
        const fullPath = this.resolvePath(serverId, filePath);
        const stats = await fs.stat(fullPath);

        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            isDirectory: stats.isDirectory(),
        };
    }

    async searchFiles(serverId: string, pattern: string, directory: string = '/'): Promise<string[]> {
        const fullPath = this.resolvePath(serverId, directory);
        const results: string[] = [];

        const search = async (dir: string, relativePath: string) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const entryPath = path.join(relativePath, entry.name);

                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                    results.push(entryPath);
                }

                if (entry.isDirectory() && results.length < 100) {
                    await search(path.join(dir, entry.name), entryPath);
                }
            }
        };

        await search(fullPath, '/');
        return results;
    }

    getReadStream(serverId: string, filePath: string) {
        const fullPath = this.resolvePath(serverId, filePath);
        return createReadStream(fullPath);
    }

    getWriteStream(serverId: string, filePath: string) {
        const fullPath = this.resolvePath(serverId, filePath);
        return createWriteStream(fullPath);
    }
}
