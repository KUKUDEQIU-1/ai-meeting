function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeMetadata(type, metadata = {}) {
  const route = normalizeText(metadata.route);
  const capability = normalizeText(metadata.capability);
  const equivalenceKey = normalizeText(metadata.equivalenceKey) ?? normalizeText(metadata.equivalence_key) ?? type;
  const mode = normalizeText(metadata.mode);

  return {
    type,
    route,
    capability,
    equivalence_key: equivalenceKey,
    mode
  };
}

function createRunId(sequence) {
  return `feishu_scan_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

function buildActiveScan(type, metadata, sequence) {
  return {
    run_id: createRunId(sequence),
    ...normalizeMetadata(type, metadata),
    started_at: nowIso()
  };
}

function completeActiveScan(activeScan, result) {
  const completed = { ...result };
  Object.defineProperties(completed, {
    run_id: { value: activeScan.run_id, enumerable: false, configurable: true },
    type: { value: activeScan.type, enumerable: false, configurable: true },
    route: { value: activeScan.route, enumerable: false, configurable: true },
    capability: { value: activeScan.capability, enumerable: false, configurable: true },
    equivalence_key: { value: activeScan.equivalence_key, enumerable: false, configurable: true },
    mode: { value: activeScan.mode, enumerable: false, configurable: true },
    started_at: { value: activeScan.started_at, enumerable: false, configurable: true },
    finished_at: { value: nowIso(), enumerable: false, configurable: true },
    status: {
      value: result?.status || (result?.success === false ? 'failed' : 'success'),
      enumerable: false,
      configurable: true
    }
  });

  return completed;
}

function isEquivalentScan(activeScan, type, metadata) {
  const explicitKey = normalizeText(metadata.equivalenceKey) ?? normalizeText(metadata.equivalence_key);

  if (!explicitKey) {
    return activeScan.type === type;
  }

  return activeScan.equivalence_key === explicitKey;
}

export function createFeishuScanCoordinator() {
  let activeScan = null;
  let runSequence = 0;

  return {
    snapshot() {
      return {
        running: Boolean(activeScan),
        active_scan: activeScan ? { ...activeScan } : null
      };
    },

    publicSnapshot() {
      return {
        running: Boolean(activeScan),
        active_scan: activeScan ? {
          type: activeScan.type,
          started_at: activeScan.started_at
        } : null
      };
    },

    async runScan(type, scan, metadata = {}) {
      if (activeScan) {
        const equivalent = isEquivalentScan(activeScan, type, metadata);
        return {
          success: false,
          status: 'already_running',
          reason: equivalent ? 'feishu_equivalent_scan_already_running' : 'feishu_scan_already_running',
          running_scan: { ...activeScan },
          active_scan: { ...activeScan }
        };
      }

      runSequence += 1;
      activeScan = buildActiveScan(type, metadata, runSequence);

      try {
        return completeActiveScan(activeScan, await scan());
      } finally {
        activeScan = null;
      }
    }
  };
}

export const feishuScanCoordinator = createFeishuScanCoordinator();
