// Scheduled tasks: "every day at 08:00 ask Nayuta to summarize WeChat", "every 60 minutes check X".
// Stored in ~/.power/schedules.json; each task keeps one thread so its history reads like a normal chat.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Is task s due at time `now`? daily: at/after HH:MM on chosen weekdays, once per day. monthly: same, on day 1–28. every: N minutes apart.
export function isDue(s, now = new Date()) {
  if (!s.enabled) return false;
  const last = s.lastRun ? new Date(s.lastRun) : null;
  if (s.when?.type === 'every') return !last || now - last >= Math.max(5, Number(s.when.minutes) || 60) * 60000;
  const [h, m] = String(s.when?.time ?? '08:00').split(':').map(Number);
  const days = s.when?.days?.length ? s.when.days : [0, 1, 2, 3, 4, 5, 6];
  if (s.when?.type === 'monthly' ? now.getDate() !== Number(s.when.day) : !days.includes(now.getDay())) return false;
  const at = new Date(now); at.setHours(h, m, 0, 0);
  return now >= at && (!last || last < at);
}

export function createScheduler({ home, prepareChat, runChat, running, notify, log = () => {} }) {
  const file = join(home, 'schedules.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; } };
  const save = (list) => writeFileSync(file, JSON.stringify(list, null, 1));
  const busy = new Set();

  const due = isDue;

  async function run(s) {
    if (busy.has(s.id)) return;
    busy.add(s.id);
    const list = load(), cur = list.find((x) => x.id === s.id);
    if (cur) { cur.lastRun = new Date().toISOString(); save(list); }
    try {
      const thread = s.thread && existsSync(join(home, 'threads', `${s.thread}.json`)) && !running.has(s.thread) ? s.thread : undefined;
      // A failed run is retried up to 3 times before the error is reported.
      let t, reply;
      for (let attempt = 1; ; attempt++) {
        try {
          const prep = prepareChat({ thread: thread ?? t?.id, text: s.text, char: s.char, members: s.members, mode: 'auto', source: 'schedule' });
          if (!thread && !t) prep.t.title = `⏰ ${s.name}`;
          ({ t, reply } = await runChat(prep));
          if (!t.events.findLast?.((e) => e.t === 'done')?.error || attempt >= 3) break;
        } catch (e) { if (attempt >= 3) throw e; }
        await new Promise((r) => setTimeout(r, 30000 * attempt));
      }
      const after = load(), x = after.find((y) => y.id === s.id);
      if (x) { x.thread = t.id; x.lastResult = reply.slice(0, 300); save(after); }
      notify(`⏰ ${s.name}`, reply || '完成了');
    } catch (e) {
      log(`schedule ${s.name}: ${e.message}`);
      notify(`⏰ ${s.name} 失败了`, `重试 3 次仍失败：${e.message}`);
    } finally { busy.delete(s.id); }
  }

  setInterval(() => { for (const s of load()) if (due(s)) run(s); }, 30000);

  return {
    list: load,
    upsert(b) {
      const list = load(), s = list.find((x) => x.id === b.id) ?? { id: randomUUID().slice(0, 8), enabled: true };
      Object.assign(s, {
        name: String(b.name ?? s.name ?? '定时任务').slice(0, 40), text: String(b.text ?? s.text ?? '').slice(0, 4000),
        char: b.members?.length > 1 ? undefined : b.char ?? s.char, members: b.members?.length > 1 ? b.members.slice(0, 8) : undefined,
        when: b.when ?? s.when ?? { type: 'daily', time: '08:00' }, enabled: b.enabled ?? s.enabled,
      });
      if (!list.includes(s)) list.push(s);
      save(list);
      return s;
    },
    remove(id) { save(load().filter((x) => x.id !== id)); },
    runNow(id) { const s = load().find((x) => x.id === id); if (s) run(s); return !!s; },
    due,
  };
}
