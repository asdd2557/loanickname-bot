import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
} from 'discord.js';

// ------------------------- 저장 파일 -------------------------
const LINKS_PATH = path.join('links.json');   // 유저 ↔ 대표캐릭
const BOARD_PATH = path.join('board.json');   // 현황판 메시지 위치 및 설정

// ------------------------- 설정 -------------------------
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10분마다 자동 갱신
const API_DELAY_PER_USER_MS = 250;

// ------------------------- Lost Ark API -------------------------
const api = axios.create({
  baseURL: 'https://developer-lostark.game.onstove.com',
  headers: { Authorization: `Bearer ${process.env.LOSTARK_API_KEY}` }
});

async function getSiblings(name) {
  const { data } = await api.get(`/characters/${encodeURIComponent(name)}/siblings`);
  return data;
}

// ------------------------- 캐시 -------------------------
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;
async function cachedGetSiblings(name) {
  const url = `/characters/${encodeURIComponent(name)}/siblings`;
  const c = cache.get(url);
  const now = Date.now();
  if (c && now - c.ts < TTL_MS) return c.data;
  const { data } = await api.get(url);
  cache.set(url, { data, ts: now });
  return data;
}

// ------------------------- 파일 I/O -------------------------
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

let links = loadJSON(LINKS_PATH, {}); // { userId: mainChar }
let board = loadJSON(BOARD_PATH, { channelId: null, messageId: null, enabled: false });

// ------------------------- 명령 등록 -------------------------
const commands = [
  new SlashCommandBuilder().setName('link')
    .setDescription('내 디코 계정에 로아 대표 캐릭터명을 연결합니다.')
    .addStringOption(o => o.setName('name').setDescription('대표 캐릭터명').setRequired(true)),
  new SlashCommandBuilder().setName('unlink')
    .setDescription('연결된 대표 캐릭터명을 해제합니다.'),
  new SlashCommandBuilder().setName('mychars')
    .setDescription('내 계정의 모든 캐릭터 목록을 보여줍니다.'),
  new SlashCommandBuilder().setName('board-refresh')
    .setDescription('현황판을 즉시 갱신합니다.'),
  new SlashCommandBuilder().setName('board-stop')
    .setDescription('현황판 자동 갱신을 중지합니다.'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

// ------------------------- 디스코드 클라이언트 -------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  if (board.enabled && board.channelId && board.messageId) {
    startAutoRefresh();
  }
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // /link
  if (i.commandName === 'link') {
    const name = i.options.getString('name', true).trim();
    try {
      const sib = await getSiblings(name);
      if (!Array.isArray(sib) || sib.length === 0) {
        return i.reply({ content: `❌ 캐릭터 **${name}** 를 찾지 못했어요.`, ephemeral: true });
      }

      // 저장
      links[i.user.id] = name;
      saveJSON(LINKS_PATH, links);

      // 개인 캐릭터 목록 즉시 출력
      const chars = await getSiblings(name);
      const sorted = [...chars].sort((a, b) => parseFloat(b.ItemAvgLevel) - parseFloat(a.ItemAvgLevel));
      const displayName = i.member?.displayName || i.user.username;
      const embed = new EmbedBuilder()
        .setTitle(`${displayName}님의 캐릭터 목록`)
        .setDescription(sorted.map(c =>
          `• **${c.CharacterName}** (${c.CharacterClassName}) — ${c.ServerName} | 아이템 레벨 ${c.ItemAvgLevel}`
        ).join('\n'))
        .setColor(0x00AE86);
      await i.reply({ embeds: [embed] });

      // 현황판 자동 갱신 보장
      if (!board.channelId || !board.messageId) {
        const msg = await i.channel.send({ embeds: [await buildBoardEmbed()] });
        board.channelId = i.channelId;
        board.messageId = msg.id;
        board.enabled = true;
        saveJSON(BOARD_PATH, board);
      }
      startAutoRefresh();

    } catch (e) {
      console.error(e?.response?.data || e);
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
    if (!main) return i.reply({ content: '먼저 `/link [캐릭터명]`으로 연결해주세요.', ephemeral: true });

    try {
      const chars = await cachedGetSiblings(main);
      const sorted = [...chars].sort((a, b) => parseFloat(b.ItemAvgLevel) - parseFloat(a.ItemAvgLevel));
      const displayName = i.member?.displayName || i.user.username;
      const embed = new EmbedBuilder()
        .setTitle(`${displayName}님의 캐릭터 목록`)
        .setDescription(sorted.map(c =>
          `• **${c.CharacterName}** (${c.CharacterClassName}) — ${c.ServerName} | 아이템 레벨 ${c.ItemAvgLevel}`
        ).join('\n'))
        .setColor(0x00AE86);
      await i.reply({ embeds: [embed] });
    } catch (e) {
      console.error(e?.response?.data || e);
      await i.reply('❌ 캐릭터 불러오기 실패');
    }
  }

  // /board-refresh
  if (i.commandName === 'board-refresh') {
    await i.deferReply({ ephemeral: true });
    try {
      await refreshBoardOnce();
      await i.editReply('🔄 현황판을 갱신했습니다.');
    } catch (e) {
      console.error(e);
      await i.editReply('❌ 갱신 중 오류가 발생했습니다.');
    }
  }

  // /board-stop
  if (i.commandName === 'board-stop') {
    stopAutoRefresh();
    board.enabled = false;
    saveJSON(BOARD_PATH, board);
    await i.reply({ content: '🛑 현황판 자동 갱신을 중지했습니다.', ephemeral: true });
  }
});

// ------------------------- 현황판 -------------------------
async function buildBoardEmbed() {
  if (Object.keys(links).length === 0) {
    return new EmbedBuilder().setTitle('서버 현황판').setDescription('등록된 유저가 없습니다.');
  }

  const lines = [];
  for (const [userId, main] of Object.entries(links)) {
    try {
      await wait(API_DELAY_PER_USER_MS);
      const chars = await cachedGetSiblings(main);
      if (!chars?.length) {
        lines.push(`<@${userId}> — ${main}: ❌ 조회 실패`);
        continue;
      }
      const best = chars.reduce((a, b) => parseFloat(a.ItemAvgLevel) > parseFloat(b.ItemAvgLevel) ? a : b);
      lines.push(`• <@${userId}> — **${best.CharacterName}** (${best.CharacterClassName}) | ${best.ItemAvgLevel}`);
    } catch {
      lines.push(`<@${userId}> — ${main}: ❌ 오류`);
    }
  }

  return new EmbedBuilder()
    .setTitle('서버 현황판 (등록자 기준)')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `자동 갱신: ${Math.floor(REFRESH_INTERVAL_MS / 60000)}분마다` })
    .setColor(0xFFD700);
}

async function refreshBoardOnce() {
  if (!board.enabled || !board.channelId || !board.messageId) return;
  const channel = await client.channels.fetch(board.channelId);
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

// ------------------------- 자동 갱신 -------------------------
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshBoardOnce().catch(err => console.error('auto refresh error', err));
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

client.login(process.env.DISCORD_TOKEN);
