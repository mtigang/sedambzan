import { api } from 'sdk';
export default async function (cq) {
  try {
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'diag mode' });
  } catch (_e) {}
}
