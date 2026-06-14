import http from "http";
import fs from "fs";
import Docker from "dockerode";

export interface ContainerState {
  id: string;
  name: string;
  image: string;
  status: 'running' | 'restarting' | 'exited' | 'paused';
  health: 'healthy' | 'unhealthy' | 'none';
  cpu: number; // percentage
  memory: number; // MB
  memoryLimit: number; // MB
  restartCount: number;
  uptime: string;
  uptimeSeconds: number;
  logs: string[];
  ports: string[];
  createdAt: string; // ISO Date String
  ageDescription: string; // e.g. "Created 4 hours ago"
}

// Helper to determine human-friendly created timestamps
export function getHumanUptime(seconds: number, status: string): string {
  if (status === 'exited') return "Stopped";
  if (status === 'restarting') return "Restarting Cycle Active";
  if (seconds >= 86400 * 2) return `Running for ${Math.floor(seconds / 86400)} days`;
  if (seconds >= 3600) return `Running for ${Math.floor(seconds / 3600)} hours`;
  return `Running for ${Math.floor(seconds / 60)} minutes`;
}

// Multiplexed stream log parser for Docker's Remote Engine API standard format
export function parseRawLogs(textOrBuffer: any): string[] {
  if (typeof textOrBuffer === 'string') {
    return textOrBuffer.split('\n').map((l: string) => l.trim()).filter(Boolean);
  }

  if (Buffer.isBuffer(textOrBuffer)) {
    // Check if it's multiplexed (first byte is 1 or 2, and following 3 bytes are null)
    if (
      textOrBuffer.length >= 8 &&
      (textOrBuffer[0] === 1 || textOrBuffer[0] === 2) &&
      textOrBuffer[1] === 0 &&
      textOrBuffer[2] === 0 &&
      textOrBuffer[3] === 0
    ) {
      try {
        const lines: string[] = [];
        let offset = 0;
        while (offset < textOrBuffer.length) {
          if (offset + 8 > textOrBuffer.length) break;
          const size = textOrBuffer.readUInt32BE(offset + 4);
          if (offset + 8 + size > textOrBuffer.length) {
            const text = textOrBuffer.subarray(offset + 8).toString('utf8');
            lines.push(...text.split('\n'));
            break;
          }
          const text = textOrBuffer.subarray(offset + 8, offset + 8 + size).toString('utf8');
          lines.push(...text.split('\n'));
          offset += 8 + size;
        }
        return lines.map((l: string) => l.trim()).filter(Boolean);
      } catch {
        return textOrBuffer.toString('utf8').split('\n').map((l: string) => l.trim()).filter(Boolean);
      }
    } else {
      return textOrBuffer.toString('utf8').split('\n').map((l: string) => l.trim()).filter(Boolean);
    }
  }
  return [];
}

export class DockerClient {
  get containers() {
    return {
      list: async (options: { all?: boolean } = {}) => {
        return await DockerExecutor.getStatus();
      }
    };
  }
}

export const client = new DockerClient();

// Docker command handlers (Strictly live connection to local engine)
export class DockerExecutor {
  private static readonly dockerMode: 'live' = 'live';

  static getDockerMode(): 'live' {
    return 'live';
  }

  static setDockerMode(mode: 'live') {
    // Locked to live mode
  }

  static getDockerHostUrl(): string {
    if (process.platform === 'win32') {
      try {
        if (fs.existsSync('\\\\.\\pipe\\dockerDesktopLinuxEngine')) {
          return "npipe:////./pipe/dockerDesktopLinuxEngine";
        }
      } catch (e) {}
      try {
        if (fs.existsSync('\\\\.\\pipe\\docker_engine')) {
          return "npipe:////./pipe/docker_engine";
        }
      } catch (e) {}
    }
    return "Local Docker Desktop socket/named pipe";
  }

  static setDockerHostUrl(url: string) {
    // No-op for safety
  }

  // Windows Named Pipe and Context Auto-Detection
  private static getDockerInstance(): Docker {
    if (process.platform === 'win32') {
      try {
        if (fs.existsSync('\\\\.\\pipe\\dockerDesktopLinuxEngine')) {
          return new Docker({ socketPath: '//./pipe/dockerDesktopLinuxEngine' });
        }
      } catch (e) {}
      try {
        if (fs.existsSync('\\\\.\\pipe\\docker_engine')) {
          return new Docker({ socketPath: '//./pipe/docker_engine' });
        }
      } catch (e) {}
    }
    return new Docker();
  }

  // Parse error responses to provide meaningful debugging suggestions
  static getDetailedError(err: any): string {
    if (!err) return "Not connected to local Docker.";
    const msg = (err.message || String(err)).toLowerCase();
    
    if (msg.includes("econnrefused") || msg.includes("enoent") || msg.includes("connect enoent") || msg.includes("connection refused") || msg.includes("could not connect")) {
      return "Docker Desktop not running";
    }
    if (msg.includes("eacces") || msg.includes("permission denied")) {
      return "Permission denied";
    }
    if (msg.includes("wrong endpoint") || msg.includes("enoprotoopt") || msg.includes("invalid endpoint")) {
      return "Wrong Docker endpoint";
    }
    if (this.dockerMode === ('simulation' as any)) {
      return "Sandbox active";
    }
    
    return `Not connected to local Docker. Details: ${err.message || err}`;
  }

  static async getStatus(): Promise<ContainerState[]> {
    try {
      const docker = this.getDockerInstance();
      const rawContainers = await docker.listContainers({ all: true });
      
      const mapped: ContainerState[] = await Promise.all(
        rawContainers.map(async (item) => {
          const id = item.Id.substring(0, 12);
          const name = (item.Names && item.Names.length > 0) ? item.Names[0].replace(/^\//, '') : id;
          const image = item.Image;
          const status = item.State; // e.g. "running", "exited", etc.
          const createdAt = new Date(item.Created * 1000).toISOString();
          
          let restartCount = 0;
          let health: 'healthy' | 'unhealthy' | 'none' = 'none';
          let ports: string[] = [];
          
          if (item.Ports) {
            ports = item.Ports.map((p: any) => p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`).filter(Boolean);
          }

          // Inspect container to get details and health checks
          try {
            const containerObj = docker.getContainer(item.Id);
            const inspect = await containerObj.inspect();
            restartCount = inspect.RestartCount || 0;
            const rawHealth = inspect.State?.Health?.Status;
            if (rawHealth === 'healthy') {
              health = 'healthy';
            } else if (rawHealth === 'unhealthy') {
              health = 'unhealthy';
            }
          } catch (e) {
            // ignore inspect failures
          }

          // Fetch metrics
          let cpu = 0;
          let memory = 0;
          let memoryLimit = 512;
          
          if (status === 'running') {
            try {
              const containerObj = docker.getContainer(item.Id);
              const stats = await containerObj.stats({ stream: false }) as any;
              
              if (stats.memory_stats) {
                const usage = stats.memory_stats.usage || 0;
                const limit = stats.memory_stats.limit || (1024 * 1024 * 1024);
                memory = Number((usage / (1024 * 1024)).toFixed(1));
                memoryLimit = Number((limit / (1024 * 1024)).toFixed(0));
              }
              
              if (stats.cpu_stats && stats.precpu_stats) {
                const cpuDelta = (stats.cpu_stats.cpu_usage?.total_usage || 0) - (stats.precpu_stats.cpu_usage?.total_usage || 0);
                const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
                if (systemDelta > 0 && cpuDelta > 0) {
                  const numCpus = stats.cpu_stats.online_cpus || 1;
                  cpu = Number(((cpuDelta / systemDelta) * numCpus * 100).toFixed(1));
                }
              }
            } catch (e) {
              // ignore metrics fetch errors
            }
          }

          return {
            id,
            name,
            image,
            status: (['running', 'restarting', 'exited', 'paused'].includes(status) ? status : 'exited') as any,
            health,
            cpu,
            memory,
            memoryLimit: memoryLimit > 0 ? memoryLimit : 512,
            restartCount,
            uptime: item.Status || 'Status Unavailable',
            uptimeSeconds: status === 'running' ? 3600 : 0,
            ports,
            createdAt,
            ageDescription: `Created ${item.Status || 'some time ago'}`,
            logs: []
          };
        })
      );
      return mapped;
    } catch (err: any) {
      console.warn("[DockerExecutor] Live containers fetch failure.", err.message);
      throw new Error(this.getDetailedError(err));
    }
  }

  static async getHealth() {
    try {
      const list = await this.getStatus();
      return list.map(c => ({
        name: c.name,
        status: c.status,
        health: c.health,
        restartCount: c.restartCount,
        issue: c.health === 'unhealthy' 
          ? (c.status === 'restarting' ? "Restarting cycle detected" : "Resource bottleneck / load latency") 
          : "None",
        createdAt: c.createdAt,
        ageDescription: c.ageDescription
      }));
    } catch (err: any) {
      throw new Error(this.getDetailedError(err));
    }
  }

  static async getStats() {
    try {
      const list = await this.getStatus();
      return list.map(c => ({
        name: c.name,
        cpu: `${c.cpu}%`,
        memory: `${c.memory}MB / ${c.memoryLimit}MB`,
        memoryUsagePercentage: `${((c.memory / c.memoryLimit) * 100).toFixed(1)}%`,
        status: c.status,
        memoryVal: c.memory
      }));
    } catch (err: any) {
      throw new Error(this.getDetailedError(err));
    }
  }

  static async getLogs(containerNameOrId: string) {
    try {
      const docker = this.getDockerInstance();
      const container = docker.getContainer(containerNameOrId);
      const logBuffer = await container.logs({
        stdout: true,
        stderr: true,
        tail: 100,
        timestamps: false
      });
      const logs = parseRawLogs(logBuffer);
      return {
        success: true,
        containerName: containerNameOrId,
        logs: logs
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to retrieve logs from live Docker instance: ${this.getDetailedError(err)}`
      };
    }
  }

  static async getImages() {
    try {
      const docker = this.getDockerInstance();
      const images = await docker.listImages();
      return (images || []).map((img: any) => {
        const repoTag = img.RepoTags && img.RepoTags.length > 0 ? img.RepoTags[0] : '<none>:<none>';
        const parts = repoTag.split(':');
        const tag = parts.pop() || 'latest';
        const nameAndRegistry = parts.join(':');
        const nameParts = nameAndRegistry.split('/');
        const name = nameParts.pop() || 'unnamed';
        const registry = nameParts.join('/') || 'library';
        
        return {
          registry: registry,
          name: name,
          tag: tag,
          size: `${((img.Size || 0) / (1024 * 1024)).toFixed(1)} MB`,
          id: img.Id?.substring(0, 19) || 'unknown',
          age: 'Unknown age'
        };
      });
    } catch (err: any) {
      throw new Error(this.getDetailedError(err));
    }
  }

  static async getInfo() {
    try {
      const docker = this.getDockerInstance();
      const info = await docker.info();
      const versionInfo = await docker.version();
      return {
        version: `Docker Engine v${versionInfo.Version || 'unknown'}`,
        apiVers: versionInfo.ApiVersion || "1.45",
        os: info.OperatingSystem || "Unknown OS",
        kernel: info.KernelVersion || "Unknown Kernel",
        arch: info.Architecture || "x86_64",
        cpus: info.NCPU || 2,
        totalMemory: `${((info.MemTotal || 0) / (1024 * 1024 * 1024)).toFixed(2)} GB`,
        storageDriver: info.Driver || "overlay2",
        containersTotal: info.Containers || 0,
        runningContainers: info.ContainersRunning || 0
      };
    } catch (err: any) {
      throw new Error(this.getDetailedError(err));
    }
  }

  static async getSummary() {
    try {
      const list = await this.getStatus();
      const running = list.filter(c => c.status === 'running').length;
      const restarting = list.filter(c => c.status === 'restarting').length;
      const exited = list.filter(c => c.status === 'exited').length;
      const unhealthy = list.filter(c => c.health === 'unhealthy').length;

      const totalCpu = list.reduce((sum, c) => sum + c.cpu, 0);
      const totalMemory = list.reduce((sum, c) => sum + c.memory, 0);

      return {
        total: list.length,
        running,
        restarting,
        exited,
        unhealthy,
        systemMetrics: {
          avgCpuUsage: `${(totalCpu / Math.max(1, list.length)).toFixed(1)}%`,
          totalMemoryUsage: `${totalMemory.toFixed(1)} MB`,
          healthRatio: `${(((list.length - unhealthy) / Math.max(1, list.length)) * 100).toFixed(0)}%`
        }
      };
    } catch (err: any) {
      throw new Error(this.getDetailedError(err));
    }
  }

  static async startContainer(target: string): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const docker = this.getDockerInstance();
      const container = docker.getContainer(target);
      await container.start();
      return {
        success: true,
        message: `Container '${target}' started successfully on live host.`
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to start container: ${this.getDetailedError(err)}`
      };
    }
  }

  static async stopContainer(target: string): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const docker = this.getDockerInstance();
      const container = docker.getContainer(target);
      await container.stop();
      return {
        success: true,
        message: `Container '${target}' stopped successfully on live host.`
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to stop container: ${this.getDetailedError(err)}`
      };
    }
  }

  static async restartContainer(target: string): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const docker = this.getDockerInstance();
      const container = docker.getContainer(target);
      await container.restart();
      return {
        success: true,
        message: `Container '${target}' restarted successfully on live host.`
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to restart container: ${this.getDetailedError(err)}`
      };
    }
  }

  static async deleteContainer(target: string): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const docker = this.getDockerInstance();
      const container = docker.getContainer(target);
      await container.remove({ force: true });
      return {
        success: true,
        message: `Container '${target}' removed successfully from live host.`
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to remove container: ${this.getDetailedError(err)}`
      };
    }
  }

  static async executeAction(action: string, target?: string): Promise<any> {
    const cleanAction = action.toLowerCase().trim();

    switch (cleanAction) {
      case 'status':
        return { success: true, action: 'status', data: await this.getStatus() };
      case 'health':
        return { success: true, action: 'health', data: await this.getHealth() };
      case 'stats':
        return { success: true, action: 'stats', data: await this.getStats() };
      case 'logs':
        if (!target) {
          return { success: false, error: 'Logs action requires a target container name.' };
        }
        return await this.getLogs(target);
      case 'images':
        return { success: true, action: 'images', data: await this.getImages() };
      case 'info':
        return { success: true, action: 'info', data: await this.getInfo() };
      case 'summary':
        return { success: true, action: 'summary', data: await this.getSummary() };
      
      // Control operators
      case 'start':
        if (!target) return { success: false, error: 'Start action requires a target container.' };
        return await this.startContainer(target);
      case 'stop':
        if (!target) return { success: false, error: 'Stop action requires a target container.' };
        return await this.stopContainer(target);
      case 'restart':
        if (!target) return { success: false, error: 'Restart action requires a target container.' };
        return await this.restartContainer(target);
      case 'delete':
        if (!target) return { success: false, error: 'Delete action requires a target container.' };
        return await this.deleteContainer(target);

      default:
        return { success: true, action: 'status', data: await this.getStatus() };
    }
  }

  static tickSimulation() {
    return true;
  }
}
