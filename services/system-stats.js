const os = require('os');
const { EventEmitter } = require('events');

function readCpuTotals() {
  return os.cpus().reduce(
    (acc, cpu) => {
      const times = cpu.times || {};
      const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
      return {
        idle: acc.idle + Number(times.idle || 0),
        total: acc.total + total,
      };
    },
    { idle: 0, total: 0 }
  );
}

function cloneStats(stats = {}) {
  return {
    cpuPercent: Number(stats.cpuPercent || 0),
    ramPercent: Number(stats.ramPercent || 0),
    battery: String(stats.battery || 'N/A'),
    sampledAt: String(stats.sampledAt || ''),
  };
}

class SystemStatsMonitor extends EventEmitter {
  constructor({ intervalMs = 5000, powerMonitor = null } = {}) {
    super();
    this.intervalMs = Math.max(1000, Number(intervalMs) || 5000);
    this.powerMonitor = powerMonitor;
    this.timer = null;
    this.previousCpu = readCpuTotals();
    this.currentStats = this.sample();
  }

  sample({ advanceBaseline = true } = {}) {
    const nextCpu = readCpuTotals();
    const totalDelta = nextCpu.total - this.previousCpu.total;
    const idleDelta = nextCpu.idle - this.previousCpu.idle;
    const cpuUsage = totalDelta > 0
      ? (1 - idleDelta / totalDelta) * 100
      : Number(this.currentStats?.cpuPercent || 0);
    if (advanceBaseline) {
      this.previousCpu = nextCpu;
    }

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = Math.max(totalMemory - freeMemory, 0);
    const memoryUsage = totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0;

    let battery = 'N/A';
    try {
      if (this.powerMonitor && typeof this.powerMonitor.isOnBatteryPower === 'function') {
        battery = this.powerMonitor.isOnBatteryPower() ? 'Battery' : 'AC';
      }
    } catch (error) {
      battery = 'N/A';
    }

    const nextStats = {
      cpuPercent: Number(cpuUsage.toFixed(1)),
      ramPercent: Number(memoryUsage.toFixed(1)),
      battery,
      sampledAt: new Date().toISOString(),
    };
    if (advanceBaseline) {
      this.currentStats = nextStats;
    }
    return cloneStats(nextStats);
  }

  getStats({ fresh = false } = {}) {
    return fresh ? this.sample({ advanceBaseline: false }) : cloneStats(this.currentStats);
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.emit('stats', this.sample());
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  SystemStatsMonitor,
};
