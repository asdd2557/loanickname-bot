// index.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import axios from 'axios';
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ChannelType,
} from 'discord.js';

// ===================== 설정 =====================
const REFRESH_INTERVAL_MS = 1 * 60 * 1000; // 1분
const API_DELAY_PER_USER_MS = 300;          // Lost Ark API 호출 사이 지연
const EDIT_DELAY_MS = 500;                  // 메시지 편집 사이 지연(레이트리밋 안전)
const SCAN_LIMIT_PER_CHANNEL = 50;          // 채널당 최근 N개 메시지만 스캔
const PERSIST_DIR = '.';

// ===================== 저장 파일 =====================
const LINKS_PATH = path.join(PERSIST_DIR, 'links.json');   // { userId: { main, personal? } }
const BOARDS_PATH = path.join(PERSIST_DIR, 'boards.json'); // [{channelId, messageId}]
const BOARD_TAG = '[LOA_BOARD]';                           // 우리 보드 식별 마커(푸터에 넣음)

// ===================== 로아 API =====================
const api = axios.create({
  baseURL: 'https://developer-lostark.game.onstove.com',
  headers: { Authorization: `Bearer ${process.env.LOSTARK_API_KEY}` }
});

const cache = new Map();           // url -> { data, ts }
const TTL_MS = 60 * 1000; // 디버그용 1분 (확인되면 5~10분 등으로 조절)

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
  catch { /* read-only 대비 */ }
}

let links  = loadJSON(LINKS_PATH, {});            // { userId: { main } }
let boards = loadJSON(BOARDS_PATH, []);           // [{channelId, messageId}]
const boardsKey = (c, m) => `${c}:${m}`;
let boardsSet = new Set(boards.map(b => boardsKey(b.channelId, b.messageId)));

// ===================== 커맨드 등록 =====================
const commands = [
  new SlashCommandBuilder().setName('link')
    .setDescription('대표 캐릭터 등록(등록 후 즉시 목록 출력)')
    .addStringOption(o => o.setName('name').setDescription('대표 캐릭터명').setRequired(true)),

  new SlashCommandBuilder().setName('unlink')
    .setDescription('대표 캐릭터 연결 해제'),

  new SlashCommandBuilder().setName('mychars')
    .setDescription('내 계정의 모든 캐릭터 목록(즉시 조회)'),

  new SlashCommandBuilder().setName('board-enable')
    .setDescription('현재 채널에 공용 보드 메시지를 생성/등록(자동 갱신 대상)'),

  new SlashCommandBuilder().setName('board-disable')
    .setDescription('현재 채널의 공용 보드 관리를 해제(메시지는 삭제하지 않음)'),

  new SlashCommandBuilder().setName('board-refresh')
    .setDescription('모든 보드 즉시 갱신'),

  new SlashCommandBuilder().setName('board-scan')
    .setDescription('길드의 모든 채널에서 보드 메시지를 자동 탐색/등록'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

// ===================== Discord 클라이언트 =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// 숫자 파서(1,654.17 → 1654.17)
const toLevelNum = (s) => parseFloat(String(s).replace(/,/g, '') || '0');

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // (선택) .env에 고정된 특정 보드가 있으면 목록에 포함
  if (process.env.BOARD_CHANNEL_ID && process.env.BOARD_MESSAGE_ID) {
    addBoard(process.env.BOARD_CHANNEL_ID, process.env.BOARD_MESSAGE_ID);
    console.log('📌 env 보드 추가:', process.env.BOARD_CHANNEL_ID, process.env.BOARD_MESSAGE_ID);
  }

  // 부팅 시 1회 전체 스캔(자동 등록)
  try {
    await discoverBoards();
  } catch (e) {
    console.error('discoverBoards error:', e?.rawError ?? e);
  }

  // 자동 갱신 시작
  startAutoRefresh();

  // Railway(Web) 슬립 방지
  const PORT = process.env.PORT || 3000;
  http.createServer((_, res) => res.end('ok')).listen(PORT, () => {
    console.log('🌐 HTTP keep-alive server listening on', PORT);
  });
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // ===== /link =====
  if (i.commandName === 'link') {
    const name = i.options.getString('name', true).trim();
    try {
      const sib = await getSiblings(name, { force: true });
      if (!Array.isArray(sib) || sib.length === 0) {
        return i.reply({ content: `❌ **${name}** 캐릭터를 찾지 못했어요.`, ephemeral: true });
      }
      const cur = links[i.user.id] || {};
      links[i.user.id] = { ...cur, main: name };
      saveJSON(LINKS_PATH, links);

      await replyMyChars(i, name);
      await i.followUp?.({ content: '✅ 대표 캐릭터가 등록되었습니다.', ephemeral: true }).catch(()=>{});
    } catch (e) {
      console.error('link error:', e?.response?.data || e);
      await i.reply({ content: '❌ Lost Ark API 호출 오류', ephemeral: true });
    }
  }

  // ===== /unlink =====
  if (i.commandName === 'unlink') {
    if (links[i.user.id]?.main) {
      const cur = links[i.user.id];
      delete cur.main;
      links[i.user.id] = cur;
      saveJSON(LINKS_PATH, links);
      await i.reply({ content: '🔓 연결 해제되었습니다.', ephemeral: true });
    } else {
      await i.reply({ content: '연결된 대표 캐릭터가 없습니다.', ephemeral: true });
    }
  }

  // ===== /mychars =====
  if (i.commandName === 'mychars') {
    const main = links[i.user.id]?.main;
    if (!main) return i.reply({ content: '먼저 `/link [캐릭터명]` 으로 연결해주세요.', ephemeral: true });
    try {
      await replyMyChars(i, main);
    } catch (e) {
      console.error('mychars error:', e?.response?.data || e);
      await i.reply('❌ 캐릭터 불러오기 실패');
    }
  }

  // ===== /board-enable =====
  if (i.commandName === 'board-enable') {
    await i.deferReply({ ephemeral: true });
    try {
      const msg = await ensureBoardInChannel(i.channelId); // 메시지 생성 또는 재사용
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
    await i.reply({ content: before !== boards.length ? '🧹 이 채널의 보드 관리를 해제했습니다.' : 'ℹ️ 이 채널에는 등록된 보드가 없습니다.', ephemeral: true });
  }

  // ===== /board-refresh =====
  if (i.commandName === 'board-refresh') {
    await i.deferReply({ ephemeral: true });
    try {
      await refreshAllBoards(true);
      await i.editReply('🔄 모든 보드를 즉시 갱신했습니다.');
    } catch (e) {
      console.error('board-refresh error:', e);
      await i.editReply('❌ 갱신 중 오류가 발생했습니다.');
    }
  }

  // ===== /board-scan =====
  if (i.commandName === 'board-scan') {
    await i.deferReply({ ephemeral: true });
    try {
      const found = await discoverBoards();
      await i.editReply(`🔎 스캔 완료: ${found}개 보드를 관리 대상으로 등록했습니다.`);
    } catch (e) {
      console.error('board-scan error:', e);
      await i.editReply('❌ 스캔 중 오류가 발생했습니다.');
    }
  }
});

// ===================== 보드 관리 로직 =====================

// 현재 채널에 보드가 없으면 생성, 있으면 재사용
async function ensureBoardInChannel(channelId) {
  const ch = await client.channels.fetch(channelId);
  // 기존 등록된 것부터 찾기
  let existing = null;
  for (const b of boards) {
    if (b.channelId === channelId) {
      existing = await ch.messages.fetch(b.messageId).catch(() => null);
      if (existing) return existing;
    }
  }
  // 채널 최근 메시지에서 우리 마커가 있는 것을 우선 재사용
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

// 보드 마커 탐지(푸터 텍스트에 [LOA_BOARD] 포함)
function hasBoardMarker(message) {
  const e = message.embeds?.[0];
  return Boolean(e?.footer?.text && e.footer.text.includes(BOARD_TAG));
}

// 보드 목록에 추가(중복 제거)
function addBoard(channelId, messageId) {
  const key = boardsKey(channelId, messageId);
  if (boardsSet.has(key)) return;
  boards.push({ channelId, messageId });
  boardsSet.add(key);
  saveJSON(BOARDS_PATH, boards);
}

// 길드 전체 채널에서 보드 자동 탐색
async function discoverBoards() {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const chans = await guild.channels.fetch();
  let found = 0;

  for (const [, ch] of chans) {
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    // 채널 권한/가용성 체크
    let msgs = null;
    try {
      msgs = await ch.messages.fetch({ limit: SCAN_LIMIT_PER_CHANNEL });
    } catch { continue; }

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

// 모든 보드 편집
async function refreshAllBoards(force = false) {
  console.log(`[REFRESH_ALL] count=${boards.length}`);
  for (const b of boards) {
    await wait(EDIT_DELAY_MS);
    try {
      const ch = await client.channels.fetch(b.channelId).catch(() => null);
      if (!ch) continue;
      const msg = await ch.messages.fetch(b.messageId).catch(() => null);
      if (!msg) continue;
      const embed = await buildBoardEmbed(true);
      await msg.edit({ embeds: [embed] }).catch(()=>{});
    } catch (e) {
      console.error('board edit error:', b.channelId, b.messageId, e?.rawError ?? e);
    }
  }
}

// ===================== 임베드 빌더 =====================
async function buildBoardEmbed(force = false) {
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
        if (!chars?.length) {
          rows.push({ userId, err: `${main}: ❌ 조회 실패` });
          continue;
        }
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
    description = rows.map(r => {
      if (r.err) return `• **<@${r.userId}>** — ${r.err}`;
      return `• **<@${r.userId}>** — **${r.name}** (${r.cls}) | ${r.levelStr}`;
    }).join('\n');
  }

  return new EmbedBuilder()
    .setTitle('서버 현황판 (등록자 기준)')
    .setDescription(description)
   .setFooter({ text: `${BOARD_TAG} 마지막 갱신: ${new Date().toLocaleString('ko-KR',{ timeZone:'Asia/Seoul' })} (주기: ${Math.floor(REFRESH_INTERVAL_MS/60000)}분)` })

    .setColor(0xFFD700);
}

// 즉시 응답용 개인 임베드
async function replyMyChars(i, mainName) {
  const chars = await getSiblings(mainName, { force: true });
  const sorted = [...chars].sort((a,b) => toLevelNum(b.ItemAvgLevel) - toLevelNum(a.ItemAvgLevel));
  const displayName = i.member?.displayName || i.user.username;

  const embed = new EmbedBuilder()
    .setTitle(`**${displayName}**님의 캐릭터 목록`)
    .setDescription(sorted.map(c =>
      `• **${c.CharacterName}** (${c.CharacterClassName}) — ${c.ServerName} | 아이템 레벨 ${c.ItemAvgLevel}`
    ).join('\n'))
    .setColor(0x00AE86)
.setFooter({ text: `${BOARD_TAG} 마지막 갱신: ${new Date().toLocaleString('ko-KR',{ timeZone:'Asia/Seoul' })} (주기: ${Math.floor(REFRESH_INTERVAL_MS/60000)}분)` })


  if (i.replied || i.deferred) {
    await i.editReply({ embeds: [embed] }).catch(async () => i.followUp({ embeds: [embed] }));
  } else {
    await i.reply({ embeds: [embed] });
  }
}

// ===================== 자동 갱신 타이머 =====================
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);

  const tick = async () => {
    console.log('[TICK]', new Date().toISOString(), `managedBoards=${boards.length}`);
    try {
      await refreshAllBoards(true);
    } catch (e) {
      console.error('auto refresh error:', e);
    }
  };

  tick(); // 즉시 1회
  refreshTimer = setInterval(tick, REFRESH_INTERVAL_MS);
  console.log('⏱️ 자동 갱신 시작');
}

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

// ===================== 로그인 =====================
client.login(process.env.DISCORD_TOKEN);

// ===================== 끝 =====================
