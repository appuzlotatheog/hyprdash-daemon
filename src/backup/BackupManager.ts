import fs from 'fs/promises';
import { createWriteStream, createReadStream } from 'fs';
import path from 'path';
import archiver from 'archiver';
import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { FileManager } from '../filesystem/FileManager.js';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

interface BackupConfig {
    serverId: string;
    backupId: string;
    ignoredFiles?: string[];
    s3?: {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        path?: string;
    };
}

interface ProgressCallback {
    (progress: number, message: string): void;
}

export class BackupManager {
    private baseDirectory: string;
    private backupDirectory: string;
    private fileManager: FileManager;

    constructor(baseDirectory: string, backupDirectory: string, fileManager: FileManager) {
        this.baseDirectory = baseDirectory;
        this.backupDirectory = backupDirectory;
        this.fileManager = fileManager;
    }

    async createBackup(config: BackupConfig, onProgress: ProgressCallback): Promise<{
        size: number;
        checksum: string;
        path: string;
        isS3: boolean;
    }> {
        const serverDir = path.join(this.baseDirectory, config.serverId);
        const backupName = `${config.backupId}.tar.gz`;
        const localBackupPath = path.join(this.backupDirectory, backupName);

        // Ensure backup directory exists
        await fs.mkdir(this.backupDirectory, { recursive: true });

        console.log(`[Backup] Starting backup for ${config.serverId}`);
        onProgress(0, 'Starting backup...');

        try {
            // Create archive
            await this.createArchive(serverDir, localBackupPath, config.ignoredFiles, (progress) => {
                // Archive creation is 0-80% of progress
                onProgress(Math.floor(progress * 0.8), 'Archiving files...');
            });

            const stats = await fs.stat(localBackupPath);
            const size = stats.size;

            // If S3 is configured, upload it
            if (config.s3) {
                onProgress(80, 'Uploading to S3...');
                await this.uploadToS3(localBackupPath, config.s3, config.backupId, (progress) => {
                    // Upload is 80-100% of progress
                    onProgress(80 + Math.floor(progress * 0.2), 'Uploading to S3...');
                });

                // Delete local file after upload
                await fs.unlink(localBackupPath);

                onProgress(100, 'Backup complete');
                return {
                    size,
                    checksum: '', // TODO: Calculate checksum
                    path: config.s3.path ? path.join(config.s3.path, backupName) : backupName,
                    isS3: true,
                };
            } else {
                onProgress(100, 'Backup complete');
                return {
                    size,
                    checksum: '', // TODO: Calculate checksum
                    path: localBackupPath,
                    isS3: false,
                };
            }
        } catch (error) {
            console.error(`[Backup] Failed:`, error);
            // Clean up partial backup
            try {
                await fs.unlink(localBackupPath);
            } catch { }
            throw error;
        }
    }

    private createArchive(
        sourceDir: string,
        destPath: string,
        ignoredFiles: string[] = [],
        onProgress: (percentage: number) => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const output = createWriteStream(destPath);
            const archive = archiver('tar', {
                gzip: true,
                zlib: { level: 9 },
            });

            output.on('close', () => resolve());
            archive.on('error', (err) => reject(err));
            archive.on('progress', (progress) => {
                if (progress.entries.total > 0) {
                    const percentage = (progress.entries.processed / progress.entries.total) * 100;
                    onProgress(percentage);
                }
            });

            archive.pipe(output);

            // Add files from server directory
            archive.glob('**/*', {
                cwd: sourceDir,
                ignore: ignoredFiles,
                dot: true,
            });

            archive.finalize();
        });
    }

    private async uploadToS3(
        filePath: string,
        s3Config: NonNullable<BackupConfig['s3']>,
        backupId: string,
        onProgress: (percentage: number) => void
    ): Promise<void> {
        const client = new S3Client({
            region: s3Config.region,
            endpoint: s3Config.endpoint,
            credentials: {
                accessKeyId: s3Config.accessKeyId,
                secretAccessKey: s3Config.secretAccessKey,
            },
            forcePathStyle: true, // Needed for some S3 compatible providers like MinIO
        });

        const fileStream = createReadStream(filePath);
        const key = s3Config.path ? path.join(s3Config.path, `${backupId}.tar.gz`) : `${backupId}.tar.gz`;

        const upload = new Upload({
            client,
            params: {
                Bucket: s3Config.bucket,
                Key: key,
                Body: fileStream,
            },
        });

        upload.on('httpUploadProgress', (progress) => {
            if (progress.total) {
                const percentage = (progress.loaded || 0) / progress.total * 100;
                onProgress(percentage);
            }
        });

        await upload.done();
    }

    private async downloadFromS3(
        s3Config: NonNullable<BackupConfig['s3']>,
        backupId: string,
        destPath: string
    ): Promise<void> {
        const client = new S3Client({
            region: s3Config.region,
            endpoint: s3Config.endpoint,
            credentials: {
                accessKeyId: s3Config.accessKeyId,
                secretAccessKey: s3Config.secretAccessKey,
            },
            forcePathStyle: true,
        });

        const key = s3Config.path ? path.join(s3Config.path, `${backupId}.tar.gz`) : `${backupId}.tar.gz`;

        const command = new GetObjectCommand({
            Bucket: s3Config.bucket,
            Key: key,
        });

        const response = await client.send(command);

        if (!response.Body) {
            throw new Error('S3 response body is empty');
        }

        // Stream the S3 object to a file
        await pipeline(
            response.Body as Readable,
            createWriteStream(destPath)
        );
    }

    async restoreBackup(
        serverId: string,
        backupPath: string,
        isS3: boolean,
        s3Config?: BackupConfig['s3']
    ): Promise<void> {
        const serverDir = path.join(this.baseDirectory, serverId);

        // Ensure server dir exists
        await fs.mkdir(serverDir, { recursive: true });

        if (isS3 && s3Config) {
            // Download from S3 first
            const tempBackupPath = path.join(this.backupDirectory, `restore-${path.basename(backupPath)}`);

            try {
                // Extract backup ID from path or filename if needed, but here we assume backupPath is the key or filename
                // Actually, for S3, we need the backup ID to construct the key if we follow the upload pattern
                // But the 'backupPath' argument coming from the database might be the full key or just the filename
                // Let's assume backupPath is what we stored in DB, which is the key or filename.
                // However, downloadFromS3 expects backupId.
                // Let's adjust downloadFromS3 to take the key directly or parse it.
                // Re-reading createBackup: path stored is `config.s3.path ? path.join(config.s3.path, backupName) : backupName`
                // So backupPath IS the key.

                // Let's inline the download logic or adjust the helper to take key
                const client = new S3Client({
                    region: s3Config.region,
                    endpoint: s3Config.endpoint,
                    credentials: {
                        accessKeyId: s3Config.accessKeyId,
                        secretAccessKey: s3Config.secretAccessKey,
                    },
                    forcePathStyle: true,
                });

                const command = new GetObjectCommand({
                    Bucket: s3Config.bucket,
                    Key: backupPath, // backupPath is the Key in S3
                });

                const response = await client.send(command);

                if (!response.Body) {
                    throw new Error('S3 response body is empty');
                }

                await pipeline(
                    response.Body as Readable,
                    createWriteStream(tempBackupPath)
                );

                // Now restore from the downloaded file
                await this.fileManager.extractArchive(serverId, tempBackupPath, '/');

                // Clean up temp file
                await fs.unlink(tempBackupPath);
            } catch (error) {
                // Try to clean up temp file if it exists
                try { await fs.unlink(tempBackupPath); } catch { }
                throw error;
            }
        } else {
            // Local restore
            await this.fileManager.extractArchive(serverId, backupPath, '/');
        }
    }

    async deleteBackup(
        serverId: string,
        backupId: string,
        storagePath: string,
        isS3?: boolean,
        s3Config?: BackupConfig['s3']
    ): Promise<void> {
        if (isS3 && s3Config) {
            const client = new S3Client({
                region: s3Config.region,
                endpoint: s3Config.endpoint,
                credentials: {
                    accessKeyId: s3Config.accessKeyId,
                    secretAccessKey: s3Config.secretAccessKey,
                },
                forcePathStyle: true,
            });

            // storagePath is the key for S3 backups
            await client.send(new DeleteObjectCommand({
                Bucket: s3Config.bucket,
                Key: storagePath,
            }));
        } else {
            // Local delete
            try {
                await fs.unlink(storagePath);
            } catch (error) {
                // Ignore if file doesn't exist
            }
        }
    }
}
