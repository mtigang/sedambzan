# tgcloud SDK (summary)

```js
import { api, db } from 'sdk';
import { table, integer, text, sql, eq, desc } from 'sdk/db';
import { messages } from 'schema';
```

- `api.sendMessage({ chat_id, text, reply_markup })`
- `api.answerCallbackQuery({ callback_query_id, text, show_alert })`
- `db.insert(table).values({...}).returning().run()`
- `db.select().from(table).where(eq(...)).run()`
- `db.update(table).set({...}).where(...).run()`

See official docs: https://core.telegram.org/bots/serverless
