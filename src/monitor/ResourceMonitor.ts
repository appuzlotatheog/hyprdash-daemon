import si from 'systeminformation';
import os from 'os';

interface SystemStats {
    cpu: number;
    memory: {
        used: number;
        total: number;
        percent: number;
    };
    disk: {
        used: number;
        total: number;
        percent: number;
    };
    uptime: number;
    loadAverage: number[];
}

export class ResourceMonitor {
    async getSystemStats(): Promise<SystemStats> {
        const [cpuLoad, memInfo, diskInfo] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize(),
        ]);

        // Calculate disk usage from all mount points
        let diskUsed = 0;
        let diskTotal = 0;
        for (const disk of diskInfo) {
            diskUsed += disk.used;
            diskTotal += disk.size;
        }

        return {
            cpu: Math.round(cpuLoad.currentLoad * 100) / 100,
            memory: {
                used: Math.round(memInfo.used / (1024 * 1024)), // MB
                total: Math.round(memInfo.total / (1024 * 1024)), // MB
                percent: Math.round((memInfo.used / memInfo.total) * 10000) / 100,
            },
            disk: {
                used: Math.round(diskUsed / (1024 * 1024)), // MB
                total: Math.round(diskTotal / (1024 * 1024)), // MB
                percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 10000) / 100 : 0,
            },
            uptime: os.uptime(),
            loadAverage: os.loadavg(),
        };
    }

    async getCpuInfo(): Promise<{
        manufacturer: string;
        brand: string;
        cores: number;
        physicalCores: number;
        speed: number;
    }> {
        const cpu = await si.cpu();
        return {
            manufacturer: cpu.manufacturer,
            brand: cpu.brand,
            cores: cpu.cores,
            physicalCores: cpu.physicalCores,
            speed: cpu.speed,
        };
    }

    async getNetworkStats(): Promise<{
        interfaces: Array<{
            name: string;
            rx_bytes: number;
            tx_bytes: number;
            rx_sec: number;
            tx_sec: number;
        }>;
    }> {
        const networkStats = await si.networkStats();

        return {
            interfaces: networkStats.map(iface => ({
                name: iface.iface,
                rx_bytes: iface.rx_bytes,
                tx_bytes: iface.tx_bytes,
                rx_sec: iface.rx_sec || 0,
                tx_sec: iface.tx_sec || 0,
            })),
        };
    }

    async getProcessList(): Promise<Array<{
        pid: number;
        name: string;
        cpu: number;
        memory: number;
    }>> {
        const processes = await si.processes();

        return processes.list
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 10)
            .map(p => ({
                pid: p.pid,
                name: p.name,
                cpu: Math.round(p.cpu * 100) / 100,
                memory: Math.round(p.mem * 100) / 100,
            }));
    }
}
