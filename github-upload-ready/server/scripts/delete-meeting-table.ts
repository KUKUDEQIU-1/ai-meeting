import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { deleteBitableTable, getTenantAccessToken } from '../services/feishuBitableClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function argValue(name) {
  const prefix = `--${name}=`;
  const matched = process.argv.find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : '';
}

async function main() {
  const tableId = argValue('table_id');
  const confirm = argValue('confirm');

  if (!tableId) {
    throw new Error('缺少 --table_id=tblxxx');
  }

  if (confirm !== 'true') {
    throw new Error('删除表需要显式传入 --confirm=true');
  }

  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN?.trim();

  if (!appToken) {
    throw new Error('FEISHU_BITABLE_APP_TOKEN 未配置');
  }

  const tenantAccessToken = await getTenantAccessToken();
  await deleteBitableTable({ appToken, tableId, tenantAccessToken });
  console.log(`[Delete Meeting Table] deleted table_id=${tableId}`);
}

main().catch((error) => {
  console.error('[Delete Meeting Table] failed', error);
  process.exitCode = 1;
});
