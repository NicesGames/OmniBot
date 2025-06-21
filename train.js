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
let fileQueue, networkQueue, aiQueue;
const dataDir = path.join(__dirname, 'data');
const messagesDir = path.join(dataDir, 'messages');
const webCacheDir = path.join(dataDir, 'web_cache');
const tempDir = path.join(__dirname, 'temp');
const feedbackDir = path.join(dataDir, 'feedback');
const dbPath = path.join(dataDir, 'knowledge.db');

async function logError(message, error) {
  const logMessage = `[AI] ${new Date().toISOString()} ${message}: ${error.message}\n${error.stack}\n`;
  console.error(logMessage);
  try {
    await fs.appendFile(path.join(__dirname, 'error.log'), logMessage);
  } catch (fsErr) {
    console.error(`AI: Error writing to error.log: ${fsErr.message}`);
  }
}

async function initQueues() {
  try {
    const PQueueModule = await import('p-queue');
    const PQueue = PQueueModule.default;
    fileQueue = new PQueue({ concurrency: 5 });
    networkQueue = new PQueue({ concurrency: 3 });
    aiQueue = new PQueue({ concurrency: 1, interval: 20000, intervalCap: 1 });
    console.log('AI: Queues initialized successfully');
  } catch (err) {
    await logError('Error importing p-queue', err);
    process.exit(1);
  }
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error(`AI: Database connection error: ${err.message}`);
    process.exit(1);
  }
});

db.serialize(() => {
  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS knowledge USING fts5(content, tokenize="unicode61")', err => {
    if (err) console.error(`AI: Error creating knowledge table: ${err.message}`);
  });
  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS qa USING fts5(question, answer, rating INTEGER, tokenize="unicode61")', err => {
    if (err) console.error(`AI: Error creating qa table: ${err.message}`);
  });
  db.run('CREATE TABLE IF NOT EXISTS user_context (user_id TEXT, message TEXT, timestamp INTEGER, PRIMARY KEY (user_id, timestamp))', err => {
    if (err) console.error(`AI: Error creating user_context table: ${err.message}`);
  });
  db.run('CREATE TABLE IF NOT EXISTS ai_cache (input TEXT PRIMARY KEY, output TEXT)', err => {
    if (err) console.error(`AI: Error creating ai_cache table: ${err.message}`);
  });
  db.run('CREATE TABLE IF NOT EXISTS user_profiles (user_id TEXT PRIMARY KEY, preferences TEXT, interaction_count INTEGER)', err => {
    if (err) console.error(`AI: Error creating user_profiles table: ${err.message}`);
  });
  db.run('CREATE TABLE IF NOT EXISTS vocabulary (term TEXT PRIMARY KEY, frequency INTEGER, last_seen INTEGER)', err => {
    if (err) console.error(`AI: Error creating vocabulary table: ${err.message}`);
  });
  db.run('CREATE TABLE IF NOT EXISTS feedback (user_id TEXT, message_id TEXT, rating INTEGER, category TEXT, comment TEXT, timestamp INTEGER)', err => {
    if (err) console.error(`AI: Error creating feedback table: ${err.message}`);
  });
  db.run('CREATE TABLE IF NOT EXISTS synonyms (word TEXT, synonym TEXT, PRIMARY KEY (word, synonym))', err => {
    if (err) console.error(`AI: Error creating synonyms table: ${err.message}`);
  });
  db.run('CREATE INDEX IF NOT EXISTS idx_user_context ON user_context(user_id, timestamp)', err => {
    if (err) console.error(`AI: Error creating idx_user_context index: ${err.message}`);
  });
  console.log('AI: Database initialized');
});

async function initDirectories() {
  for (const dir of [dataDir, messagesDir, webCacheDir, tempDir, feedbackDir]) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`AI: Directory created: ${dir}`);
    } catch (err) {
      await logError(`Error creating directory ${dir}`, err);
    }
  }
}

async function isValidText(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = unorm.nfkd(text);
  const validCharRatio = normalized.replace(/[^a-zA-Z0-9\s.,!?@#$%^&*()_+\-=\[\]{}|;:'"<>~`\p{L}\p{N}\p{P}\p{S}]/gu, '').length / normalized.length;
  if (validCharRatio <= 0.8 || text.length < 10 || containsProfanity(text)) return false;
  try {
    const { franc } = await import('franc');
    const lang = franc(normalized, { minLength: 10 });
    return lang !== 'und';
  } catch (err) {
    await logError('Error importing franc', err);
    return true;
  }
}

function containsProfanity(content) {
  const profanity = ['хуйня', 'ебаная', 'робомать'];
  return profanity.some(word => content.toLowerCase().includes(word));
}

function normalizeText(text) {
  if (!text) return '';
  return unorm.nfkd(text).replace(/\s+/g, ' ').replace(/[\t\n\r]+/g, ' ').trim();
}

function extractKeywords(text) {
  const doc = compromise(normalizeText(text));
  return [...new Set([
    ...doc.nouns().out('array'),
    ...doc.verbs().out('array'),
    ...doc.adjectives().out('array')
  ].filter(t => t.length > 3))];
}

async function getSynonyms(word) {
  return new Promise(resolve => {
    db.all('SELECT synonym FROM synonyms WHERE word = ?', [word], (err, rows) => {
      if (err) {
        logError('Error fetching synonyms', err);
        resolve([]);
      } else {
        resolve(rows.map(row => row.synonym));
      }
    });
  });
}

async function saveUserContext(userId, message) {
  if (!await isValidText(message)) return;
  const normalized = normalizeText(message);
  const timestamp = Date.now();
  try {
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', err => {
        if (err) return reject(err);
        db.run('INSERT INTO user_context (user_id, message, timestamp) VALUES (?, ?, ?)', [userId, normalized, timestamp], err => {
          if (err) return reject(err);
          db.run('DELETE FROM user_context WHERE user_id = ? AND timestamp < ?', [userId, timestamp - 30 * 24 * 60 * 60 * 1000], err => {
            if (err) return reject(err);
            db.run('DELETE FROM user_context WHERE user_id = ? AND (SELECT COUNT(*) FROM user_context WHERE user_id = ?) > 120', [userId, userId], err => {
              if (err) return reject(err);
              db.run('COMMIT', err => {
                if (err) reject(err);
                else resolve();
              });
            });
          });
        });
      });
    });
    console.log(`AI: Saved user context for ${userId}: ${normalized.slice(0, 30)}...`);
  } catch (err) {
    await logError('Error saving user context', err);
    db.run('ROLLBACK');
  }
}

async function getUserContext(userId) {
  return new Promise(resolve => {
    db.all('SELECT message FROM user_context WHERE user_id = ? ORDER BY timestamp DESC LIMIT 5', [userId], (err, rows) => {
      if (err) {
        logError('Error fetching user context', err);
        resolve([]);
      } else {
        resolve(rows.map(row => row.message));
      }
    });
  });
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
  try {
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', err => {
          if (err) return reject(err);
          const stmt = db.prepare('INSERT INTO knowledge (content) VALUES (?)');
          for (const content of validContents) {
            stmt.run([content], err => {
              if (err) console.error(`AI: Error saving to knowledge: ${err.message}`);
            });
          }
          stmt.finalize(err => {
            if (err) return reject(err);
            db.run('COMMIT', err => {
              if (err) reject(err);
              else resolve();
            });
          });
        });
      });
    });
    console.log(`AI: Saved ${validContents.length} records from source: ${source}`);
  } catch (err) {
    await logError('Error saving to knowledge', err);
    db.run('ROLLBACK');
  }
}

async function updateUserProfile(userId, message) {
  if (!await isValidText(message)) return;
  const normalized = normalizeText(message);
  const doc = compromise(normalized);
  const preferences = JSON.stringify({
    topics: doc.topics().out('array'),
    terms: doc.terms().out('array').slice(0, 5),
    sentiment: 'neutral'
  });
  try {
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT OR REPLACE INTO user_profiles (user_id, preferences, interaction_count) VALUES (?, ?, COALESCE((SELECT interaction_count + 1 FROM user_profiles WHERE user_id = ?), 1))',
        [userId, preferences, userId],
        err => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    console.log(`AI: Updated profile for user ${userId}`);
  } catch (err) {
    await logError('Error updating user profile', err);
  }
}

async function updateVocabulary(message) {
  if (!await isValidText(message)) return;
  const normalized = normalizeText(message);
  const doc = compromise(normalized);
  const terms = doc.terms().out('array').filter(t => t.length > 3);
  const timestamp = Date.now();
  try {
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', err => {
        if (err) return reject(err);
        const stmt = db.prepare('INSERT OR REPLACE INTO vocabulary (term, frequency, last_seen) VALUES (?, COALESCE((SELECT frequency + 1 FROM vocabulary WHERE term = ?), 1), ?)');
        for (const term of terms) {
          stmt.run([term, term, timestamp]);
        }
        stmt.finalize(err => {
          if (err) return reject(err);
          db.run('COMMIT', err => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    });
    console.log(`AI: Updated vocabulary for message: ${normalized.slice(0, 30)}...`);
  } catch (err) {
    await logError('Error updating vocabulary', err);
    db.run('ROLLBACK');
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
      console.log(`AI: Bias warning: "${term}" (${freq})`);
      await fs.appendFile(path.join(dataDir, 'bias_audit.log'), `[${new Date().toISOString()}] "${term}" (${freq})\n`);
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
    if (sentences[i].endsWith('?') && !doc.sentences().eq(i).has('#Rhetorical') && await isValidText(sentences[i]) && await isValidText(sentences[i + 1])) {
      qaPairs.push([sentences[i].trim(), sentences[i + 1].trim(), 0]);
    }
  }
  if (!qaPairs.length) return;
  try {
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', err => {
        if (err) return reject(err);
        const stmt = db.prepare('INSERT INTO qa (question, answer, rating) VALUES (?, ?, ?)');
        for (const [question, answer, rating] of qaPairs) {
          stmt.run([question, answer, rating], err => {
            if (err) console.error(`AI: Error saving QA pair: ${err.message}`);
          });
        }
        stmt.finalize(err => {
          if (err) return reject(err);
          db.run('COMMIT', err => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    });
    for (const [question] of qaPairs) {
      console.log(`AI: Saved QA pair from ${source}: Q: ${question.slice(0, 30)}...`);
    }
  } catch (err) {
    await logError('Error saving QA pair', err);
    db.run('ROLLBACK');
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
              text: `Extract question-answer pairs. Format: Q: question\nA: answer\n\nText: ${normalized.slice(0, 4000)}`
            }]
          }]
        });
      const output = response.data.candidates[0].content.parts[0].text;
      db.run('INSERT INTO ai_cache (input, output) VALUES (?, ?)', [normalized, output]);
      processGeminiOutput(output, source);
    } catch (error) {
      await logError(`AI processing (${source})`, error);
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
        qaPairs.push([question, answer, 0]);
      }
      question = null;
    }
  }
  if (!qaPairs.length) return;
  try {
    db.run('BEGIN TRANSACTION', err => {
      if (err) throw err;
      const stmt = db.prepare('INSERT INTO qa (question, answer, rating) VALUES (?, ?, ?)');
      for (const [question, answer, rating] of qaPairs) {
        stmt.run([question, answer, rating]);
        console.log(`AI: Saved Gemini QA pair from ${source}: Q: ${question.slice(0, 30)}...`);
      }
      stmt.finalize();
      db.run('COMMIT');
    });
  } catch (err) {
    logError('Error saving Gemini QA pair', err);
    db.run('ROLLBACK');
  }
}

async function fetchWikipedia(query) {
  try {
    const keywords = extractKeywords(query);
    const response = await networkQueue.add(() => axios.get('https://ru.wikipedia.org/w/api.php', {
      params: { action: 'query', format: 'json', titles: keywords.join('|'), prop: 'extracts', exintro: true, explaintext: true }
    }));
    const page = Object.values(response.data.query.pages)[0];
    if (page.extract) {
      const normalized = normalizeText(page.extract);
      if (await isValidText(normalized)) {
        await saveToKnowledge(normalized, 'Wikipedia');
        await auditDataForBias(normalized);
        await extractQA(normalized, 'Wikipedia');
        if (useAI) await processWithAI(normalized, 'Wikipedia');
        console.log(`AI: Fetched data from Wikipedia for query: ${query.slice(0, 30)}...`);
        return normalized.slice(0, 500) + '...';
      }
    }
    return 'Not found on Wikipedia';
  } catch (error) {
    await logError('Fetching Wikipedia data', error);
    return 'Error searching Wikipedia';
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
      console.log(`AI: Processed website: ${siteUrl}`);
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
            await saveToKnowledge(imageInfo, `Image from website: ${resource.url}`);
            await auditDataForBias(imageInfo);
            await updateVocabulary(imageInfo);
            console.log(`AI: Processed image: ${resource.url}`);
          }
        } else if (buffer.length > 100) {
          try {
            const content = iconv.decode(buffer, 'utf-8');
            if (await isValidText(content)) {
              await saveToKnowledge(content, `Website resource: ${resource.url}`);
              await auditDataForBias(content);
              await extractQA(content, `Website resource: ${resource.url}`);
              await updateVocabulary(content);
              if (useAI) await processWithAI(content, `Website resource: ${resource.url}`);
              console.log(`AI: Processed resource: ${resource.url}`);
            }
          } catch (err) {}
        }
      } catch (error) {
        await logError(`Resource ${resource.url}`, error);
      }
    })));
  } catch (error) {
    await logError(`Website ${siteUrl}`, error);
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
    } else if (['.css', '.js', '.py', '.java'].includes(ext)) {
      text = await fs.readFile(filePath, 'utf-8');
    } else if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp'].includes(ext)) {
      const metadata = await sharp(filePath).metadata();
      text = `Image: ${path.basename(filePath)}, Format: ${metadata.format}, Size: ${metadata.width}x${metadata.height}`;
    } else {
      return;
    }
    const normalized = normalizeText(text);
    if (await isValidText(normalized)) {
      console.log(`AI: Processing file: ${filePath}, content: ${normalized.slice(0, 30)}...`);
      await saveToKnowledge(normalized, `File: ${filePath}`);
      await auditDataForBias(normalized);
      await extractQA(normalized, `File: ${filePath}`);
      await updateVocabulary(normalized);
      if (useAI) await processWithAI(normalized, `File: ${filePath}`);
    }
  } catch (err) {
    await logError(`File ${filePath}`, err);
  }
}

async function processDirectory(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(entry => fileQueue.add(async () => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await processDirectory(fullPath);
      } else if (entry.isFile()) {
        await processFile(fullPath);
      }
    })));
    console.log(`AI: Processed directory: ${dir}`);
  } catch (err) {
    await logError(`Error processing directory ${dir}`, err);
  }
}

async function processFilesInMessagesFolder() {
  await processDirectory(messagesDir);
  console.log('AI: Files in messages folder processed');
}

async function fetchChannelHistory(client) {
  const guilds = client.guilds.cache;
  for (const guild of guilds.values()) {
    const channels = guild.channels.cache.filter(ch => ch.isTextBased());
    for (const channel of channels.values()) {
      if (!channel.permissionsFor(client.user).has(['ViewChannel', 'ReadMessageHistory'])) {
        console.log(`AI: Skipped channel ${channel.name}: missing permissions`);
        continue;
      }
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
              console.log(`AI: Processing message from ${message.author.tag} in channel ${channel.name}: ${normalized.slice(0, 30)}...`);
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
        await logError(`Channel ${channel.name}`, error);
      }
    }
  }
  console.log('AI: Channel history scanning completed');
}

async function searchAnswer(query, userId) {
  try {
    const keywords = extractKeywords(query);
    const context = await getUserContext(userId);
    const contextKeywords = context.flatMap(extractKeywords);
    const allKeywords = [...new Set([...keywords, ...contextKeywords])];
    const synonyms = await Promise.all(allKeywords.map(getSynonyms));
    const searchTerms = [...new Set([...allKeywords, ...synonyms.flat()])].join(' OR ');
    return await new Promise(resolve => {
      db.all('SELECT question, answer, rating FROM qa WHERE question MATCH ? OR answer MATCH ? ORDER BY rating DESC LIMIT 1', [searchTerms, searchTerms], (err, rows) => {
        if (err) {
          logError('Answer search error', err);
          resolve('');
        } else if (rows.length) {
          let { answer } = rows[0];
          answer = normalizeText(answer).slice(0, 1900);
          if (answer) {
            console.log(`AI: Found answer for query ${query.slice(0, 30)}...: ${answer.slice(0, 30)}...`);
            resolve(answer);
          } else {
            resolve('');
          }
        } else {
          resolve('');
        }
      });
    });
  } catch (err) {
    await logError('Error searching answer', err);
    return '';
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  try {
    const content = normalizeText(message.content);
    if (await isValidText(content)) {
      console.log(`AI: Processing message from ${message.author.tag}: ${content.slice(0, 30)}...`);
      await saveToKnowledge(content, `Discord: ${message.channel.name}`);
      await auditDataForBias(content);
      await saveUserContext(message.author.id, content);
      await updateUserProfile(message.author.id, content);
      await updateVocabulary(content);
      await extractQA(content, `Discord: ${message.channel.name}`);
      if (useAI) await processWithAI(content, `Discord: ${message.channel.name}`);
    }

    if (content.toLowerCase().startsWith('!ai')) {
      const query = content.slice(3).trim();
      if (!query) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('Error')
          .setDescription('Please specify a query after `!ai`, e.g., `!ai what is AI?`')
          .setTimestamp();
        if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
          await message.reply({ embeds: [embed] });
        } else {
          console.log(`AI: Cannot respond in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
        }
        return;
      }
      console.log(`AI: Query from ${message.author.tag}: ${query}`);
      const answer = await searchAnswer(query, message.author.id);
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Answer')
        .setDescription(answer || 'No suitable answer found. Please clarify your question!')
        .setTimestamp();
      if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
        await message.reply({ embeds: [embed] });
        console.log(`AI: Sent answer to ${message.author.tag}: ${answer.slice(0, 30)}...`);
      } else {
        console.log(`AI: Cannot respond in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
      }
    }

    if (message.reference && message.reference.messageId) {
      try {
        const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
        if (referencedMessage.author.id !== client.user.id) return;
        const parts = content.trim().split(/\s+/);
        const rating = parseInt(parts[0]);
        const comment = parts.slice(1).join(' ').trim();
        if (isNaN(rating) || rating < 1 || rating > 5) {
          const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Feedback Error')
            .setDescription('Please provide a rating from 1 to 5 and a comment. E.g., `4 Great bot!`')
            .setTimestamp();
          if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
            await message.reply({ embeds: [embed] });
          } else {
            console.log(`AI: Cannot respond in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
          }
          return;
        }
        if (!comment || comment.length < 5) {
          const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Feedback Error')
            .setDescription('Comment must be at least 5 characters long.')
            .setTimestamp();
          if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
            await message.reply({ embeds: [embed] });
          } else {
            console.log(`AI: Cannot respond in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
          }
          return;
        }
        await new Promise((resolve, reject) => {
          db.run(
            'INSERT INTO feedback (user_id, message_id, rating, category, comment, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
            [message.author.id, message.id, rating, 'other', comment, Date.now()],
            err => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('Feedback Received')
          .setDescription(`Thank you for your feedback!\n**Rating**: ${rating}/5\n**Comment**: ${comment.slice(0, 100)}${comment.length > 100 ? '...' : ''}`)
          .setFooter({ text: 'Your feedback helps improve the bot!' })
          .setTimestamp();
        if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
          await message.reply({ embeds: [embed] });
          console.log(`AI: Feedback from ${message.author.tag}: ${rating}, ${comment}`);
        } else {
          console.log(`AI: Cannot process feedback in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
        }
      } catch (err) {
        await logError('Feedback processing error', err);
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('Error')
          .setDescription('Failed to process feedback. Please try again.')
          .setTimestamp();
        if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
          await message.reply({ embeds: [embed] });
        } else {
          console.log(`AI: Cannot respond in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
        }
      }
    }

    const urls = message.content.match(/https?:\/\/[^\s]+/g) || [];
    await Promise.all(urls.map(url => downloadWebsite(url)));
  } catch (err) {
    await logError('Message processing error', err);
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Error')
      .setDescription('An error occurred while processing the message. Please try again.')
      .setTimestamp();
    if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
      await message.reply({ embeds: [embed] });
    } else {
      console.log(`AI: Cannot respond in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
    }
  }
});

client.on('rateLimit', (info) => {
  console.log(`AI: Discord API rate limit: ${JSON.stringify(info)}`);
});

client.once('ready', async () => {
  console.log(`AI: Bot started: ${client.user.tag}`);
  await initQueues();
  await initDirectories();
  await fetchChannelHistory(client);
  await processFilesInMessagesFolder();
  setInterval(async () => {
    try {
      await fetchChannelHistory(client);
      await processFilesInMessagesFolder();
      console.log('AI: Periodic training completed');
    } catch (error) {
      await logError('Periodic training error', error);
    }
  }, 6 * 60 * 60 * 1000);
});

function startTrainingMode(useAIParam) {
  useAI = useAIParam;
  console.log(`AI: Starting training mode${useAIParam ? ' with AI' : ''}`);
  client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error(`AI: Discord login error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { startTrainingMode, fetchWikipedia, processFilesInMessagesFolder, downloadWebsite, searchAnswer };