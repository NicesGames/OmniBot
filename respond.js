const { Client, GatewayIntentBits } = require('discord.js');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const compromise = require('compromise');
const { fetchWikipedia, downloadWebsite } = require('./train.js');

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'knowledge.db');
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS knowledge USING fts5(content)');
  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS qa USING fts5(question, answer)');
  db.run('CREATE TABLE IF NOT EXISTS user_context (user_id TEXT, message TEXT, timestamp INTEGER)');
  db.run('CREATE TABLE IF NOT EXISTS user_profiles (user_id TEXT PRIMARY KEY, preferences TEXT, interaction_count INTEGER)');
});

const responseTemplates = [
  'Вот что я нашёл: ',
  'Кажется, ты спрашивал о... ',
  'На твой вопрос могу ответить так: ',
  'Интересный запрос! Вот ответ: ',
  'Позволь рассказать: '
];

const errorMessages = [
  'Ой, кажется, я не понял. Попробуй перефразировать или напиши `!help` для подсказок!',
  'Хм, что-то пошло не так. Можешь уточнить запрос? Или напиши `!help` для помощи.',
  'Похоже, я запутался. Давай попробуем ещё раз? Напиши `!help`, если нужна подсказка.',
  'Упс, не могу ответить. Попробуй другой вопрос или напиши `!help` для идей!'
];

const fallbackSuggestions = [
  'Может, расскажешь о любимой игре?',
  'Хочешь узнать что-то о программировании?',
  'Есть идеи для обсуждения? Напиши `!help` для подсказок!'
];

function saveToKnowledge(content) {
  if (content.length < 10) return;
  console.log(`[ИНФО] Сохранение в базу знаний: ${content.slice(0, 50)}...`);
  db.run('INSERT INTO knowledge (content) VALUES (?)', [content], (err) => {
    if (err) console.error(`[ОШИБКА] При сохранении в knowledge: ${err.message}`);
  });
}

function saveUserContext(userId, message) {
  const timestamp = Date.now();
  db.run('INSERT INTO user_context (user_id, message, timestamp) VALUES (?, ?, ?)', [userId, message, timestamp], (err) => {
    if (err) console.error(`[ОШИБКА] При сохранении контекста: ${err.message}`);
  });
  db.run('DELETE FROM user_context WHERE user_id = ? AND timestamp < ?', [userId, timestamp - 30 * 24 * 60 * 60 * 1000], (err) => {
    if (err) console.error(`[ОШИБКА] При очистке старого контекста: ${err.message}`);
  });
  db.run('DELETE FROM user_context WHERE user_id = ? AND (SELECT COUNT(*) FROM user_context WHERE user_id = ?) > 120', [userId, userId], (err) => {
    if (err) console.error(`[ОШИБКА] При ограничении контекста до 120 сообщений: ${err.message}`);
  });
}

async function getUserContext(userId) {
  return new Promise(resolve => {
    db.all('SELECT message FROM user_context WHERE user_id = ? ORDER BY timestamp DESC LIMIT 10', [userId], (err, rows) => {
      resolve(err ? [] : rows.map(row => row.message));
    });
  });
}

async function getUserProfile(userId) {
  return new Promise(resolve => {
    db.get('SELECT preferences, interaction_count FROM user_profiles WHERE user_id = ?', [userId], (err, row) => {
      resolve(err || !row ? { preferences: {}, interaction_count: 0 } : { preferences: JSON.parse(row.preferences), interaction_count: row.interaction_count });
    });
  });
}

function analyzeSentiment(message) {
  const doc = compromise(message);
  const sentiment = doc.sentences().data()[0]?.sentiment || 0;
  if (sentiment > 0.3) return 'positive';
  if (sentiment < -0.3) return 'negative';
  return 'neutral';
}

function isServerAllowed(guildId) {
  const serverFile = path.join(__dirname, 'server.txt');
  try {
    const servers = fs.readFileSync(serverFile, 'utf-8').split('\n').map(id => id.trim());
    return servers.includes(guildId);
  } catch (error) {
    console.error(`[ОШИБКА] При чтении server.txt: ${error.message}`);
    return false;
  }
}

async function searchQA(query) {
  return new Promise(resolve => {
    db.all(`SELECT question, answer FROM qa WHERE question MATCH ? LIMIT 5`, [query], (err, rows) => {
      resolve(err ? [] : rows.map(row => ({ answer: row.answer, score: calculateSimilarity(query, row.question) })));
    });
  });
}

async function searchKnowledge(query) {
  return new Promise(resolve => {
    db.all(`SELECT content FROM knowledge WHERE content MATCH ? LIMIT 5`, [query], (err, rows) => {
      resolve(err ? [] : rows.map(row => ({ content: row.content, score: calculateSimilarity(query, row.content) })));
    });
  });
}

function calculateSimilarity(query, text) {
  const queryWords = query.toLowerCase().split(/\s+/);
  const textWords = text.toLowerCase().split(/\s+/);
  const intersection = queryWords.filter(word => textWords.includes(word));
  return intersection.length / queryWords.length;
}

function cleanResponse(text) {
  return text.replace(/<@!?[0-9]+>/g, '').replace(/@[^\s]+/g, '').trim();
}

function truncateResponse(text, maxLength = 3900) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim();
  console.log(`[ИНФО] Получено сообщение от ${msg.author.tag}: ${content.slice(0, 50)}...`);
  saveToKnowledge(content);
  saveUserContext(msg.author.id, content);

  const urls = content.match(/https?:\/\/[^\s]+/g) || [];
  for (const url of urls) {
    await downloadWebsite(url);
  }

  let query = content;
  let isCommand = false;

  if (content.startsWith('!ai')) {
    query = content.slice(3).trim();
    isCommand = true;
  } else if (content.startsWith('!ds')) {
    if (!msg.guild || !isServerAllowed(msg.guild.id)) {
      console.log(`[ОШИБКА] Команда !ds недоступна на сервере ${msg.guild ? msg.guild.id : 'неизвестно'}`);
      await msg.reply(cleanResponse('Команда !ds недоступна на этом сервере'));
      return;
    }
    query = content.slice(3).trim();
    isCommand = true;
  } else if (content.startsWith('!help')) {
    await msg.reply(cleanResponse('Я могу помочь с вопросами и информацией! Используй `!ai <вопрос>` для быстрого ответа, `!ds <вопрос>` для глубокого поиска, или `!feedback <оценка 1-5> <комментарий>` для обратной связи.'));
    return;
  } else if (msg.reference) {
    try {
      const repliedMsg = await msg.channel.messages.fetch(msg.reference.messageId);
      if (repliedMsg.author.id === client.user.id) {
        query = content;
        isCommand = true;
      }
    } catch (error) {
      console.error(`[ОШИБКА] При получении ответа на сообщение: ${error.message}`);
    }
  }

  if (isCommand) {
    console.log(`[ИНФО] Запрос от ${msg.author.tag} - ${query}`);
    const context = await getUserContext(msg.author.id);
    const profile = await getUserProfile(msg.author.id);
    const sentiment = analyzeSentiment(query);
    let answer;
    let responsePrefix = responseTemplates[Math.floor(Math.random() * responseTemplates.length)];

    // Adjust response tone based on sentiment
    if (sentiment === 'negative') {
      responsePrefix = `Похоже, ты немного расстроен. Давай попробуем разобраться: `;
    } else if (sentiment === 'positive') {
      responsePrefix = `Рад твоему энтузиазму! Вот что я нашёл: `;
    }

    // Ensemble-like logic: combine QA and knowledge search
    const resultsQA = await searchQA(query);
    const resultsKnowledge = await searchKnowledge(query);
    const combinedResults = [
      ...resultsQA.map(r => ({ type: 'qa', content: r.answer, score: r.score })),
      ...resultsKnowledge.map(r => ({ type: 'knowledge', content: r.content, score: r.score }))
    ].sort((a, b) => b.score - a.score);

    if (combinedResults.length > 0) {
      answer = combinedResults[0].content;
      // Personalize based on profile
      if (profile.interaction_count > 5 && profile.preferences.topics.length > 0) {
        answer += `\n\nКстати, ты часто говоришь о ${profile.preferences.topics[0]}. Хочешь обсудить это подробнее?`;
      }
    } else {
      const wikiResult = await fetchWikipedia(query);
      answer = wikiResult !== 'Не найдено в Википедии' ? wikiResult : null;
      if (!answer) {
        answer = errorMessages[Math.floor(Math.random() * errorMessages.length)];
        answer += `\n${fallbackSuggestions[Math.floor(Math.random() * fallbackSuggestions.length)]}`;
        // Log ambiguous query for HITL review
        fs.appendFileSync(path.join(dataDir, 'hitl_review.log'), `[${new Date().toISOString()}] Неоднозначный запрос от ${msg.author.id}: ${query}\n`);
      }
    }

    console.log(`[ИНФО] Отправлен ответ для ${msg.author.tag} - ${query}: ${answer.slice(0, 50)}...`);
    const fullResponse = context.length > 0 ? `${responsePrefix}${answer}\n(Контекст: ${context.join(' | ')})` : `${responsePrefix}${answer}`;
    await msg.reply(cleanResponse(truncateResponse(fullResponse)));
  }
});

client.once('ready', () => {
  console.log(`[ИНФО] Бот запущен в режиме ответа: ${client.user.tag}`);
});

function startResponseMode() {
  client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error(`[ОШИБКА] При входе в Discord: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { startResponseMode };