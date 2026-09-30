/** seed — static imports only */
import users_0 from 'lib/seed/users_0.js';
import users_1 from 'lib/seed/users_1.js';
import users_2 from 'lib/seed/users_2.js';
import users_3 from 'lib/seed/users_3.js';
import users_4 from 'lib/seed/users_4.js';
import users_5 from 'lib/seed/users_5.js';
import users_6 from 'lib/seed/users_6.js';
import users_7 from 'lib/seed/users_7.js';
import users_8 from 'lib/seed/users_8.js';
import users_9 from 'lib/seed/users_9.js';
import users_10 from 'lib/seed/users_10.js';
import users_11 from 'lib/seed/users_11.js';
import users_12 from 'lib/seed/users_12.js';
import messages_0 from 'lib/seed/messages_0.js';
import messages_1 from 'lib/seed/messages_1.js';
import messages_2 from 'lib/seed/messages_2.js';
import messages_3 from 'lib/seed/messages_3.js';
import messages_4 from 'lib/seed/messages_4.js';
import messages_5 from 'lib/seed/messages_5.js';
import feedback from 'lib/seed/feedback.js';
import settings from 'lib/seed/settings.js';

export const USER_CHUNKS = 13;
export const MESSAGE_CHUNKS = 6;

const USER_DATA = [
  users_0,
  users_1,
  users_2,
  users_3,
  users_4,
  users_5,
  users_6,
  users_7,
  users_8,
  users_9,
  users_10,
  users_11,
  users_12,
];
const MSG_DATA = [
  messages_0,
  messages_1,
  messages_2,
  messages_3,
  messages_4,
  messages_5,
];

export function loadUserChunk(i) {
  return USER_DATA[i] || [];
}
export function loadMessageChunk(i) {
  return MSG_DATA[i] || [];
}
export function loadFeedback() { return feedback || []; }
export function loadSettings() { return settings || []; }
