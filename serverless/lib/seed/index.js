/** seed users */
import { data as users_0 } from 'lib/seed/users_0';
import { data as users_1 } from 'lib/seed/users_1';
import { data as users_2 } from 'lib/seed/users_2';
import { data as users_3 } from 'lib/seed/users_3';
import { data as users_4 } from 'lib/seed/users_4';
import { data as users_5 } from 'lib/seed/users_5';
import { data as users_6 } from 'lib/seed/users_6';
import { data as users_7 } from 'lib/seed/users_7';
import { data as users_8 } from 'lib/seed/users_8';
import { data as users_9 } from 'lib/seed/users_9';
import { data as users_10 } from 'lib/seed/users_10';
import { data as users_11 } from 'lib/seed/users_11';
import { data as users_12 } from 'lib/seed/users_12';
import { data as settingsData } from 'lib/seed/settings';

export const USER_CHUNKS = 13;
export const MESSAGE_CHUNKS = 0;

const USER_DATA = [users_0, users_1, users_2, users_3, users_4, users_5, users_6, users_7, users_8, users_9, users_10, users_11, users_12];
export function loadUserChunk(i) { return USER_DATA[i] || []; }
export function loadMessageChunk() { return []; }
export function loadFeedback() { return []; }
export function loadSettings() { return settingsData || []; }
