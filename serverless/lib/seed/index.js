/** seed data — بدون ادمین‌ها */
export const USER_CHUNKS = 13;
export const MESSAGE_CHUNKS = 6;

export async function loadUserChunk(i) {
  switch (i) {
    case 0: return (await import('lib/seed/users_0.js')).default;
    case 1: return (await import('lib/seed/users_1.js')).default;
    case 2: return (await import('lib/seed/users_2.js')).default;
    case 3: return (await import('lib/seed/users_3.js')).default;
    case 4: return (await import('lib/seed/users_4.js')).default;
    case 5: return (await import('lib/seed/users_5.js')).default;
    case 6: return (await import('lib/seed/users_6.js')).default;
    case 7: return (await import('lib/seed/users_7.js')).default;
    case 8: return (await import('lib/seed/users_8.js')).default;
    case 9: return (await import('lib/seed/users_9.js')).default;
    case 10: return (await import('lib/seed/users_10.js')).default;
    case 11: return (await import('lib/seed/users_11.js')).default;
    case 12: return (await import('lib/seed/users_12.js')).default;
    default: return [];
  }
}

export async function loadMessageChunk(i) {
  switch (i) {
    case 0: return (await import('lib/seed/messages_0.js')).default;
    case 1: return (await import('lib/seed/messages_1.js')).default;
    case 2: return (await import('lib/seed/messages_2.js')).default;
    case 3: return (await import('lib/seed/messages_3.js')).default;
    case 4: return (await import('lib/seed/messages_4.js')).default;
    case 5: return (await import('lib/seed/messages_5.js')).default;
    default: return [];
  }
}

export async function loadFeedback() {
  return (await import('lib/seed/feedback.js')).default;
}
export async function loadSettings() {
  return (await import('lib/seed/settings.js')).default;
}
