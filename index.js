import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
} from 'discord.js';

// ===================== 설정 =====================
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10분
const API_DELAY_PER_USER_MS = 250;          // 사용자 간 API 호출 텀
const PERSIST_DIR = '.';                     // 데이터 파일 저장 위치(루트)

// ===================== 저장 파일 =====================
const LINKS_PATH = path.join(PERSIST_DIR, 'links.json'); // { userId: "MainChar" }
const BOARD_PATH = path.join(PERSIST_DIR, 'board.json'); // { channelId, messageId, enabled }

// ===================== 로아 API 클라이언트/캐시 =====================
const api = axios.create({
  baseURL: 'https://developer-lostark.game.onstove.com',
  headers: { Authorization: `Bearer ${process.env.LOSTARK_API_KEY}` }
});

const cache = new Map();           // url -> { data, ts }
const TTL_MS = 10 * 60 * 1000;     // 10분 캐시

async function cachedGet(url) {
  const now = Date.now();
  const c = cache.get(url);
  if (c && now - c.ts < TTL_MS) return c.data;
  const { data } = await api.get(url);
  cache.set(url, { data, ts: now });
  return data;
}

async function getSiblings(name) {
  const url = `/characters/${encodeURIComponent(name)}/siblings`;
  return cachedGet(url); // [{ CharacterName, CharacterClassName, ItemAvgLevel, ServerName, ... }]
}

// ===================== 파일 I/O =====================
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

let links = loadJSON(LINKS_PATH, {}); // 등록자:대표캐릭
let board  = loadJSON(BOARD_PATH, { channelId: null, messageId: null, enabled: false });

// ===================== 커맨드 등록 =====================
const commands = [
  new SlashCommandBuilder().setName('link')
    .setDescription('대표 캐릭터 등록(등록 후 즉시 목록 출력 & 자동 갱신 시작)')
    .addStringOption(o => o.setName('name').setDescription('대표 캐릭터명').setRequired(true)),
  new SlashCommandBuilder().setName('unlink')
    .setDescription('대표 캐릭터 연결 해제'),
  new SlashCommandBuilder().setName('mychars')
    .setDescription('내 계정의 모든 캐릭터 목록'),
  new SlashCommandBuilder().setName('board-refresh')
    .setDescription('현황판 즉시 갱신'),
  new SlashCommandBuilder().setName('board-stop')
    .setDescription('현황판 자동 갱신 중지'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

// ===================== Discord 클라이언트 =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 부팅 시 자동 갱신 재개(설정 ON 이고 보드 위치를 알고 있으면)
  if (board.enabled) startAutoRefresh();
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // /link : 등록 + 즉시 개인 목록 출력 + (보드 없으면 생성) + 자동 갱신 시작
  if (i.commandName === 'link') {
    const name = i.options.getString('name', true).trim();

    try {
      const sib = await getSiblings(name);
      if (!Array.isArray(sib) || sib.length === 0) {
        return i.reply({ content: `❌ **${name}** 캐릭터를 찾지 못했어요.`, ephemeral: true });
      }

      // 1) 등록 저장
      links[i.user.id] = name;
      saveJSON(LINKS_PATH, links);

      // 2) 개인 목록 즉시 출력
      await replyMyChars(i, name);

      // 3) 현황판 메시지 확보(없으면 자동 생성)
      //await ensureBoardMessage(i);

      // 4) 자동 갱신 스타트
      if (!board.enabled) {
        board.enabled = true;
        saveJSON(BOARD_PATH, board);
      }
      startAutoRefresh();

    } catch (e) {
      console.error('link error:', e?.response?.data || e);
      await i.reply({ content: '❌ Lost Ark API 호출 오류', ephemeral: true });
    }
  }

  // /unlink
  if (i.commandName === 'unlink') {
    if (links[i.user.id]) {
      delete links[i.user.id];
      saveJSON(LINKS_PATH, links);
      await i.reply({ content: '🔓 연결 해제되었습니다.', ephemeral: true });
    } else {
      await i.reply({ content: '연결된 대표 캐릭터가 없습니다.', ephemeral: true });
    }
  }

  // /mychars
  if (i.commandName === 'mychars') {
    const main = links[i.user.id];
    if (!main) return i.reply({ content: '먼저 `/link [캐릭터명]` 으로 연결해주세요.', ephemeral: true });
    try {
      await replyMyChars(i, main);
    } catch (e) {
      console.error('mychars error:', e?.response?.data || e);
      await i.reply('❌ 캐릭터 불러오기 실패');
    }
  }

  // /board-refresh : 즉시 갱신
  if (i.commandName === 'board-refresh') {
    await i.deferReply({ ephemeral: true });
    try {
      //await ensureBoardMessage(i); // 혹시 없으면 만든다
      await refreshBoardOnce();
      await i.editReply('🔄 현황판을 갱신했습니다.');
    } catch (e) {
      console.error('board-refresh error:', e);
      await i.editReply('❌ 갱신 중 오류가 발생했습니다.');
    }
  }

  // /board-stop : 자동 갱신 중지
  if (i.commandName === 'board-stop') {
    stopAutoRefresh();
    board.enabled = false;
    saveJSON(BOARD_PATH, board);
    await i.reply({ content: '🛑 현황판 자동 갱신을 중지했습니다.', ephemeral: true });
  }
});

// ===================== 유틸: 개인 목록 임베드 응답 =====================
async function replyMyChars(i, mainName) {
  const chars = await getSiblings(mainName);
  const sorted = [...chars].sort((a, b) => parseFloat(b.ItemAvgLevel) - parseFloat(a.ItemAvgLevel));
  const displayName = i.member?.displayName || i.user.username;

  const embed = new EmbedBuilder()
    .setTitle(`${displayName}님의 캐릭터 목록`)
    .setDescription(sorted.map(c =>
      `• **${c.CharacterName}** (${c.CharacterClassName}) — ${c.ServerName} | 아이템 레벨 ${c.ItemAvgLevel}`
    ).join('\n'))
    .setColor(0x00AE86);

  // /link 직후에도 보이고, /mychars 호출에도 보이도록 reply 사용
  if (i.replied || i.deferred) {
    await i.editReply({ embeds: [embed] }).catch(async () => i.followUp({ embeds: [embed] }));
  } else {
    await i.reply({ embeds: [embed] });
  }
}

// ===================== 현황판(보드) 생성/빌드/갱신 =====================
async function ensureBoardMessage(iOrNull) {
  // 1) 채널 결정: 우선순위 => env(B BOARD_CHANNEL_ID) > 저장된 board.channelId > (interaction 채널)
  let channelId = process.env.BOARD_CHANNEL_ID || board.channelId || null;
  if (!channelId && iOrNull) channelId = iOrNull.channelId;
  if (!channelId) {
    console.log('⚠️ 보드 채널 정보를 알 수 없어 생성 보류 (다음 /link 나 /board-refresh 때 시도)');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.log('⚠️ 채널 fetch 실패:', channelId);
    return;
  }

  if (board.messageId) {
    // 메시지 존재 확인
    const msg = await channel.messages.fetch(board.messageId).catch(() => null);
    if (msg) return; // 이미 있음
  }

  // 새로 생성
  const embed = await buildBoardEmbed();
  const msg = await channel.send({ embeds: [embed] });
  board.channelId  = channel.id;
  board.messageId  = msg.id;
  saveJSON(BOARD_PATH, board);
  console.log(`🧷 현황판 메시지 생성 (channel=${board.channelId}, message=${board.messageId})`);
}

async function buildBoardEmbed() {
  if (!links || Object.keys(links).length === 0) {
    return new EmbedBuilder()
      .setTitle('서버 현황판')
      .setDescription('등록된 유저가 없습니다. `/link 캐릭터명`으로 등록하세요.')
      .setColor(0x999999);
  }

  const lines = [];
  for (const [userId, main] of Object.entries(links)) {
    try {
      await wait(API_DELAY_PER_USER_MS);
      const chars = await getSiblings(main);
      if (!chars?.length) {
        lines.push(`<@${userId}> — ${main}: ❌ 조회 실패`);
        continue;
      }
      const best = chars.reduce((a, b) => parseFloat(a.ItemAvgLevel) > parseFloat(b.ItemAvgLevel) ? a : b);
      lines.push(`• <@${userId}> — **${best.CharacterName}** (${best.CharacterClassName}) | ${best.ItemAvgLevel}`);
    } catch {
      lines.push(`• <@${userId}> — ${main}: ❌ 오류`);
    }
  }

  return new EmbedBuilder()
    .setTitle('서버 현황판 (등록자 기준)')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `자동 갱신: ${Math.floor(REFRESH_INTERVAL_MS / 60000)}분마다` })
    .setColor(0xFFD700);
}

async function refreshBoardOnce() {
  if (!board.channelId || !board.messageId) {
    console.log('ℹ️ 보드 메시지가 없어 갱신 생략 (ensureBoardMessage로 생성 예정)');
    return;
  }
  const channel = await client.channels.fetch(board.channelId).catch(() => null);
  if (!channel) return;
  const msg = await channel.messages.fetch(board.messageId).catch(() => null);

  const embed = await buildBoardEmbed();
  if (msg) {
    await msg.edit({ embeds: [embed] });
  } else {
    const newMsg = await channel.send({ embeds: [embed] });
    board.messageId = newMsg.id;
    saveJSON(BOARD_PATH, board);
  }
}

// ===================== 자동 갱신 타이머 =====================
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    try {
      // 보드가 없으면 만들고(채널을 모르면 대기), 있으면 갱신
      await ensureBoardMessage(null);
      await refreshBoardOnce();
    } catch (e) {
      console.error('auto refresh error:', e);
    }
  }, REFRESH_INTERVAL_MS);
  console.log('⏱️ 현황판 자동 갱신 시작');
}
function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    console.log('⏹️ 현황판 자동 갱신 중지');
  }
}

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

// ===================== 로그인 =====================
client.login(process.env.DISCORD_TOKEN);
