// index.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import axios from 'axios';
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ChannelType,
} from 'discord.js';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

// ===================== 기본 설정 =====================
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;  // 10분 (운영 권장)
const API_DELAY_PER_USER_MS = 300;           // Lost Ark API 호출 사이 지연
const EDIT_DELAY_MS        = 500;            // 메시지 편집 사이 지연
const SCAN_LIMIT_PER_CHANNEL = 50;           // 채널당 최근 N개 메시지 탐색
const PERSIST_DIR = '.';
const EPHEMERAL   = 1 << 6;                  // interaction flags
const BOARD_TAG   = '[LOA_BOARD]';

// ===================== HTTP keep-alive: 부팅 즉시 시작 =====================
const PORT = process.env.PORT || 8080;
http.createServer((_, res) => res.end('ok')).listen(PORT, () => {
  console.log('🌐 HTTP keep-alive server listening on', PORT);
});

// 런타임 예외 로깅
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION', e));
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });

// ===================== 저장 파일 경로 =====================
const LINKS_PATH  = path.join(PERSIST_DIR, 'links.json');   // { userId: { main, personal? } }
const BOARDS_PATH = path.join(PERSIST_DIR, 'boards.json');  // [{channelId, messageId}]

// ===================== Lost Ark API =====================
const api = axios.create({
  baseURL: 'https://developer-lostark.game.onstove.com',
  headers: { Authorization: `Bearer ${process.env.LOSTARK_API_KEY}` },
  timeout: 10000,
  httpAgent:  new HttpAgent({ keepAlive: true }),
  httpsAgent: new HttpsAgent({ keepAlive: true }),
});

const cache = new Map();  // url -> { data, ts }
const TTL_MS = 60 * 1000; // 디버그 1분 (운영 5~10분 권장)

async function cachedGet(url, { force = false } = {}) {
  const now = Date.now();
  const c = cache.get(url);
  if (!force && c && now - c.ts < TTL_MS) return c.data;
  const { data } = await api.get(url);
  cache.set(url, { data, ts: now });
  return data;
}
async function getSiblings(name, opts) {
  const url = `/characters/${encodeURIComponent(name)}/siblings`;
  return cachedGet(url, opts);
}

// ===================== 파일 I/O =====================
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); }
  catch { /* Railway read-only 대비 (일부 플랜/배포모드에서는 쓸 수 없음) */ }
}

let links  = loadJSON(LINKS_PATH,  {});  // { userId: { main, personal? } }
let boards = loadJSON(BOARDS_PATH, []);  // [{channelId, messageId}]
const boardsKey = (c, m) => `${c}:${m}`;
let boardsSet = new Set(boards.map(b => boardsKey(b.channelId, b.messageId)));

// ===================== Discord 클라이언트 =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const toLevelNum = (s) => parseFloat(String(s).replace(/,/g, '') || '0');

// ----- 슬래시 커맨드 스키마 (등록 함수에서 사용) -----
const slashCommands = [
  new SlashCommandBuilder().setName('link')
    .setDescription('대표 캐릭터 등록(등록 후 즉시 목록 출력)')
    .addStringOption(o => o.setName('name').setDescription('대표 캐릭터명').setRequired(true)),

  new SlashCommandBuilder().setName('unlink')
    .setDescription('대표 캐릭터 연결 해제'),

  new SlashCommandBuilder().setName('mychars')
    .setDescription('내 계정의 모든 캐릭터 목록(즉시 조회)')
    .addBooleanOption(o => o.setName('public').setDescription('채널에 모두 보이게 표시')),

  new SlashCommandBuilder().setName('mychars-pin')
    .setDescription('개인 캐릭터 목록 고정(공개) 및 자동 갱신'),

  new SlashCommandBuilder().setName('board-enable')
    .setDescription('현재 채널에 공용 보드 메시지를 생성/등록(자동 갱신 대상)'),

  new SlashCommandBuilder().setName('board-disable')
    .setDescription('현재 채널의 공용 보드 관리를 해제(메시지는 삭제하지 않음)'),

  new SlashCommandBuilder().setName('board-refresh')
    .setDescription('모든 보드 즉시 갱신'),

  new SlashCommandBuilder().setName('board-scan')
    .setDescription('길드의 모든 채널에서 보드 메시지를 자동 탐색/등록'),
];

// ----- 커맨드 등록(ready 이후 호출) -----
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: slashCommands.map(c => c.toJSON()) }
  );
  console.log('🪄 Slash commands registered');
}

// ----- 로그인 with 재시도 -----
async function loginWithRetry(maxTries = 5) {
  let attempt = 0;
  while (attempt < maxTries) {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      return;
    } catch (e) {
      attempt++;
      console.error(`login failed (try ${attempt}/${maxTries})`, e?.message || e);
      await wait(2000 * attempt);
    }
  }
  throw new Error('Discord login failed after retries');
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('registerCommands error:', e?.rawError ?? e);
  }

  try { await discoverBoards(); }
  catch (e) { console.error('discoverBoards error:', e?.rawError ?? e); }

  startAutoRefresh();
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // ===== /link =====
  if (i.commandName === 'link') {
    const name = i.options.getString('name', true).trim();
    try {
      const sib = await getSiblings(name, { force: true });
      if (!Array.isArray(sib) || sib.length === 0) {
        return i.reply({ content: `❌ **${name}** 캐릭터를 찾지 못했어요.`, flags: EPHEMERAL });
      }
      const cur = links[i.user.id] || {};
      links[i.user.id] = { ...cur, main: name };
      saveJSON(LINKS_PATH, links);

      // 1) 본인 미리보기(에페메랄)
      await replyMyChars(i, name, false);

      // 2) 공개 고정 + 자동 갱신 등록까지 자동 수행
      try {
        const res = await ensurePersonalPinnedInChannel(i.channelId, i.user.id, name);
        await i.followUp({
          content: res === 'created' ? '📌 개인 캐릭터 목록을 채널에 고정했습니다.' : '🔄 개인 캐릭터 목록을 갱신했습니다.',
          flags: EPHEMERAL
        }).catch(()=>{});
      } catch (e2) {
        console.error('auto pin after link error:', e2?.rawError ?? e2);
        await i.followUp({ content: '⚠️ 개인 고정 메시지 생성/갱신 실패. `/mychars-pin`을 직접 실행해 주세요.', flags: EPHEMERAL }).catch(()=>{});
      }

      if (!i.replied && !i.deferred) {
        await i.reply({ content: '✅ 대표 캐릭터가 등록되었습니다.', flags: EPHEMERAL });
      }
    } catch (e) {
      console.error('link error:', e?.response?.data || e);
      await i.reply({ content: '❌ Lost Ark API 호출 오류', flags: EPHEMERAL });
    }
  }

  // ===== /unlink =====
  if (i.commandName === 'unlink') {
    if (links[i.user.id]?.main) {
      const cur = links[i.user.id];
      delete cur.main;
      links[i.user.id] = cur;
      saveJSON(LINKS_PATH, links);
      await i.reply({ content: '🔓 연결 해제되었습니다.', flags: EPHEMERAL });
    } else {
      await i.reply({ content: '연결된 대표 캐릭터가 없습니다.', flags: EPHEMERAL });
    }
  }

  // ===== /mychars =====
  if (i.commandName === 'mychars') {
    const main = links[i.user.id]?.main;
    if (!main) return i.reply({ content: '먼저 `/link [캐릭터명]` 으로 연결해주세요.', flags: EPHEMERAL });
    try {
      const isPublic = i.options.getBoolean('public') || false;
      await replyMyChars(i, main, isPublic);
    } catch (e) {
      console.error('mychars error:', e?.response?.data || e);
      await i.reply({ content: '❌ 캐릭터 불러오기 실패', flags: EPHEMERAL });
    }
  }

  // ===== /mychars-pin =====
  if (i.commandName === 'mychars-pin') {
    const me = links[i.user.id];
    if (!me?.main) return i.reply({ content: '먼저 `/link [캐릭터명]` 으로 연결해주세요.', flags: EPHEMERAL });
    await i.deferReply({ flags: EPHEMERAL });
    try {
      const res = await ensurePersonalPinnedInChannel(i.channelId, i.user.id, me.main);
      await i.editReply(res === 'created' ? '📌 개인 캐릭터 목록을 고정했습니다.' : '🔄 개인 캐릭터 목록을 갱신했습니다.');
    } catch (e) {
      console.error('mychars-pin error:', e?.rawError ?? e);
      await i.editReply('❌ 개인 메시지 고정/갱신에 실패했어요.');
    }
  }

  // ===== /board-enable =====
  if (i.commandName === 'board-enable') {
    await i.deferReply({ flags: EPHEMERAL });
    try {
      const msg = await ensureBoardInChannel(i.channelId);
      addBoard(i.channelId, msg.id);
      await i.editReply('📌 이 채널의 보드를 자동 갱신 대상으로 등록했습니다.');
    } catch (e) {
      console.error('board-enable error:', e?.rawError ?? e);
      await i.editReply('❌ 보드 생성/등록에 실패했습니다.');
    }
  }

  // ===== /board-disable =====
  if (i.commandName === 'board-disable') {
    const before = boards.length;
    boards = boards.filter(b => b.channelId !== i.channelId);
    boardsSet = new Set(boards.map(b => boardsKey(b.channelId, b.messageId)));
    saveJSON(BOARDS_PATH, boards);
    await i.reply({
      content: before !== boards.length ? '🧹 이 채널의 보드 관리를 해제했습니다.' : 'ℹ️ 이 채널에는 등록된 보드가 없습니다.',
      flags: EPHEMERAL
    });
  }

  // ===== /board-refresh =====
  if (i.commandName === 'board-refresh') {
    await i.deferReply({ flags: EPHEMERAL });
    try {
      await refreshAllBoards(true);
      await refreshAllPersonalOnce();
      await i.editReply('🔄 모든 보드를 즉시 갱신했습니다.');
    } catch (e) {
      console.error('board-refresh error:', e);
      await i.editReply('❌ 갱신 중 오류가 발생했습니다.');
    }
  }

  // ===== /board-scan =====
  if (i.commandName === 'board-scan') {
    await i.deferReply({ flags: EPHEMERAL });
    try {
      const found = await discoverBoards();
      await i.editReply(`🔎 스캔 완료: ${found}개 보드를 관리 대상으로 등록했습니다.`);
    } catch (e) {
      console.error('board-scan error:', e);
      await i.editReply('❌ 스캔 중 오류가 발생했습니다.');
    }
  }
});

// ===================== 보드/개인 메시지 관리 =====================
async function ensureBoardInChannel(channelId) {
  const ch = await client.channels.fetch(channelId);
  if (!ch || ch.type !== ChannelType.GuildText) throw new Error('이 명령은 텍스트 채널에서만 사용 가능합니다.');
  // 기존 등록 확인
  for (const b of boards) {
    if (b.channelId === channelId) {
      const existing = await ch.messages.fetch(b.messageId).catch(() => null);
      if (existing) return existing;
    }
  }
  // 채널 최근 메시지에서 우리 마커 재사용
  const msgs = await ch.messages.fetch({ limit: SCAN_LIMIT_PER_CHANNEL }).catch(() => null);
  if (msgs) {
    const mine = [...msgs.values()].find(m => m.author?.id === client.user.id && hasBoardMarker(m));
    if (mine) return mine;
  }
  // 새로 생성
  const embed = await buildBoardEmbed(true);
  const msg = await ch.send({ embeds: [embed] });
  return msg;
}
function hasBoardMarker(message) {
  const e = message.embeds?.[0];
  return Boolean(e?.footer?.text && e.footer.text.includes(BOARD_TAG));
}
function addBoard(channelId, messageId) {
  const key = boardsKey(channelId, messageId);
  if (boardsSet.has(key)) return;
  boards.push({ channelId, messageId });
  boardsSet.add(key);
  saveJSON(BOARDS_PATH, boards);
}
async function discoverBoards() {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const chans = await guild.channels.fetch();
  let found = 0;
  for (const [, ch] of chans) {
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    let msgs = null;
    try { msgs = await ch.messages.fetch({ limit: SCAN_LIMIT_PER_CHANNEL }); } catch { continue; }
    for (const [, m] of msgs) {
      if (m.author?.id !== client.user.id) continue;
      if (!hasBoardMarker(m)) continue;
      addBoard(ch.id, m.id);
      found++;
    }
  }
  console.log(`🔎 discoverBoards: ${found} boards found (managed total=${boards.length})`);
  return found;
}
async function refreshAllBoards() {
  console.log(`[REFRESH_ALL] count=${boards.length}`);
  for (const b of boards) {
    await wait(EDIT_DELAY_MS);
    try {
      const ch = await client.channels.fetch(b.channelId).catch(() => null);
      if (!ch) { console.error('[EDIT FAIL] channel not found', b.channelId); continue; }
      const msg = await ch.messages.fetch(b.messageId).catch(() => null);
      if (!msg) { console.error('[EDIT FAIL] message not found', b.channelId, b.messageId); continue; }
      const embed = await buildBoardEmbed(true);
      await msg.edit({ embeds: [embed] });
    } catch (e) {
      console.error('[EDIT FAIL]', b.channelId, b.messageId, e?.rawError ?? e);
    }
  }
}

// ===================== 임베드 빌더 =====================
async function buildBoardEmbed() {
  const ids = Object.keys(links);
  let description = '';
  if (ids.length === 0) {
    description = '등록된 유저가 없습니다. `/link 캐릭터명`으로 등록하세요.';
  } else {
    const rows = [];
    for (const userId of ids) {
      const main = links[userId]?.main;
      if (!main) continue;
      try {
        await wait(API_DELAY_PER_USER_MS);
        const chars = await getSiblings(main, { force: true });
        if (!chars?.length) { rows.push({ userId, err: `${main}: ❌ 조회 실패` }); continue; }
        const best = chars.reduce((a, b) =>
          toLevelNum(a.ItemAvgLevel) >= toLevelNum(b.ItemAvgLevel) ? a : b
        );
        rows.push({
          userId,
          name: best.CharacterName,
          cls: best.CharacterClassName,
          levelStr: best.ItemAvgLevel,
          levelNum: toLevelNum(best.ItemAvgLevel)
        });
      } catch {
        rows.push({ userId, err: `${main}: ❌ 오류` });
      }
    }
    rows.sort((a, b) => (b.levelNum || 0) - (a.levelNum || 0));
    description = rows.map(r => r.err
      ? `• **<@${r.userId}>** — ${r.err}`
      : `• **<@${r.userId}>** — **${r.name}** (${r.cls}) | ${r.levelStr}`
    ).join('\n');
  }
  return new EmbedBuilder()
    .setTitle('서버 현황판 (등록자 기준)')
    .setDescription(description)
    .setFooter({ text: `${BOARD_TAG} 마지막 갱신: ${new Date().toLocaleString('ko-KR',{ timeZone:'Asia/Seoul' })}` })
    .setColor(0xFFD700);
}

// ★★★ 여기부터 '닉네임만' 사용하도록 수정됨 ★★★
async function buildPersonalEmbed(userId, mainName, channelId) {
  const chars = await getSiblings(mainName, { force: true });
  const sorted = [...chars].sort((a,b) => toLevelNum(b.ItemAvgLevel) - toLevelNum(a.ItemAvgLevel));
  const lines = sorted.map(c =>
    `• **${c.CharacterName}** (${c.CharacterClassName}) — ${c.ServerName} | 아이템 레벨 ${c.ItemAvgLevel}`
  );
  const displayName = await getDisplayName(userId, channelId); // 디코 닉네임만
  return new EmbedBuilder()
    .setTitle(`**${displayName}**님의 캐릭터 목록`)
    .setDescription(lines.join('\n'))
    .setColor(0x00AE86)
    .setFooter({ text: `${BOARD_TAG} 개인 • 마지막 갱신: ${new Date().toLocaleString('ko-KR',{ timeZone:'Asia/Seoul' })}` });
}

async function replyMyChars(i, mainName, isPublic = false) {
  const embed = await buildPersonalEmbed(i.user.id, mainName, i.channelId);
  const payload = { embeds: [embed] };
  if (!isPublic) payload.flags = EPHEMERAL;   // 기본은 에페메랄
  if (i.replied || i.deferred) {
    await i.editReply(payload).catch(async () => i.followUp(payload));
  } else {
    await i.reply(payload);
  }
}

// 개인 고정 메시지(공개) 생성/업데이트 + 위치 저장
async function ensurePersonalPinnedInChannel(channelId, userId, mainName) {
  const ch = await client.channels.fetch(channelId);
  let existing = null;
  const me = links[userId] || {};
  const old = me.personal;
  if (old?.channelId && old?.messageId) {
    const och = await client.channels.fetch(old.channelId).catch(()=>null);
    existing = och ? await och.messages.fetch(old.messageId).catch(()=>null) : null;
  }
  const embed = await buildPersonalEmbed(userId, mainName, channelId);
  if (!existing) {
    const msg = await ch.send({ embeds: [embed] }); // 공개
    links[userId] = { ...me, personal: { channelId: ch.id, messageId: msg.id } };
    saveJSON(LINKS_PATH, links);
    return 'created';
  } else {
    await existing.edit({ embeds: [embed] });
    links[userId] = { ...me, personal: { channelId: ch.id, messageId: existing.id } };
    saveJSON(LINKS_PATH, links);
    return 'updated';
  }
}

// ===================== 자동 갱신 루프 =====================
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const tick = async () => {
    console.log('[TICK]', new Date().toISOString(), `managedBoards=${boards.length}`);
    try {
      await refreshAllBoards(true);
      await refreshAllPersonalOnce();
    } catch (e) {
      console.error('auto refresh error:', e);
    }
  };
  tick(); // 즉시 1회
  refreshTimer = setInterval(tick, REFRESH_INTERVAL_MS);
  console.log('⏱️ 자동 갱신 시작');
}
async function refreshAllPersonalOnce() {
  const entries = Object.entries(links);
  for (const [userId, info] of entries) {
    const p = info?.personal;
    const main = info?.main;
    if (!p?.channelId || !p?.messageId || !main) continue;
    await wait(EDIT_DELAY_MS);
    try {
      const ch = await client.channels.fetch(p.channelId).catch(() => null);
      if (!ch) { console.error('[EDIT FAIL personal] channel not found', userId, p.channelId); continue; }
      const msg = await ch.messages.fetch(p.messageId).catch(() => null);
      if (!msg) { console.error('[EDIT FAIL personal] message not found', userId, p.channelId, p.messageId); continue; }
      const embed = await buildPersonalEmbed(userId, main, p.channelId);
      await msg.edit({ embeds: [embed] });
      console.log('[EDIT OK personal]', userId, p.channelId, p.messageId);
    } catch (e) {
      console.error('[EDIT FAIL personal]', userId, e?.rawError ?? e);
    }
  }
}

// ===================== 닉네임(표시이름) 전용 헬퍼 =====================
async function getDisplayName(userId, channelId) {
  const ch = await client.channels.fetch(channelId);
  const member = await ch.guild.members.fetch(userId);
  return member.displayName; // 디코 닉네임만 반환
}

// ===================== 유틸 =====================
function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

// ===================== 로그인 시작 =====================
loginWithRetry().catch((e) => {
  console.error('FATAL login error:', e?.message || e);
  // Railway가 컨테이너를 계속 살려두도록 프로세스는 유지(HTTP 서버는 이미 리슨 중)
});
