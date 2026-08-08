<script setup>
import { computed, onMounted, ref, watch } from 'vue';

const MAINTENANCE_TOKEN_STORAGE_KEY = 'ai-meeting.maintenance-token';
const health = ref(null);
const healthState = ref('loading');
const healthMessage = ref('正在连接后端服务…');
const maintenanceToken = ref('');
const maintenanceState = ref('idle');
const maintenanceResult = ref(null);
const documentListState = ref('idle');
const documentListMessage = ref('尚未刷新文档列表');
const wikiDocuments = ref([]);
const selectedNodeToken = ref('');
const getnoteListState = ref('idle');
const getnoteListMessage = ref('尚未刷新 Get笔记列表');
const getnoteNotes = ref([]);
const selectedNoteId = ref('');

function restoreMaintenanceToken() {
  try {
    maintenanceToken.value = localStorage.getItem(MAINTENANCE_TOKEN_STORAGE_KEY) || '';
  } catch {
    maintenanceToken.value = '';
  }
}

function clearMaintenanceToken() {
  maintenanceToken.value = '';

  try {
    localStorage.removeItem(MAINTENANCE_TOKEN_STORAGE_KEY);
  } catch {
    // Browser storage can be disabled; clearing the in-memory value still works.
  }
}

watch(maintenanceToken, (value) => {
  try {
    if (value.trim()) localStorage.setItem(MAINTENANCE_TOKEN_STORAGE_KEY, value.trim());
    else localStorage.removeItem(MAINTENANCE_TOKEN_STORAGE_KEY);
  } catch {
    // The token remains usable for the current page even when storage is unavailable.
  }
});

const healthLabel = computed(() => {
  if (healthState.value === 'loading') return '检查中';
  if (healthState.value === 'success') return '服务正常';
  return '连接异常';
});

const healthClass = computed(() => `status-badge status-${healthState.value}`);

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function readableError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function explainMaintenanceFailure(data) {
  const failure = Array.isArray(data?.failed) ? data.failed[0] : null;
  const feishuResult = failure?.feishu_result;
  const results = Array.isArray(feishuResult?.results) ? feishuResult.results : [];
  const failedDelivery = results.find((item) => item?.status === 'failed' || item?.error);
  const deliveryFailure = Array.isArray(feishuResult?.delivery_failures)
    ? feishuResult.delivery_failures[0]
    : null;
  const detail = failedDelivery?.error || deliveryFailure?.error;

  if (feishuResult && Number(feishuResult.sent_count || 0) > 0 && Number(feishuResult.failed_count || 0) > 0) {
    return `具体原因：任务卡片部分发送成功，但仍有 ${feishuResult.failed_count} 张失败；已发送 ${feishuResult.sent_count} 张。${detail ? `失败详情：${detail}` : ''}`;
  }

  if (detail) {
    return `具体原因：任务卡片发送失败。${detail}`;
  }

  if (failure?.error) {
    return `具体原因：${failure.error}`;
  }

  return '具体原因：后端未返回更详细的失败阶段，请查看下方原始响应。';
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.reason || data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function maintenanceFailure(error) {
  if (error?.status === 409) {
    if (error.data?.capability === 'master_task_inspection_manual') {
      return {
        title: '总表巡检正在运行',
        detail: `已有一个飞书巡检任务正在执行，请稍候再试。\n\n运行信息：\n${JSON.stringify(error.data, null, 2)}`
      };
    }
    return {
      title: 'Wiki 扫描正在运行，GetNote 结果已返回',
      detail: JSON.stringify(error.data, null, 2)
    };
  }

  if (error?.status === 401) {
    return {
      title: '维护令牌未通过校验',
      detail: '后端拒绝了本次请求。请确认输入的是服务当前加载的 OPS_MAINTENANCE_TOKEN 或 FEISHU_DOCX_SOURCE_API_TOKEN。'
    };
  }

  if (error?.data) {
    return {
      title: `分析请求失败（HTTP ${error.status || 'unknown'}）`,
      detail: `${explainMaintenanceFailure(error.data)}\n\n原始响应：\n${JSON.stringify(error.data, null, 2)}`
    };
  }

  return {
    title: '分析请求失败',
    detail: readableError(error, '请求失败，请检查维护令牌和后端服务状态')
  };
}

function getNoteSuccessMessage(result) {
  const skipped = result?.status === 'skipped' || result?.reason;
  const failedCount = Array.isArray(result?.failed) ? result.failed.length : 0;
  const sentCount = Number(result?.imported?.[0]?.sent_count || 0);

  if (failedCount > 0 || result?.success === false) {
    return 'Get笔记扫描完成，但处理失败';
  }

  if (skipped) {
    return result.reason === 'content_unchanged'
      ? 'Get笔记扫描完成，内容未变化，未重复发卡'
      : `Get笔记扫描完成，已跳过：${result.reason || 'already_synced'}`;
  }

  return sentCount > 0 || result?.imported?.[0]?.draft_id
    ? 'Get笔记扫描完成，任务卡片已发送'
    : 'Get笔记扫描完成，请查看返回结果';
}

function masterTaskAuditSuccessMessage(result) {
  const failed = Number(result?.summary?.failed || 0);
  const remindable = Number(result?.summary?.remindable || 0);

  if (failed > 0 || result?.status === 'partial_failed') return `总表巡检完成，但有 ${failed} 张巡检卡片发送失败`;
  if (result?.dry_run) return '总表巡检完成（预演模式，未发送卡片）';
  if (remindable > 0) return `总表巡检完成，已发送 ${remindable} 张巡检卡片`;
  return '总表巡检完成，暂无需要发送的巡检卡片';
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${maintenanceToken.value.trim()}`
  };
}

async function checkHealth() {
  healthState.value = 'loading';
  healthMessage.value = '正在连接后端服务…';

  try {
    const response = await fetch('/api/health');
    health.value = await parseResponse(response);
    healthState.value = 'success';
    healthMessage.value = '后端健康检查已通过';
  } catch (error) {
    health.value = null;
    healthState.value = 'error';
    healthMessage.value = readableError(error, '无法连接后端，请确认 localhost:3000 正在运行');
  }
}

async function triggerMaintenance() {
  if (!maintenanceToken.value.trim() || maintenanceState.value === 'submitting') return;

  maintenanceState.value = 'submitting';
  maintenanceResult.value = null;

  try {
    const response = await fetch('/api/meeting/maintenance/analyze-latest-feishu-wiki-docx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${maintenanceToken.value.trim()}`
      },
      body: JSON.stringify({
        force: false,
        reanalyze: false,
        force_card_resend: false
      })
    });
    maintenanceResult.value = {
      type: 'success',
      title: '双来源扫描已完成',
      detail: JSON.stringify(await parseResponse(response), null, 2)
    };
    maintenanceState.value = 'success';
  } catch (error) {
    const failure = maintenanceFailure(error);
    maintenanceResult.value = {
      type: 'error',
      title: failure.title,
      detail: failure.detail
    };
    maintenanceState.value = 'error';
  }
}

async function triggerMasterTaskAudit() {
  if (maintenanceState.value === 'submitting') return;

  if (!maintenanceToken.value.trim()) {
    maintenanceResult.value = {
      type: 'error',
      title: '请先输入维护令牌',
      detail: '手动触发总表巡检需要维护令牌。'
    };
    return;
  }

  maintenanceState.value = 'submitting';
  maintenanceResult.value = {
    type: 'info',
    title: '正在触发总表任务巡检',
    detail: '正在读取正式总表、判断异常任务并发送负责人巡检卡片，请稍候…'
  };

  try {
    const response = await fetch('/api/meeting/maintenance/master-task-audit/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ execute: true, dry_run: false })
    });
    const result = await parseResponse(response);
    const failed = Number(result?.summary?.failed || 0) > 0 || result?.status === 'partial_failed';
    maintenanceResult.value = {
      type: failed ? 'error' : 'success',
      title: masterTaskAuditSuccessMessage(result),
      detail: JSON.stringify(result, null, 2)
    };
    maintenanceState.value = failed ? 'error' : 'success';
  } catch (error) {
    const failure = maintenanceFailure(error);
    maintenanceResult.value = {
      type: 'error',
      title: failure.title,
      detail: failure.detail
    };
    maintenanceState.value = 'error';
  }
}

async function refreshWikiDocuments() {
  if (documentListState.value === 'loading') return;

  if (!maintenanceToken.value.trim()) {
    maintenanceResult.value = {
      type: 'error',
      title: '请先输入维护令牌',
      detail: '刷新文档列表需要维护令牌。令牌会保存在当前浏览器中，可随时点击“清除已保存令牌”。'
    };
    return;
  }

  documentListState.value = 'loading';
  documentListMessage.value = '正在读取飞书 Wiki/docx 文档列表…';

  try {
    const response = await fetch('/api/meeting/maintenance/feishu-wiki-docx-documents', {
      headers: authHeaders()
    });
    const data = await parseResponse(response);
    wikiDocuments.value = Array.isArray(data.documents) ? data.documents : [];
    selectedNodeToken.value = wikiDocuments.value[0]?.node_token || '';
    documentListState.value = 'success';
    documentListMessage.value = wikiDocuments.value.length ? `已载入 ${wikiDocuments.value.length} 篇文档` : '未扫描到可分析的 docx 文档';
  } catch (error) {
    wikiDocuments.value = [];
    selectedNodeToken.value = '';
    documentListState.value = 'error';
    documentListMessage.value = readableError(error, '文档列表刷新失败');
  }
}

async function triggerSelectedDocument() {
  if (maintenanceState.value === 'submitting') return;

  if (!maintenanceToken.value.trim()) {
    maintenanceResult.value = {
      type: 'error',
      title: '请先输入维护令牌',
      detail: '扫描选中文档需要维护令牌。令牌会保存在当前浏览器中，可随时点击“清除已保存令牌”。'
    };
    return;
  }

  if (!selectedNodeToken.value) {
    maintenanceResult.value = {
      type: 'error',
      title: '请先选择文档',
      detail: '可以点击“刷新列表”加载当前 Wiki 目录下的 docx 文档，然后从下拉列表选择一篇。'
    };
    return;
  }

  maintenanceState.value = 'submitting';
  maintenanceResult.value = null;

  try {
    const response = await fetch('/api/meeting/maintenance/analyze-feishu-wiki-docx-document', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        selected_node_token: selectedNodeToken.value,
        force: false,
        reanalyze: false
      })
    });
    const result = await parseResponse(response);
    if (result.success === false || ['failed', 'blocked'].includes(result.status)) {
      const error = new Error(result.message || result.reason || '选中文档处理失败');
      error.status = response.status;
      error.data = result;
      throw error;
    }

    const imported = Array.isArray(result.imported) ? result.imported[0] : null;
    const sentCount = Number(imported?.sent_count || imported?.feishu_result?.sent_count || 0);
    const skippedCount = Number(imported?.skipped_count || imported?.feishu_result?.skipped_count || 0);
    const failedCount = Number(imported?.failed_count || imported?.feishu_result?.failed_count || 0);
    maintenanceResult.value = {
      type: 'success',
      title: failedCount > 0 ? '文档已处理，但卡片部分发送失败' : '选中文档扫描已完成',
      detail: `卡片发送：${sentCount} 张，跳过：${skippedCount} 张，失败：${failedCount} 张\n\n${JSON.stringify(result, null, 2)}`
    };
    maintenanceState.value = 'success';
  } catch (error) {
    const failure = maintenanceFailure(error);
    maintenanceResult.value = {
      type: 'error',
      title: failure.title,
      detail: failure.detail
    };
    maintenanceState.value = 'error';
  }
}

async function refreshGetNoteNotes() {
  if (getnoteListState.value === 'loading') return;

  if (!maintenanceToken.value.trim()) {
    maintenanceResult.value = {
      type: 'error',
      title: '请先输入维护令牌',
      detail: '刷新 Get笔记列表需要维护令牌。令牌会保存在当前浏览器中，可随时点击“清除已保存令牌”。'
    };
    return;
  }

  getnoteListState.value = 'loading';
  getnoteListMessage.value = '正在读取 Get笔记列表…';

  try {
    const response = await fetch('/api/meeting/maintenance/getnote-notes?limit=20', {
      headers: authHeaders()
    });
    const data = await parseResponse(response);
    getnoteNotes.value = Array.isArray(data.notes) ? data.notes : [];
    selectedNoteId.value = getnoteNotes.value[0]?.note_id || '';
    getnoteListState.value = 'success';
    getnoteListMessage.value = getnoteNotes.value.length ? `已载入 ${getnoteNotes.value.length} 条笔记` : '未读取到 Get笔记';
  } catch (error) {
    getnoteNotes.value = [];
    selectedNoteId.value = '';
    getnoteListState.value = 'error';
    getnoteListMessage.value = readableError(error, 'Get笔记列表刷新失败');
  }
}

async function triggerSelectedGetNote() {
  if (maintenanceState.value === 'submitting') return;

  if (!maintenanceToken.value.trim()) {
    maintenanceResult.value = {
      type: 'error',
      title: '请先输入维护令牌',
      detail: '扫描选中的 Get笔记需要维护令牌。令牌会保存在当前浏览器中，可随时点击“清除已保存令牌”。'
    };
    return;
  }

  if (!selectedNoteId.value) {
    maintenanceResult.value = {
      type: 'error',
      title: '请先选择 Get笔记',
      detail: '可以点击“刷新 Get笔记”加载最近笔记，然后从下拉列表选择一条。'
    };
    return;
  }

  maintenanceState.value = 'submitting';
  maintenanceResult.value = {
    type: 'info',
    title: '正在处理 Get笔记扫描请求',
    detail: '正在准备读取选中的笔记，请稍候…'
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    maintenanceResult.value = {
      type: 'info',
      title: '正在扫描 Get笔记并准备任务卡片',
      detail: '正在读取笔记正文、调用 AI 分析任务，并准备发送负责人卡片…'
    };

    const response = await fetch('/api/meeting/maintenance/analyze-getnote-note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        note_id: selectedNoteId.value,
        force: true,
        reanalyze: true,
        force_card_resend: true
      })
    });
    const result = await parseResponse(response);
    maintenanceResult.value = {
      type: 'success',
      title: getNoteSuccessMessage(result),
      detail: JSON.stringify(result, null, 2)
    };
    maintenanceState.value = 'success';
  } catch (error) {
    const failure = maintenanceFailure(error);
    maintenanceResult.value = {
      type: 'error',
      title: failure.title,
      detail: failure.detail
    };
    maintenanceState.value = 'error';
  }
}

onMounted(() => {
  restoreMaintenanceToken();
  checkHealth();
});
</script>

<template>
  <div class="app-shell">
    <header class="command-rail">
      <div class="rail-inner">
        <a class="brand" href="/" aria-label="返回 AI 会议运维控制台">
          <span class="brand-mark" aria-hidden="true">AI</span>
          <span>
            <strong>会议纪要</strong>
            <small>运维控制台</small>
          </span>
        </a>
        <div class="rail-context">
          <span class="environment">本地环境</span>
          <span class="rail-divider" aria-hidden="true"></span>
          <span class="rail-caption">轻量操作面板</span>
        </div>
      </div>
    </header>

    <main class="workspace">
      <section class="intro-block" aria-labelledby="page-title">
        <p class="eyebrow">INTERNAL OPERATIONS / 01</p>
        <h1 id="page-title">把每一次维护，<em>做得有把握。</em></h1>
        <p class="intro-copy">先确认服务状态，再手动触发最新飞书 Wiki / docx 和 Get笔记最新上传笔记的分析流程。这里不保存操作令牌，也不替代后台常驻 worker。</p>
      </section>

      <div class="content-grid">
        <section class="panel maintenance-panel" aria-labelledby="maintenance-title">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">MANUAL ACTION / 02</p>
              <h2 id="maintenance-title">扫描最新会议来源</h2>
            </div>
            <span class="panel-index">POST</span>
          </div>
          <p class="panel-copy">调用现有维护接口，同时扫描配置中的最新飞书 Wiki / docx 原文和 Get笔记最新上传笔记。默认内容未变化时跳过，适合发布后验证或临时补跑。</p>

          <form class="maintenance-form" @submit.prevent="triggerMaintenance">
            <label class="field-label" for="maintenance-token">维护令牌</label>
            <div class="input-row">
              <input
                id="maintenance-token"
                v-model="maintenanceToken"
                class="token-input"
                type="password"
                autocomplete="off"
                placeholder="输入 OPS_MAINTENANCE_TOKEN"
                :disabled="maintenanceState === 'submitting'"
              />
              <button class="primary-button" type="submit" :disabled="!maintenanceToken.trim() || maintenanceState === 'submitting'">
                <span v-if="maintenanceState === 'submitting'" class="button-spinner" aria-hidden="true"></span>
                {{ maintenanceState === 'submitting' ? '提交中' : '同时扫描' }}
              </button>
            </div>
            <div class="token-actions">
              <p class="field-hint">令牌会保存在当前浏览器的本地存储中，仅用于本地维护请求，不会上传到其他服务。</p>
              <button class="text-button" type="button" :disabled="!maintenanceToken" @click="clearMaintenanceToken">清除已保存令牌</button>
            </div>

            <div class="document-picker" aria-labelledby="document-picker-title">
              <div class="document-picker-heading">
                <div>
                  <strong id="document-picker-title">选择飞书文档</strong>
                  <span>{{ documentListMessage }}</span>
                </div>
                <button class="secondary-button compact-button" type="button" :disabled="documentListState === 'loading'" @click="refreshWikiDocuments">
                  {{ documentListState === 'loading' ? '刷新中…' : '刷新列表' }}
                </button>
              </div>

              <label class="field-label" for="wiki-document-select">文档标题</label>
              <div class="input-row">
                <select
                  id="wiki-document-select"
                  v-model="selectedNodeToken"
                  class="document-select"
                  :disabled="!wikiDocuments.length || maintenanceState === 'submitting'"
                >
                  <option value="" disabled>请选择一篇文档</option>
                  <option v-for="document in wikiDocuments" :key="document.node_token" :value="document.node_token">
                    {{ document.title }}
                  </option>
                </select>
                <button class="primary-button" type="button" :disabled="maintenanceState === 'submitting'" @click="triggerSelectedDocument">
                  <span v-if="maintenanceState === 'submitting'" class="button-spinner" aria-hidden="true"></span>
                  {{ maintenanceState === 'submitting' ? '提交中' : '扫描选中文档' }}
                </button>
              </div>
              <p class="field-hint">下拉列表来自当前配置的 Wiki 目录；点击“扫描选中文档”只处理这篇文档，不会扫描 Get笔记。</p>
            </div>

            <div class="document-picker getnote-picker" aria-labelledby="getnote-picker-title">
              <div class="document-picker-heading">
                <div>
                  <strong id="getnote-picker-title">选择 Get笔记</strong>
                  <span>{{ getnoteListMessage }}</span>
                </div>
                <button class="secondary-button compact-button" type="button" :disabled="getnoteListState === 'loading'" @click="refreshGetNoteNotes">
                  {{ getnoteListState === 'loading' ? '刷新中…' : '刷新 Get笔记' }}
                </button>
              </div>

              <label class="field-label" for="getnote-select">笔记标题</label>
              <div class="input-row">
                <select
                  id="getnote-select"
                  v-model="selectedNoteId"
                  class="document-select"
                  :disabled="!getnoteNotes.length || maintenanceState === 'submitting'"
                >
                  <option value="" disabled>请选择一条 Get笔记</option>
                  <option v-for="note in getnoteNotes" :key="note.note_id" :value="note.note_id">
                    {{ note.title }}
                  </option>
                </select>
                <button class="primary-button" type="button" :disabled="maintenanceState === 'submitting'" @click="triggerSelectedGetNote">
                  <span v-if="maintenanceState === 'submitting'" class="button-spinner" aria-hidden="true"></span>
                  {{ maintenanceState === 'submitting' ? '提交中' : '扫描选中笔记' }}
                </button>
              </div>
              <p class="field-hint">下拉列表来自 Get笔记最近列表；点击“扫描选中笔记”只处理这条 Get笔记，不会扫描飞书 Wiki。</p>
            </div>

            <div class="document-picker audit-picker" aria-labelledby="master-task-audit-title">
              <div class="document-picker-heading">
                <div>
                  <strong id="master-task-audit-title">正式总表任务巡检</strong>
                  <span>读取当前总表并发送需要处理的巡检卡片</span>
                </div>
                <span class="panel-index">AUDIT</span>
              </div>
              <button class="primary-button" type="button" :disabled="!maintenanceToken.trim() || maintenanceState === 'submitting'" @click="triggerMasterTaskAudit">
                <span v-if="maintenanceState === 'submitting'" class="button-spinner" aria-hidden="true"></span>
                {{ maintenanceState === 'submitting' ? '巡检中…' : '触发巡检并发送卡片' }}
              </button>
              <p class="field-hint">仅此按钮会显式发送巡检卡片；已处理任务仍按当天幂等规则跳过。失败时会显示失败任务和具体原因。</p>
            </div>
          </form>

            <div
              v-if="maintenanceResult"
              class="notice"
            :class="`notice-${maintenanceResult.type}`"
            :role="maintenanceResult.type === 'error' ? 'alert' : 'status'"
            aria-live="polite"
          >
            <span class="notice-mark" :class="{ 'notice-spinner': maintenanceResult.type === 'info' }" aria-hidden="true">{{ maintenanceResult.type === 'error' ? '!' : maintenanceResult.type === 'info' ? '' : '✓' }}</span>
            <div>
              <strong>{{ maintenanceResult.title }}</strong>
              <pre>{{ maintenanceResult.detail }}</pre>
            </div>
          </div>
        </section>

        <aside class="panel status-panel" aria-labelledby="health-title">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">SERVICE PULSE / 03</p>
              <h2 id="health-title">后端健康检查</h2>
            </div>
            <span :class="healthClass">{{ healthLabel }}</span>
          </div>

          <div class="health-summary" :class="`health-${healthState}`" aria-live="polite">
            <span class="health-dot" aria-hidden="true"></span>
            <span>{{ healthMessage }}</span>
          </div>

          <dl v-if="health" class="health-details">
            <div>
              <dt>状态</dt>
              <dd>{{ formatValue(health.status) }}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>{{ formatValue(health.version) }}</dd>
            </div>
            <div v-if="health.build">
              <dt>构建</dt>
              <dd>{{ formatValue(health.build) }}</dd>
            </div>
          </dl>

          <button class="secondary-button" type="button" :disabled="healthState === 'loading'" @click="checkHealth">
            {{ healthState === 'loading' ? '刷新中…' : '重新检查' }}
          </button>
        </aside>
      </div>
    </main>

    <footer class="page-footer">
      <span>AI Meeting / Internal only</span>
      <span>代理端口 5173 · 服务端口 3000</span>
    </footer>
  </div>
</template>
