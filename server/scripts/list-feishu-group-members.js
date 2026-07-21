import 'dotenv/config';
import { listConfiguredFeishuGroupMembers } from '../services/feishuChatMemberService.js';

listConfiguredFeishuGroupMembers()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(JSON.stringify({
      message: error.message,
      status: error.status,
      feishuResponse: error.feishuResponse
    }, null, 2));
    process.exitCode = 1;
  });
