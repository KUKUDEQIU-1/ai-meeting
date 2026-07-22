function nowIso() {
  return new Date().toISOString();
}

export function createFeishuScanCoordinator() {
  let activeScan = null;

  return {
    snapshot() {
      return {
        running: Boolean(activeScan),
        active_scan: activeScan ? { ...activeScan } : null
      };
    },

    async runScan(type, scan) {
      if (activeScan) {
        return {
          success: false,
          status: 'already_running',
          reason: 'feishu_scan_already_running',
          running_scan: { ...activeScan }
        };
      }

      activeScan = { type, started_at: nowIso() };

      try {
        return await scan();
      } finally {
        activeScan = null;
      }
    }
  };
}

export const feishuScanCoordinator = createFeishuScanCoordinator();
