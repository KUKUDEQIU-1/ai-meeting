import assert from 'node:assert/strict';
import {
  clearMasterTaskAuditCache,
  listMasterTaskAuditRecords,
  updateMasterTaskProgress,
  validateMasterTaskAuditFields
} from '../services/feishuBitableClient.js';

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body
  };
}

function fieldItems() {
  return [
    { field_name: '事务需求名称' },
    { field_name: '需求状态' },
    { field_name: '跟进人' },
    { field_name: '备注' },
    { field_name: '任务进展描述' },
    { field_name: '完成日期' }
  ];
}

function recordItems(label = 'A') {
  return [{
    record_id: `rec_${label}`,
    fields: {
      事务需求名称: `任务 ${label}`,
      需求状态: '进行中',
      跟进人: '洪伟填',
      备注: `备注 ${label}`,
      任务进展描述: `进展 ${label}`
    }
  }];
}

function installFetch(routes) {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method || 'GET';
    requests.push({ href, method });

    if (href.includes('/fields')) return routes.fields({ href, method });
    if (href.includes('/records/rec_')) return routes.update({ href, method });
    if (href.includes('/records')) return routes.records({ href, method });

    throw new Error(`unexpected request ${href}`);
  };

  return {
    requests,
    restore: () => {
      globalThis.fetch = previousFetch;
    }
  };
}

function countRequests(requests, fragment) {
  return requests.filter((request) => request.href.includes(fragment)).length;
}

async function testValidateMasterTaskAuditFieldsUsesSchemaCache() {
  clearMasterTaskAuditCache();
  const fetchHarness = installFetch({
    fields: async () => response({ code: 0, data: { items: fieldItems() } }),
    records: async () => response({ code: 0, data: { items: recordItems() } }),
    update: async () => response({ code: 0, data: { record: { record_id: 'rec_A' } } })
  });

  try {
    await validateMasterTaskAuditFields({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' });
    await validateMasterTaskAuditFields({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' });

    assert.equal(countRequests(fetchHarness.requests, '/fields'), 1);
  } finally {
    fetchHarness.restore();
    clearMasterTaskAuditCache();
  }
}

async function testConcurrentListMasterTaskAuditRecordsDedupesFieldsAndRecords() {
  clearMasterTaskAuditCache();
  let recordsResolve;
  const recordsGate = new Promise((resolve) => {
    recordsResolve = resolve;
  });
  const fetchHarness = installFetch({
    fields: async () => response({ code: 0, data: { items: fieldItems() } }),
    records: async () => {
      await recordsGate;
      return response({ code: 0, data: { items: recordItems('B') } });
    },
    update: async () => response({ code: 0, data: { record: { record_id: 'rec_B' } } })
  });

  try {
    const first = listMasterTaskAuditRecords({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' });
    const second = listMasterTaskAuditRecords({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' });
    recordsResolve();
    const [firstRecords, secondRecords] = await Promise.all([first, second]);

    assert.deepEqual(firstRecords.map((record) => record.taskName), ['任务 B']);
    assert.deepEqual(secondRecords.map((record) => record.taskName), ['任务 B']);
    assert.equal(countRequests(fetchHarness.requests, '/fields'), 1);
    assert.equal(countRequests(fetchHarness.requests, '/records'), 1);
  } finally {
    fetchHarness.restore();
    clearMasterTaskAuditCache();
  }
}

async function testRejectedRecordReadsAreNotCached() {
  clearMasterTaskAuditCache();
  let recordCalls = 0;
  const fetchHarness = installFetch({
    fields: async () => response({ code: 0, data: { items: fieldItems() } }),
    records: async () => {
      recordCalls += 1;
      if (recordCalls === 1) return response({ code: 999, msg: 'boom' });
      return response({ code: 0, data: { items: recordItems('C') } });
    },
    update: async () => response({ code: 0, data: { record: { record_id: 'rec_C' } } })
  });

  try {
    await assert.rejects(
      () => listMasterTaskAuditRecords({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' }),
      /飞书记录列表获取失败/
    );
    const records = await listMasterTaskAuditRecords({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' });

    assert.deepEqual(records.map((record) => record.taskName), ['任务 C']);
    assert.equal(countRequests(fetchHarness.requests, '/records'), 2);
  } finally {
    fetchHarness.restore();
    clearMasterTaskAuditCache();
  }
}

async function testUpdateMasterTaskProgressInvalidatesRecordCacheButKeepsSchemaCache() {
  clearMasterTaskAuditCache();
  let recordLabel = 'before';
  const fetchHarness = installFetch({
    fields: async () => response({ code: 0, data: { items: fieldItems() } }),
    records: async () => response({ code: 0, data: { items: recordItems(recordLabel) } }),
    update: async () => {
      recordLabel = 'after';
      return response({ code: 0, data: { record: { record_id: 'rec_before' } } });
    }
  });

  try {
    const before = await listMasterTaskAuditRecords({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' });
    await updateMasterTaskProgress({
      appToken: 'app_cache',
      tableId: 'tbl_cache',
      tenantAccessToken: 'tenant_cache',
      recordId: 'rec_before',
      progressText: '更新后的进展',
      taskStatus: '进行中'
    });
    const after = await listMasterTaskAuditRecords({ appToken: 'app_cache', tableId: 'tbl_cache', tenantAccessToken: 'tenant_cache' });

    assert.deepEqual(before.map((record) => record.taskName), ['任务 before']);
    assert.deepEqual(after.map((record) => record.taskName), ['任务 after']);
    assert.equal(countRequests(fetchHarness.requests, '/fields'), 1);
    assert.equal(countRequests(fetchHarness.requests, '/records'), 3);
  } finally {
    fetchHarness.restore();
    clearMasterTaskAuditCache();
  }
}

await testValidateMasterTaskAuditFieldsUsesSchemaCache();
await testConcurrentListMasterTaskAuditRecordsDedupesFieldsAndRecords();
await testRejectedRecordReadsAreNotCached();
await testUpdateMasterTaskProgressInvalidatesRecordCacheButKeepsSchemaCache();

console.log('feishu bitable cache tests passed');
