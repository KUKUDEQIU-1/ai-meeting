export const WORK_TYPE_OPTIONS = ['开发类(功能/修复)', '事务类(运营/对接)', '运营类'];

const WORK_TYPE_SET = new Set(WORK_TYPE_OPTIONS);

const DEVELOPMENT_RE = /开发|研发|功能|修复|bug|BUG|接口|代码|测试|联调|部署|上线|小程序|系统|平台|应用|技术|配置|回归|验收|优化/;
const OPERATION_RE = /运营|活动|渠道|用户运营|商家运营|投放|增长|社群|内容运营|数据运营|推广|营销/;

function workTypeTextOf(task) {
  return [
    task?.work_type,
    task?.task_name,
    task?.title,
    task?.task,
    task?.name,
    task?.task_brief,
    task?.task_description,
    task?.description,
    task?.comment,
    task?.evidence_quote,
    task?.evidence
  ].filter(Boolean).join(' ');
}

export function isValidWorkType(value) {
  return WORK_TYPE_SET.has(String(value || '').trim());
}

export function inferWorkType(task = {}) {
  const text = workTypeTextOf(task);

  if (DEVELOPMENT_RE.test(text)) return '开发类(功能/修复)';
  if (OPERATION_RE.test(text)) return '运营类';
  return '事务类(运营/对接)';
}

export function normalizeWorkType(value, task = {}) {
  const text = String(value || '').trim();
  return isValidWorkType(text) ? text : inferWorkType(task);
}
