import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const validId = /^[a-zA-Z0-9_-]{1,60}$/;
export function serviceURL(value) {
  const u = new URL(value);
  if (u.username || u.password || u.hash || u.search || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('服务地址必须为 HTTPS（本机可用 HTTP），不能包含密码、查询参数或片段');
  return u.href.replace(/\/$/, '');
}
export function createIntegrations({ home, callbackURL = 'http://127.0.0.1:4545/api/integrations/oauth/callback' }) {
  mkdirSync(home, { recursive: true });
  const file = join(home, 'integrations.json'), connections = new Map(), states = new Map(), authorizations = new Map();
  function load() { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { connectors: [], image: {} }; throw new Error('连接配置无法读取'); } }
  function save(data) { writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); chmodSync(file, 0o600); }
  const redact = (c) => ({ id: c.id, name: c.name, type: c.type, url: c.url, command: c.command, args: c.args, enabled: c.enabled, hasToken: !!c.token, envKeys: Object.keys(c.env || {}), status: states.get(c.id) || 'untested', authorizationURL:authorizations.get(c.id) });
  function oauthProvider(id) {
    const read=()=>load().connectors.find(c=>c.id===id)?.oauth || {};
    const patch=(changes)=>{const data=load(),c=data.connectors.find(c=>c.id===id);if(!c)throw new Error('连接器已移除');c.oauth={...c.oauth,...changes};save(data);};
    return {
      redirectUrl:callbackURL,
      clientMetadata:{client_name:'Power',redirect_uris:[callbackURL],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'},
      state:()=>{const state=randomUUID();patch({state,expires:Date.now()+10*60000});return state;},
      clientInformation:()=>read().client,
      saveClientInformation:(client)=>patch({client}),
      tokens:()=>read().tokens,
      saveTokens:(tokens)=>patch({tokens}),
      saveCodeVerifier:(verifier)=>patch({verifier}),
      codeVerifier:()=>{const v=read().verifier;if(!v)throw new Error('登录验证已过期');return v;},
      redirectToAuthorization:(url)=>{serviceURL(url.origin);authorizations.set(id,url.href);states.set(id,'login_required');},
      invalidateCredentials:(scope)=>{const changes={};if(scope==='all'||scope==='client')changes.client=undefined;if(scope==='all'||scope==='tokens')changes.tokens=undefined;if(scope==='all'||scope==='verifier')changes.verifier=undefined;patch(changes);},
    };
  }
  async function closeOne(id) { const promise = connections.get(id); connections.delete(id); if (promise) await promise.then((c) => c.close()).catch(() => {}); }
  async function client(id) {
    const c = load().connectors.find((x) => x.id === id && x.enabled);
    if (!c) throw new Error('连接器不存在或未启用');
    if (!connections.has(id)) connections.set(id, (async () => {
      const instance = new Client({ name: 'power-connectors', version: '1.0.0' }, { capabilities: {} });
      const transport = c.type === 'stdio'
        ? new StdioClientTransport({ command: c.command, args: c.args || [], env: { ...Object.fromEntries(['PATH','HOME','USER','TMPDIR','SHELL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])), ...c.env }, stderr: 'ignore' })
        : new StreamableHTTPClientTransport(new URL(c.url), { ...(!c.token?{authProvider:oauthProvider(id)}:{}), requestInit: { headers: c.token ? { Authorization: `Bearer ${c.token}` } : {} } });
      try { await instance.connect(transport, { timeout: 15000 }); states.set(id, 'connected'); return instance; }
      catch { await instance.close().catch(() => {}); connections.delete(id); if(authorizations.has(id)){states.set(id,'login_required');throw new Error('需要登录授权，请点击连接器的「登录授权」，完成后重新测试。');} states.set(id, 'error'); throw new Error('连接失败，请检查地址、服务运行状态和授权；OAuth 服务需支持客户端注册'); }
    })());
    return connections.get(id);
  }
  return {
    list: () => load().connectors.map(redact),
    async upsert(input) {
      const data = load(), id = input.id || randomUUID(), old = data.connectors.find((c) => c.id === id);
      if (!validId.test(id)) throw new Error('无效连接器 ID');
      if (!['http', 'stdio'].includes(input.type)) throw new Error('连接类型必须为 http 或 stdio');
      const c = { id, name: String(input.name || '').trim().slice(0, 80), type: input.type, enabled: input.enabled !== false };
      if (!c.name) throw new Error('连接器需要名称');
      if (c.type === 'http') {
        c.url = serviceURL(input.url);
        c.oauth = old?.url === c.url ? old.oauth : undefined;
        c.token = input.clearToken ? '' : String(input.token || (old?.url === c.url ? old?.token || '' : ''));
      } else {
        if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('请填写 MCP 服务命令');
        if (input.args && (!Array.isArray(input.args) || input.args.some((x) => typeof x !== 'string'))) throw new Error('args 必须为字符串数组');
        if (input.env && (typeof input.env !== 'object' || Array.isArray(input.env) || Object.values(input.env).some((x) => typeof x !== 'string'))) throw new Error('env 必须为字符串键值对象');
        c.command = input.command.trim(); c.args = input.args || []; c.env = input.env ?? old?.env ?? {};
      }
      data.connectors = [...data.connectors.filter((x) => x.id !== id), c]; save(data); await closeOne(id); states.delete(id); authorizations.delete(id); return redact(c);
    },
    async remove(id) { const data = load(); data.connectors = data.connectors.filter((x) => x.id !== id); save(data); await closeOne(id); states.delete(id); authorizations.delete(id); },
    async finishOAuth(state,code) {
      const c=load().connectors.find(c=>c.oauth?.state===state && c.oauth.expires>Date.now());
      if(!state || !code || !c || c.type!=='http' || !c.enabled)throw new Error('授权已过期或 state 不匹配，请重新测试连接');
      const provider=oauthProvider(c.id);
      const transport=new StreamableHTTPClientTransport(new URL(c.url),{authProvider:provider});
      try {await transport.finishAuth(code);} catch {throw new Error('授权兑换失败，请重新测试连接');} finally {await transport.close().catch(()=>{});}
      const data=load(),saved=data.connectors.find(x=>x.id===c.id);if(saved?.oauth){delete saved.oauth.state;delete saved.oauth.verifier;delete saved.oauth.expires;save(data);}
      authorizations.delete(c.id);states.set(c.id,'authorized');await closeOne(c.id);return {authorized:true,name:c.name};
    },
    async tools(id) {
      const c = await client(id); let cursor; const tools = [];
      do { const page = await c.listTools({ cursor }, { timeout: 15000 }); tools.push(...page.tools); cursor = page.nextCursor; if (tools.length > 2000) throw new Error('服务返回的工具过多'); } while (cursor);
      return tools;
    },
    async call(id, name, args, signal) {
      signal?.throwIfAborted();
      const c = await client(id);
      try { return await c.callTool({ name, arguments: args || {} }, undefined, { timeout: 120000, signal }); }
      catch { states.set(id, 'error'); throw new Error('连接器调用失败或已取消；请重新测试连接'); }
    },
    async close() { await Promise.all([...connections.keys()].map(closeOne)); },
  };
}
