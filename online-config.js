/* Online play config (MIND-05). The deploy (MIND-07) fills these from repository variables; they stay empty in git.
 * Only the project URL and the publishable (anon) key may ever go here, never a secret key (I8).
 * Local development: localStorage['theMind.online.dev'] = '{"supabaseUrl":"…","supabaseKey":"…"}' overrides them
 * (see docs/online/BACKEND.md). */
window.MIND_ONLINE = { supabaseUrl: '', supabaseKey: '' };
