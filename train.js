const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const compromise = require('compromise');
const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const iconv = require('iconv-lite');
const sharp = require('sharp');
const unorm = require('unorm');

dotenv.config();

let useAI = false;
const PQueue = require('p-queue');
const fileQueue = new PQueue({ concurrency: 5 });
const networkQueue = new PQueue({ concurrency: 3 });
const aiQueue = new PQueue({ concurrency: 1, interval: 20000, intervalCap: 1 });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const dataDir = path.join(__dirname, 'data');
const messagesDir = path.join(dataDir, 'messages');
const webCacheDir = path.join(dataDir, 'web_cache');
const tempDir = path.join(__dirname, 'temp');
const feedbackDir = path.join(dataDir, 'feedback');

const dbPath = path.join(dataDir, 'knowledge.db');
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS knowledge USING fts5(content)');
  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS qa USING fts5(question, answer)');
  db.run('CREATE TABLE IF NOT EXISTS user_context (user_id TEXT, message TEXT, timestamp INTEGER)');
  db.run('CREATE TABLE IF NOT EXISTS ai_cache (input TEXT PRIMARY KEY, output TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS user_profiles (user_id TEXT PRIMARY KEY, preferences TEXT, interaction_count INTEGER)');
  db.run('CREATE TABLE IF NOT EXISTS vocabulary (term TEXT PRIMARY KEY, frequency INTEGER, last_seen INTEGER)');
  db.run('CREATE TABLE IF NOT EXISTS feedback (user_id TEXT, message_id TEXT, rating INTEGER, category TEXT, comment TEXT, timestamp INTEGER)');
});

async function initDirectories() {
  for (const dir of [dataDir, messagesDir, webCacheDir, tempDir, feedbackDir]) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      console.error(`[ОШИБКА] Создание директории ${dir}: ${err.message}`);
    }
  }
}

function containsProfanity(content) {
  const profanity = ['хуйня', 'ебаная', 'робомать'];
  return profanity.some(word => content.toLowerCase().includes(word));
}

async function isValidText(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = unorm.nfkd(text);
  const validCharRatio = normalized.replace(/[^a-zA-Z0-9\s.,!?@#$%^&*()_+\-=\[\]{}|;:'"<>~`\p{L}\p{N}\p{P}\p{S}]/gu, '').length / normalized.length;
  if (validCharRatio <= 0.8 || text.length < 10 || containsProfanity(text)) return false;
  try {
    const francModule = await import('franc');
    const franc = francModule.default;
    const lang = franc(text, { minLength: 10 });
    return lang !== 'und';
  } catch (err) {
    console.error(`[ОШИБКА] Импорт franc: ${err.message}`);
    return false;
  }
}

function normalizeText(text) {
  if (!text) return '';
  return unorm.nfkd(text).replace(/\s+/g, ' ').trim();
}

async function saveToKnowledge(contents, source = 'unknown') {
  if (!Array.isArray(contents)) contents = [contents];
  const validContents = [];
  for (const c of contents) {
    if (await isValidText(c)) {
      validContents.push(normalizeText(c));
    }
  }
  if (!validContents.length) return;
  
  db.run('BEGIN TRANSACTION');
  try {
    for (const content of validContents) {
      db.run('INSERT INTO knowledge (content) VALUES (?)', [content], (err) => {
        if (err) console.error(`[ОШИБКА] При сохранении в knowledge: ${err.message}`);
      });
    }
    db.run('COMMIT');
    console.log(`[ИНФО] Сохранено ${validContents.length} записей из ${source}`);
  } catch (err) {
    db.run('ROLLBACK');
    console.error(`[ОШИБКА] Транзакция knowledge: ${err.message}`);
  }
}

async function saveUserContext(userId, message) {
  if (!await isValidText(message)) return;
  const normalized = normalizeText(message);
  const timestamp = Date.now();
  db.run('BEGIN TRANSACTION');
  try {
    db.run('INSERT INTO user_context (user_id, message, timestamp) VALUES (?, ?, ?)', [userId, normalized, timestamp]);
    db.run('DELETE FROM user_context WHERE user_id = ? AND timestamp < ?', [userId, timestamp - 30 * 24 * 60 * 60 * 1000]);
    db.run('DELETE FROM user_context WHERE user_id = ? AND (SELECT COUNT(*) FROM user_context WHERE user_id = ?) > 120', [userId, userId]);
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    console.error(`[ОШИБКА] Транзакция user_context: ${err.message}`);
  }
}

async function updateUserProfile(userId, message) {
  if (!await isValidText(message)) return;
  const normalized = normalizeText(message);
  const doc = compromise(normalized);
  const preferences = JSON.stringify({
    topics: doc.topics().out('array'),
    terms: doc.terms().out('array').slice(0, 5)
  });
  db.run(
    'INSERT OR REPLACE INTO user_profiles (user_id, preferences, interaction_count) VALUES (?, ?, COALESCE((SELECT interaction_count + 1 FROM user_profiles WHERE user_id = ?), 1))',
    [userId, preferences, userId],
    (err) => {
      if (err) console.error(`[ОШИБКА] При обновлении user_profiles: ${err.message}`);
    }
  );
}

async function updateVocabulary(message) {
  if (!await isValidText(message)) return;
  const normalized = normalizeText(message);
  const doc = compromise(normalized);
  const terms = doc.terms().out('array').filter(t => t.length > 3);
  const timestamp = Date.now();
  db.run('BEGIN TRANSACTION');
  try {
    for (const term of terms) {
      db.run(
        'INSERT OR REPLACE INTO vocabulary (term, frequency, last_seen) VALUES (?, COALESCE((SELECT frequency + 1 FROM vocabulary WHERE term = ?), 1), ?)',
        [term, term, timestamp]
      );
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    console.error(`[ОШИБКА] Транзакция vocabulary: ${err.message}`);
  }
}

async function auditDataForBias(content) {
  if (!await isValidText(content)) return;
  const normalized = normalizeText(content);
  const doc = compromise(normalized);
  const terms = doc.terms().out('array');
  const termFreq = {};
  terms.forEach(t => termFreq[t] = (termFreq[t] || 0) + 1);
  for (const [term, freq] of Object.entries(termFreq)) {
    if (freq > 100) {
      console.log(`[ПРЕДУПРЕЖДЕНИЕ] Потенциальная предвзятость: "${term}" (${freq})`);
      fs.appendFile(path.join(dataDir, 'bias_audit.log'), `[${new Date().toISOString()}] "${term}" (${freq})\n`).catch(err => console.error(err.message));
    }
  }
}

async function extractQA(text, source = 'unknown') {
  if (!await isValidText(text)) return;
  const normalized = normalizeText(text);
  const doc = compromise(normalized);
  const sentences = doc.sentences().out('array');
  const qaPairs = [];
  for (let i = 0; i < sentences.length - 1; i++) {
    if (sentences[i].endsWith('?') && await isValidText(sentences[i]) && await isValidText(sentences[i + 1])) {
      qaPairs.push([sentences[i].trim(), sentences[i + 1].trim()]);
    }
  }
  if (!qaPairs.length) return;
  db.run('BEGIN TRANSACTION');
  try {
    for (const [question, answer] of qaPairs) {
      db.run('INSERT INTO qa (question, answer) VALUES (?, ?)', [question, answer]);
      console.log(`[ИНФО] Сохранена пара из ${source} В: ${question.slice(0, 30)}... О: ${answer.slice(0, 30)}...`);
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    console.error(`[ОШИБКА] Транзакция qa: ${err.message}`);
  }
}

async function processWithAI(text, source = 'unknown') {
  if (!process.env.GEMINI_API_KEY || !await isValidText(text) || !text.includes('?')) return;
  const normalized = normalizeText(text);
  const cacheResult = await new Promise(resolve => db.get('SELECT output FROM ai_cache WHERE input = ?', [normalized], (err, row) => resolve(row)));
  if (cacheResult) {
    processGeminiOutput(cacheResult.output, source);
    return;
  }
  if (aiQueue.size > 100) return;
  await aiQueue.add(async () => {
    try {
      const response = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
        {
          contents: [{
            parts: [{
              text: `Извлеки пары вопрос-ответ. Формат: Q: вопрос\nA: ответ. Текст: ${normalized.slice(0, 4000)}`
            }]
          }]
        }
      );
      const output = response.data.candidates[0].content.parts[0].text;
      db.run('INSERT INTO ai_cache (input, output) VALUES (?, ?)', [normalized, output]);
      processGeminiOutput(output, source);
    } catch (error) {
      console.error(`[ОШИБКА] ИИ (${source}): ${error.message}`);
    }
  });
}

function processGeminiOutput(output, source = 'unknown') {
  if (!output) return;
  const normalized = normalizeText(output);
  const lines = normalized.split('\n');
  const qaPairs = [];
  let question = null;
  for (const line of lines) {
    if (line.startsWith('Q: ')) {
      question = line.slice(3).trim();
    } else if (line.startsWith('A: ') && question) {
      const answer = line.slice(3).trim();
      if (question && answer) {
        qaPairs.push([question, answer]);
      }
      question = null;
    }
  }
  if (!qaPairs.length) return;
  db.run('BEGIN TRANSACTION');
  try {
    for (const [question, answer] of qaPairs) {
      db.run('INSERT INTO qa (question, answer) VALUES (?, ?)', [question, answer]);
      console.log(`[ИНФО] Сохранена пара из Gemini (${source}) В: ${question.slice(0, 30)}... О: ${answer.slice(0, 30)}...`);
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    console.error(`[ОШИБКА] Транзакция Gemini qa: ${err.message}`);
  }
}

async function fetchWikipedia(query) {
  try {
    const response = await networkQueue.add(() => axios.get('https://ru.wikipedia.org/w/api.php', {
      params: { action: 'query', format: 'json', titles: query, prop: 'extracts', exintro: true, explaintext: true }
    }));
    const page = Object.values(response.data.query.pages)[0];
    if (page.extract) {
      const normalized = normalizeText(page.extract);
      if (await isValidText(normalized)) {
        await saveToKnowledge(normalized, 'Wikipedia');
        await auditDataForBias(normalized);
        await extractQA(normalized, 'Wikipedia');
        if (useAI) await processWithAI(normalized, 'Wikipedia');
        return normalized.slice(0, 500) + '...';
      }
    }
    return 'Не найдено в Википедии';
  } catch (error) {
    console.error(`[ОШИБКА] Википедия: ${error.message}`);
    return 'Ошибка поиска в Википедии';
  }
}

async function downloadWebsite(siteUrl) {
  if (/youtube\.com|cdn\.discordapp\.com|tenor\.com|discord\.com|discord\.gg/.test(siteUrl)) return;
  if (/bit\.ly|tinyurl|t\.co|goo\.gl|ow\.ly/.test(siteUrl)) return;
  try {
    const response = await networkQueue.add(() => fetch(siteUrl));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const urlObj = new URL(siteUrl);
    const folderName = `${urlObj.hostname}${urlObj.pathname}`.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 100);
    const saveDir = path.join(webCacheDir, folderName);
    await fs.mkdir(saveDir, { recursive: true });
    let counter = 1;
    let htmlPath = path.join(saveDir, 'index.html');
    while (await fs.access(htmlPath).then(() => true).catch(() => false)) {
      htmlPath = path.join(saveDir, `index_${counter++}.html`);
    }
    await fs.writeFile(htmlPath, html);
    const $ = cheerio.load(html);
    const bodyText = normalizeText($('body').text());
    if (await isValidText(bodyText)) {
      await saveToKnowledge(bodyText, `Website: ${siteUrl}`);
      await auditDataForBias(bodyText);
      await extractQA(bodyText, `Website: ${siteUrl}`);
      await updateVocabulary(bodyText);
      if (useAI) await processWithAI(bodyText, `Website: ${siteUrl}`);
    }
    const resources = [];
    $('script[src]').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src && src.endsWith('.js')) resources.push({ url: new URL(src, siteUrl).href, type: 'js' });
    });
    $('link[rel="stylesheet"]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && href.endsWith('.css')) resources.push({ url: new URL(href, siteUrl).href, type: 'css' });
    });
    $('img[src]').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src && /\.(jpg|jpeg|png|gif|svg|webp)$/i.test(src)) resources.push({ url: new URL(src, siteUrl).href, type: 'image' });
    });
    await Promise.all(resources.map(resource => networkQueue.add(async () => {
      try {
        const resResponse = await fetch(resource.url);
        if (!resResponse.ok) return;
        const buffer = Buffer.from(await resResponse.arrayBuffer());
        const resFilename = resource.url.split('/').pop();
        let resPath = path.join(saveDir, resFilename);
        let resCounter = 1;
        while (await fs.access(resPath).then(() => true).catch(() => false)) {
          const ext = path.extname(resFilename);
          const name = path.basename(resFilename, ext);
          resPath = path.join(saveDir, `${name}_${resCounter++}${ext}`);
        }
        await fs.writeFile(resPath, buffer);
        if (resource.type === 'image') {
          const metadata = await sharp(buffer).metadata();
          const imageInfo = normalizeText(`Image: ${resFilename}, Format: ${metadata.format}, Size: ${metadata.width}x${metadata.height}`);
          if (await isValidText(imageInfo)) {
            await saveToKnowledge(imageInfo, `Website Image: ${resource.url}`);
            await auditDataForBias(imageInfo);
            await updateVocabulary(imageInfo);
          }
        } else if (buffer.length > 100) {
          try {
            const content = iconv.decode(buffer, 'utf-8');
            if (await isValidText(content)) {
              await saveToKnowledge(content, `Website Resource: ${resource.url}`);
              await auditDataForBias(content);
              await extractQA(content, `Website Resource: ${resource.url}`);
              await updateVocabulary(content);
              if (useAI) await processWithAI(content, `Website Resource: ${resource.url}`);
            }
          } catch (err) {}
        }
      } catch (error) {
        console.error(`[ОШИБКА] Ресурс ${resource.url}: ${error.message}`);
      }
    })));
  } catch (error) {
    console.error(`[ОШИБКА] Сайт ${siteUrl}: ${error.message}`);
    await fs.appendFile(path.join(__dirname, 'error.log'), `[${new Date().toISOString()}] ${siteUrl}: ${error.message}\n`);
  }
}

async function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  try {
    if (ext === '.txt') {
      const buffer = await fs.readFile(filePath);
      text = iconv.decode(buffer, 'utf-8');
    } else if (ext === '.pdf') {
      const buffer = await fs.readFile(filePath);
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (ext === '.docx') {
      const buffer = await fs.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === '.html') {
      const html = await fs.readFile(filePath, 'utf-8');
      const $ = cheerio.load(html);
      text = $('body').text();
    } else if (ext === '.json') {
      const json = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      text = JSON.stringify(json, null, 2);
    } else if (['.css', '.py', '.js', '.java'].includes(ext)) {
      text = await fs.readFile(filePath, 'utf-8');
    } else if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp'].includes(ext)) {
      const metadata = await sharp(filePath).metadata();
      text = `Image: ${path.basename(filePath)}, Format: ${metadata.format}, Size: ${metadata.width}x${metadata.height}`;
    } else {
      return;
    }
    const normalized = normalizeText(text);
    if (await isValidText(normalized)) {
      await saveToKnowledge(normalized, `File: ${filePath}`);
      await auditDataForBias(normalized);
      await extractQA(normalized, `File: ${filePath}`);
      await updateVocabulary(normalized);
      if (useAI) await processWithAI(normalized, `File: ${filePath}`);
    }
  } catch (err) {
    console.error(`[ОШИБКА] Файл ${filePath}: ${err.message}`);
  }
}

async function processDirectory(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(entry => fileQueue.add(async () => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await processDirectory(fullPath);
    } else if (entry.isFile()) {
      await processFile(fullPath);
    }
  })));
}

async function processFilesInMessagesFolder() {
  await processDirectory(messagesDir);
  console.log('[ИНФО] Обработка файлов в data/messages завершена');
}

async function fetchChannelHistory(client) {
  const guilds = client.guilds.cache;
  for (const guild of guilds.values()) {
    const channels = guild.channels.cache.filter(channel => channel.isTextBased());
    for (const channel of channels.values()) {
      if (!channel.permissionsFor(client.user).has(['ViewChannel', 'ReadMessageHistory'])) continue;
      try {
        let lastId;
        let totalFetched = 0;
        const maxMessages = 1000;
        while (totalFetched < maxMessages) {
          const messages = await channel.messages.fetch({ limit: 100, before: lastId });
          if (messages.size === 0) break;
          const contents = [];
          for (const message of messages.values()) {
            if (!message.author.bot && await isValidText(message.content)) {
              const normalized = normalizeText(message.content);
              contents.push(normalized);
              await saveUserContext(message.author.id, normalized);
              await updateUserProfile(message.author.id, normalized);
              await updateVocabulary(normalized);
              await extractQA(normalized, `Discord: ${channel.name}`);
              if (useAI) await processWithAI(normalized, `Discord: ${channel.name}`);
              const urls = message.content.match(/https?:\/\/[^\s]+/g) || [];
              await Promise.all(urls.map(url => downloadWebsite(url)));
            }
            totalFetched++;
          }
          await saveToKnowledge(contents, `Discord: ${channel.name}`);
          if (messages.size < 100 || totalFetched >= maxMessages) break;
          lastId = messages.last().id;
        }
      } catch (error) {
        console.error(`[ОШИБКА] Канал ${channel.name}: ${error.message}`);
      }
    }
  }
  console.log('[ИНФО] Сканирование истории завершено');
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = normalizeText(message.content);
  if (await isValidText(content)) {
    await saveToKnowledge(content, `Discord: ${message.channel.name}`);
    await auditDataForBias(content);
    await saveUserContext(message.author.id, content);
    await updateUserProfile(message.author.id, content);
    await updateVocabulary(content);
    await extractQA(content, `Discord: ${message.channel.name}`);
    if (useAI) await processWithAI(content, `Discord: ${message.channel.name}`);
  }

  if (content.toLowerCase().startsWith('!feedback')) {
    const feedbackText = normalizeText(content.slice(9).trim());
    const args = feedbackText.split(/\s+/);
    const rating = parseInt(args[0]);
    const validCategories = ['speed', 'accuracy', 'interface', 'other'];
    const category = args[1]?.toLowerCase();
    const comment = args.slice(category && validCategories.includes(category) ? 2 : 1).join(' ').trim();

    if (isNaN(rating) || rating < 1 || rating > 5) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('Ошибка в отзыве')
        .setDescription('Пожалуйста, укажите оценку от 1 до 5. Формат:\n`!feedback <оценка> [категория] <комментарий>`\nПример: `!feedback 4 speed Бот отвечает быстро.`')
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    }

    if (!validCategories.includes(category)) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('Ошибка в отзыве')
        .setDescription(`Категория должна быть одной из: ${validCategories.join(', ')}. Формат:\n\`!feedback <оценка> [категория] <комментарий>\`\nПример: \`!feedback 4 speed Бот отвечает быстро.\``)
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    }

    if (!comment || comment.length < 5) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('Ошибка в отзыве')
        .setDescription('Комментарий должен содержать не менее 5 символов. Формат:\n`!feedback <оценка> [категория] <комментарий>`\nПример: `!feedback 4 speed Бот отвечает быстро.`')
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    }

    db.run(
      'INSERT INTO feedback (user_id, message_id, rating, category, comment, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      [message.author.id, message.id, rating, category || 'other', comment, Date.now()],
      (err) => {
        if (err) {
          console.error(`[ОШИБКА] Сохранение отзыва: ${err.message}`);
          const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Ошибка')
            .setDescription('Не удалось сохранить отзыв. Попробуйте позже.')
            .setTimestamp();
          message.reply({ embeds: [embed] });
        } else {
          const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('Отзыв принят')
            .setDescription(`Спасибо за ваш отзыв!\n**Оценка**: ${rating}/5\n**Категория**: ${category || 'other'}\n**Комментарий**: ${comment.slice(0, 100)}${comment.length > 100 ? '...' : ''}`)
            .setFooter({ text: 'Ваш отзыв помогает улучшать бота!' })
            .setTimestamp();
          message.reply({ embeds: [embed] });
          console.log(`[ИНФО] Отзыв от ${message.author.tag}: ${rating}, ${category || 'other'}, ${comment}`);
        }
      }
    );
  }

  const urls = message.content.match(/https?:\/\/[^\s]+/g) || [];
  await Promise.all(urls.map(url => downloadWebsite(url)));
});

client.on('rateLimit', (info) => {
  console.log(`[ПРЕДУПРЕЖДЕНИЕ] Ограничение API Discord: ${JSON.stringify(info)}`);
});

client.once('ready', async () => {
  console.log(`[ИНФО] Бот запущен: ${client.user.tag}`);
  await initDirectories();
  await fetchChannelHistory(client);
  await processFilesInMessagesFolder();
  setInterval(async () => {
    try {
      await fetchChannelHistory(client);
      await processFilesInMessagesFolder();
    } catch (error) {
      console.error(`[ОШИБКА] Периодическое обучение: ${error.message}`);
    }
  }, 6 * 60 * 60 * 1000);
});

function startTrainingMode(useAIParam) {
  useAI = useAIParam;
  client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error(`[ОШИБКА] Вход в Discord: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { startTrainingMode, fetchWikipedia, processFilesInMessagesFolder, downloadWebsite };