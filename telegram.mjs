// Phone access through a Telegram bot you create with @BotFather.
// Pair once by sending "/pair <code>" (code shown in Settings); after that only that chat is accepted.
// Messages go to your default character (or "@Name message"); replies come back; send-confirmation cards arrive as
// buttons you can tap on the phone. Task progress (plan steps) and generated files are synced to the chat as they happen.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function createTelegram({ loadSettings, saveSettings, prepareChat, runChat, allChars, approvals, uploads, log = () => {} }) {
  let offset = 0, stop = false, polling = false;
  const api = async (method, body) => {
    const token = loadSettings().telegram?.token;
    if (!token) throw new Error('no token');
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.description ?? `telegram ${r.status}`);
    return j.result;
  };
  const sendFile = async (chatId, file, caption) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([readFileSync(file)]), basename(file).replace(/^[0-9a-f-]{36}-/, ''));
    const r = await fetch(`https://api.telegram.org/bot${loadSettings().telegram?.token}/sendDocument`, { method: 'POST', body: form });
    const j = await r.json(); if (!j.ok) throw new Error(j.description ?? `telegram ${r.status}`);
  };
  // One progress message per task, edited in place as plan steps change.
  const progressSink = (chatId) => {
    let msgId = null, last = '', chain = Promise.resolve();
    const mark = { completed: '✅', in_progress: '⏳', pending: '▫️' };
    return (e) => {
      if (e.t === 'plan') {
        const body = `进度\n${e.steps.map((x) => `${mark[x.status] ?? '▫️'} ${x.step}`).join('\n')}`;
        if (body === last) return;
        last = body;
        chain = chain.then(async () => {
          if (msgId) await api('editMessageText', { chat_id: chatId, message_id: msgId, text: body }).catch(() => {});
          else msgId = (await api('sendMessage', { chat_id: chatId, text: body }).catch(() => null))?.message_id ?? null;
        });
      }
      if (e.t === 'artifact' && e.id && uploads) chain = chain.then(() => sendFile(chatId, join(uploads, e.id), e.title).catch((err) => say(chatId, `文件 ${e.title} 发送失败：${err.message}`).catch(() => {})));
    };
  };
  const say = async (chatId, text, extra = {}) => {
    for (let i = 0; i < text.length || i === 0; i += 3900) await api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 3900) || '…', ...extra });
  };
  const tg = () => loadSettings().telegram ?? {};
  const setTg = (patch) => { const s = loadSettings(); s.telegram = { ...s.telegram, ...patch }; saveSettings(s); };

  function pickChar(text) {
    const chars = allChars(), m = text.match(/^@(\S+)\s*([\s\S]*)$/);
    if (m) {
      const k = Object.keys(chars).find((key) => [key, chars[key].name, chars[key].zh].some((n) => n && n.toLowerCase().startsWith(m[1].toLowerCase())));
      if (k) return { char: k, text: m[2] || '在吗？' };
    }
    return { char: tg().char && chars[tg().char] ? tg().char : Object.keys(chars)[0], text };
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id, text = String(msg.text ?? '').trim();
    if (!text) return;
    const conf = tg();
    if (text.startsWith('/pair')) {
      if (conf.pairCode && text.split(/\s+/)[1] === conf.pairCode) { setTg({ chatId, pairCode: null }); return say(chatId, '✅ 已连接 Power。直接发消息，或者用 "@角色名 消息" 指定谁来回答。'); }
      return say(chatId, '配对码不对。去 Power 的 ⚙️ 设置 → 手机 里看配对码。');
    }
    if (conf.chatId !== chatId) return say(chatId, '这个机器人还没和你的 Power 配对。');
    const { char, text: body } = pickChar(text);
    const threads = conf.threads ?? {};
    let prep;
    try { prep = prepareChat({ thread: threads[char], text: body, char, source: 'telegram' }); }
    catch (e) {
      if (e.status === 409) return say(chatId, '上一条还在处理，等它说完。');
      try { prep = prepareChat({ text: body, char, source: 'telegram' }); } catch (e2) { return say(chatId, `出错了：${e2.message}`); }
    }
    if (!threads[char]) prep.t.title = `📱 ${prep.t.title}`;
    await api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const { t, reply } = await runChat(prep, progressSink(chatId));
    setTg({ threads: { ...tg().threads, [char]: t.id } });
    const c = allChars()[char];
    await say(chatId, `${c ? `${c.name}：` : ''}${reply || '（没有文字回复）'}`);
  }

  async function onCallback(q) {
    const [kind, id, ok] = String(q.data ?? '').split(':');
    if (kind !== 'appr' || q.message?.chat?.id !== tg().chatId) return;
    const a = approvals.get(id);
    if (a) a.ok(ok === '1');
    await api('answerCallbackQuery', { callback_query_id: q.id, text: a ? (ok === '1' ? '已同意发送' : '已取消') : '已经处理过了' }).catch(() => {});
    await api('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  async function loop() {
    if (polling) return;
    polling = true;
    while (!stop) {
      if (!tg().token || tg().enabled === false) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      try {
        const ups = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of ups) {
          offset = u.update_id + 1;
          if (u.message) onMessage(u.message).catch((e) => log(`telegram: ${e.message}`));
          if (u.callback_query) onCallback(u.callback_query).catch(() => {});
        }
      } catch (e) { log(`telegram: ${e.message}`); await new Promise((r) => setTimeout(r, 5000)); }
    }
    polling = false;
  }
  loop();

  return {
    newPairCode() { const code = String(randomInt(100000, 999999)); setTg({ pairCode: code }); return code; },
    // Push a send-confirmation card to the phone.
    async approval(a) {
      const chatId = tg().chatId; if (!chatId) return;
      await say(chatId, `🛡 要发送吗？\n${a.platform} · 发给 ${a.recipient}\n\n${a.text}`,
        { reply_markup: { inline_keyboard: [[{ text: '取消', callback_data: `appr:${a.id}:0` }, { text: '发送', callback_data: `appr:${a.id}:1` }]] } }).catch(() => {});
    },
    // Push a notice (e.g. a scheduled task's result) to the paired phone, if any.
    async push(text) { const chatId = tg().chatId; if (chatId && tg().token && tg().enabled !== false) await say(chatId, text).catch(() => {}); },
    async test() { const me = await api('getMe'); return me.username; },
    stop() { stop = true; },
  };
}
