// Required dependencies
require('dotenv').config();
const Discord = require('discord.js');
const { REST, Routes } = require('discord.js');
const brain = require('brain.js');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const franc = require('franc');
const PDFParser = require('pdf-parse');
const { parse } = require('node-html-parser');
const stopwords = require('stopword');
const heapdump = require('heapdump');

// Initialize Discord client
const client = new Discord.Client({
  intents: [
    Discord.IntentsBitField.Flags.Guilds,
    Discord.IntentsBitField.Flags.GuildMessages,
    Discord.IntentsBitField.Flags.MessageContent,
  ],
});

// Initialize LSTM neural network
const net = new brain.recurrent.LSTM();
const trainingData = [];
const modelPath = path.join(__dirname, 'data', 'model.json');
const cachePath = path.join(__dirname, 'data', 'cache.json');
const configPath = path.join(__dirname, 'data', 'config.json');
let config = { aiChannels: {}, maxMemoryMB: 2048 };
let responseCount = 0;
let epochCounter = 1;

// Forbidden domains for web search
const forbiddenDomains = ['tenor.com', 'discord.gg', 'discord.com', 'cdn.discordapp.com', 'cdn.discord.com'];

// Ensure data directory exists
async function ensureDataDirectory() {
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
  } catch (error) {
    console.error('Ошибка создания папки data:', error);
  }
}

// Monitor memory usage
function checkMemoryUsage() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  if (used > config.maxMemoryMB) {
    console.error(`ПРЕДУПРЕЖДЕНИЕ: Использование памяти (${used.toFixed(2)} МБ) превышает лимит (${config.maxMemoryMB} МБ)`);
    heapdump.writeHeapSnapshot();
    global.gc && global.gc();
  }
}

// Load saved neural network model
async function loadModel() {
  try {
    const modelData = await fs.readFile(modelPath, 'utf8');
    if (modelData.trim() === '') {
      console.log('Файл model.json пуст, используется новая нейронная сеть');
      return;
    }
    net.fromJSON(JSON.parse(modelData));
    console.log('Модель загружена из data/model.json');
  } catch (error) {
    console.log('Модель не найдена или повреждена, используется новая нейронная сеть:', error.message);
  }
}

// Save neural network model
async function saveModel() {
  try {
    const modelJSON = net.toJSON();
    if (!modelJSON || Object.keys(modelJSON).length === 0) {
      console.warn('Модель пуста, пропуск сохранения');
      return;
    }
    let existingModel = {};
    try {
      const existingData = await fs.readFile(modelPath, 'utf8');
      existingModel = JSON.parse(existingData);
    } catch (error) {
      console.log('Нет существующей модели для сравнения');
    }
    if (JSON.stringify(modelJSON) !== JSON.stringify(existingModel)) {
      await fs.writeFile(modelPath, JSON.stringify(modelJSON, null, 2));
      console.log(`Модель сохранена в data/model.json (размер: ${JSON.stringify(modelJSON).length} байт)`);
    } else {
      console.log('Модель не изменилась, пропуск сохранения');
    }
  } catch (error) {
    console.error('Ошибка сохранения модели:', error);
  }
}

// Load cached data
async function loadCache() {
  try {
    const cacheData = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(cacheData);
  } catch (error) {
    return {};
  }
}

// Save cached data
async function saveCache(cache) {
  try {
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.error('Ошибка сохранения кэша:', error);
  }
}

// Load configuration
async function loadConfig() {
  try {
    const data = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(data);
    if (!config.aiChannels) config.aiChannels = {};
    if (!config.maxMemoryMB) config.maxMemoryMB = 2048;
    console.log('Конфигурация загружена из data/config.json');
  } catch (error) {
    await saveConfig();
  }
}

// Save configuration
async function saveConfig() {
  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Ошибка сохранения конфигурации:', error);
  }
}

// Tokenize text (remove stopwords and normalize)
function tokenizeText(text) {
  try {
    const words = text.toLowerCase().split(/\s+/);
    const filteredWords = stopwords.removeStopwords(words, stopwords.ru);
    const result = filteredWords.join(' ');
    return result.length > 3 ? result : text; // Fallback to original if too short
  } catch (error) {
    console.error('Ошибка токенизации текста:', error);
    return text;
  }
}

// Validate training data
function isValidTrainingData(data) {
  return data.input && data.output && 
         data.input.length > 3 && data.output.length > 3 && 
         !/^\s*$/.test(data.input) && !/^\s*$/.test(data.output);
}

// Read files from data/messages directory
async function readFilesFromDirectory(dir, fileCount = { count: 0 }, cache = {}) {
  try {
    const files = await fs.readdir(dir, { withFileTypes: true });
    const filePromises = files.map(async (file) => {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        return readFilesFromDirectory(fullPath, fileCount, cache);
      } else {
        let content;
        const stats = await fs.stat(fullPath);
        const cacheKey = `${fullPath}:${stats.mtimeMs}`;
        if (cache[cacheKey]) {
          content = cache[cacheKey];
        } else {
          content = await readFileContent(fullPath);
          cache[cacheKey] = content;
        }
        const tokenizedContent = tokenizeText(content);
        if (file.name === 'Q&A.txt') {
          const qaPairs = parseQAPairs(tokenizedContent);
          trainingData.push(...qaPairs.filter(isValidTrainingData));
        } else if (tokenizedContent.length > 3) {
          trainingData.push({ input: tokenizedContent, output: tokenizedContent });
        }
        fileCount.count += 1;
        if (fileCount.count % 5 === 0) {
          await saveModel();
        }
      }
    });
    await Promise.all(filePromises);
    await saveCache(cache);
    if (trainingData.length > 1000) {
      trainingData.splice(0, trainingData.length - 1000);
    }
    checkMemoryUsage();
  } catch (error) {
    console.error(`Ошибка чтения файлов из ${dir}:`, error);
  }
}

// Parse file content based on type
async function readFileContent(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      const dataBuffer = await fs.readFile(filePath);
      const pdfData = await PDFParser(dataBuffer, { max: 500 });
      return pdfData.text;
    } else if (ext === '.html') {
      const content = await fs.readFile(filePath, 'utf8');
      const root = parse(content);
      return root.textContent;
    } else {
      return await fs.readFile(filePath, 'utf8');
    }
  } catch (error) {
    console.error(`Ошибка чтения файла ${filePath}:`, error);
    return '';
  }
}

// Parse Q&A file
function parseQAPairs(content) {
  const pairs = [];
  const lines = content.split('\n');
  let question = null;
  for (const line of lines) {
    if (line.startsWith('В:')) {
      question = line.slice(2).trim();
    } else if (line.startsWith('О:') && question) {
      pairs.push({ input: tokenizeText(question), output: tokenizeText(line.slice(2).trim()) });
      question = null;
    }
  }
  return pairs;
}

// Extract and download URLs from text
async function processUrls(text) {
  try {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex) || [];
    const contents = [];
    for (const url of urls) {
      if (!forbiddenDomains.some(domain => url.includes(domain))) {
        try {
          const response = await axios.get(url);
          const content = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
          const tokenizedContent = tokenizeText(content.slice(0, 1000));
          if (tokenizedContent.length > 3) {
            contents.push(tokenizedContent);
          }
        } catch (error) {
          console.error(`Ошибка скачивания URL ${url}:`, error.message);
        }
      }
    }
    checkMemoryUsage();
    return contents;
  } catch (error) {
    console.error('Ошибка обработки URL:', error);
    return [];
  }
}

// Read Discord messages
async function readDiscordMessages() {
  try {
    const guilds = client.guilds.cache;
    const channelPromises = [];
    for (const guild of guilds.values()) {
      const channels = guild.channels.cache.filter(channel => 
        channel.isTextBased() && 
        channel.permissionsFor(client.user).has(Discord.PermissionsBitField.Flags.ViewChannel)
      );
      channels.forEach(channel => {
        channelPromises.push(
          (async () => {
            try {
              const messages = await channel.messages.fetch({ limit: 100 });
              for (const msg of messages.values()) {
                if (!msg.author.bot) {
                  const tokenizedContent = tokenizeText(msg.content);
                  if (tokenizedContent.length > 3) {
                    trainingData.push({ input: tokenizedContent, output: tokenizedContent });
                    const urlContents = await processUrls(msg.content);
                    urlContents.forEach(content => {
                      trainingData.push({ input: tokenizedContent, output: content });
                    });
                  }
                }
              }
            } catch (err) {
              console.error(`Ошибка чтения сообщений из канала ${channel.name}:`, err);
            }
          })()
        );
      });
    }
    await Promise.all(channelPromises);
    if (trainingData.length > 1000) {
      trainingData.splice(0, trainingData.length - 1000);
    }
    checkMemoryUsage();
  } catch (error) {
    console.error('Ошибка чтения сообщений Discord:', error);
  }
}

// Web search
async function searchWeb(query) {
  try {
    const response = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
    const results = response.data.RelatedTopics;
    for (const result of results) {
      const url = result.FirstURL;
      if (!forbiddenDomains.some(domain => url.includes(domain))) {
        const pageResponse = await axios.get(url);
        return pageResponse.data;
      }
    }
    return null;
  } catch (error) {
    console.error('Ошибка веб-поиска:', error);
    return null;
  }
}

// Detect language
function detectLanguage(text) {
  try {
    return franc.franc(text, { minLength: 3 }) || 'und';
  } catch (error) {
    console.error('Ошибка определения языка:', error);
    return 'und';
  }
}

// Train neural network incrementally
async function trainIncrementally(data) {
  try {
    const validData = data.filter(isValidTrainingData);
    if (validData.length === 0) {
      console.log('Нет валидных данных для инкрементного обучения');
      return;
    }
    net.train(validData, {
      iterations: 20,
      errorThresh: 0.005,
      log: (stats) => {
        console.log(`Эпоха: ${epochCounter}, Ошибка: ${stats.error}`);
        epochCounter += 1;
      },
      logPeriod: 1,
    });
    await saveModel();
    checkMemoryUsage();
  } catch (error) {
    console.error('Ошибка инкрементного обучения:', error);
    await saveModel();
  }
}

// Train neural network
async function trainNetwork() {
  console.log('Начало обучения...');
  await loadModel();
  await ensureDataDirectory();

  const cache = await loadCache();
  await readFilesFromDirectory(path.join(__dirname, 'data', 'messages'), { count: 0 }, cache);
  await client.login(process.env.DISCORD_TOKEN);
  await new Promise(resolve => {
    client.on('ready', () => {
      console.log(`Вошел как ${client.user.tag} для чтения сообщений`);
      resolve();
    });
  });
  await readDiscordMessages();
  await client.destroy();

  const validData = trainingData.filter(isValidTrainingData);
  if (validData.length === 0) {
    console.log('Нет валидных данных для обучения.');
    await saveModel();
    return;
  }

  try {
    net.train(validData, {
      iterations: 100,
      errorThresh: 0.005,
      log: (stats) => {
        console.log(`Эпоха: ${epochCounter}, Ошибка: ${stats.error}`);
        epochCounter += 1;
      },
      logPeriod: 1,
    });
    console.log('Обучение завершено.');
    await saveModel();
    epochCounter = 1; // Reset epoch counter
  } catch (error) {
    console.error('Ошибка обучения:', error);
    await saveModel();
  }
}

// Register slash commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [
    {
      name: 'set-channel',
      description: 'Установить канал для AI-ответов',
      options: [
        {
          name: 'channel',
          type: Discord.ApplicationCommandOptionType.Channel,
          description: 'Канал для AI-ответов',
          required: true,
        },
      ],
    },
  ];

  try {
    await rest.put(
      Routes.applicationCommands(process.env.APPLICATION_ID),
      { body: commands }
    );
    console.log('Команда /set-channel зарегистрирована глобально');
  } catch (error) {
    console.error('Ошибка регистрации команды /set-channel:', error);
  }
}

// Handle Ctrl+C to save model
process.on('SIGINT', async () => {
  console.log('Получен сигнал Ctrl+C, сохранение модели...');
  await saveModel();
  console.log('Модель сохранена, завершение работы.');
  process.exit(0);
});

// Start bot
async function startBot(mode) {
  await loadConfig();
  await registerCommands();

  if (mode === 'train') {
    await trainNetwork();
    return;
  }

  await loadModel();

  client.on('ready', () => {
    console.log(`Вошел как ${client.user.tag}`);
    console.log('Бот готов к обработке запросов (!ai или в AI-канале).');
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    const lang = detectLanguage(content);
    const guildId = message.guild.id;
    const isAiChannel = config.aiChannels[guildId]?.includes(message.channel.id);

    // Handle !ai command
    if (content.startsWith('!ai ')) {
      const query = content.slice(4).trim();
      console.log(`Ответ на запрос !ai: ${query}`);
      try {
        let response = '';
        try {
          response = net.run(query) || '';
        } catch (error) {
          console.error(`Ошибка выполнения нейронной сети для запроса "${query}":`, error);
        }

        if (!response || response.length < 10 || /^\s*$/.test(response) || /^(.)\1+$/.test(response)) {
          console.log(`Слабый ответ, выполняется веб-поиск для запроса: ${query}`);
          const webData = await searchWeb(query);
          if (webData) {
            response = tokenizeText(webData.slice(0, 1000));
          } else {
            await message.reply('Недостаточно данных для ответа. Уточните запрос.');
            console.log(`Ответ на запрос "${query}": Недостаточно данных`);
            return;
          }
        }

        const tokenizedQuery = tokenizeText(query);
        if (isValidTrainingData({ input: tokenizedQuery, output: response })) {
          trainingData.push({ input: tokenizedQuery, output: response });
          console.log(`Ответ на запрос "${query}": ${response.slice(0, 50)}...`);
        }

        const urlContents = await processUrls(query);
        urlContents.forEach(content => {
          if (isValidTrainingData({ input: tokenizedQuery, output: content })) {
            trainingData.push({ input: tokenizedQuery, output: content });
          }
        });

        responseCount += 1;
        if (responseCount % 10 === 0) {
          console.log(`Запуск инкрементного обучения после ${responseCount} запросов...`);
          await trainIncrementally(trainingData);
          trainingData.length = 0;
        }

        if (response.includes('```')) {
          await message.reply(`response.js\n${response}\nGenerated by OmniDed ai`);
        } else {
          await message.reply(response);
        }
      } catch (error) {
        console.error(`Ошибка обработки запроса !ai "${query}":`, error);
        await message.reply('Произошла ошибка при обработке запроса. Попробуйте снова.');
      }
    }

    // Handle messages in AI channel
    if (isAiChannel && !content.startsWith('!')) {
      console.log(`Ответ на запрос в AI-канале: ${content}`);
      try {
        let response = '';
        try {
          response = net.run(content) || '';
        } catch (error) {
          console.error(`Ошибка выполнения нейронной сети для запроса "${content}":`, error);
        }

        if (!response || response.length < 10 || /^\s*$/.test(response) || /^(.)\1+$/.test(response)) {
          console.log(`Слабый ответ, выполняется веб-поиск для запроса: ${content}`);
          const webData = await searchWeb(content);
          if (webData) {
            response = tokenizeText(webData.slice(0, 1000));
          } else {
            await message.reply('Недостаточно данных для ответа. Уточните запрос.');
            console.log(`Ответ на запрос "${content}": Недостаточно данных`);
            return;
          }
        }

        const tokenizedContent = tokenizeText(content);
        if (isValidTrainingData({ input: tokenizedContent, output: response })) {
          trainingData.push({ input: tokenizedContent, output: response });
          console.log(`Ответ на запрос "${content}": ${response.slice(0, 50)}...`);
        }

        const urlContents = await processUrls(content);
        urlContents.forEach(content => {
          if (isValidTrainingData({ input: tokenizedContent, output: content })) {
            trainingData.push({ input: tokenizedContent, output: content });
          }
        });

        responseCount += 1;
        if (responseCount % 10 === 0) {
          console.log(`Запуск инкрементного обучения после ${responseCount} запросов...`);
          await trainIncrementally(trainingData);
          trainingData.length = 0;
        }

        await message.reply(response);
      } catch (error) {
        console.error(`Ошибка обработки запроса в AI-канале "${content}":`, error);
        await message.reply('Произошла ошибка при обработке запроса. Попробуйте снова.');
      }
    }
  });

  // Handle /set-channel command
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'set-channel') {
      const isAdmin = interaction.member.permissions.has(Discord.PermissionsBitField.Flags.Administrator);
      const isWhereGamer = interaction.user.id === '1064781271043166218';

      if (!isAdmin && !isWhereGamer) {
        await interaction.reply({ content: 'Требуются права администратора или аккаунт @wheregamer.', ephemeral: true });
        console.log('Ошибка: Пользователь без прав попытался выполнить /set-channel');
        return;
      }

      const channel = interaction.options.getChannel('channel');
      if (!channel.isTextBased()) {
        await interaction.reply({ content: 'Укажите текстовый канал.', ephemeral: true });
        console.log('Ошибка: Указан нетекстовый канал для /set-channel');
        return;
      }

      const guildId = interaction.guild.id;
      if (!config.aiChannels[guildId]) {
        config.aiChannels[guildId] = [];
      }
      if (!config.aiChannels[guildId].includes(channel.id)) {
        config.aiChannels[guildId].push(channel.id);
        await saveConfig();
        await interaction.reply(`Канал ${channel.name} добавлен для AI-ответов на сервере ${interaction.guild.name}`);
        console.log(`Канал ${channel.name} добавлен для AI-ответов (сервер: ${guildId})`);
      } else {
        await interaction.reply(`Канал ${channel.name} уже установлен для AI-ответов`);
        console.log(`Канал ${channel.name} уже в списке AI-каналов (сервер: ${guildId})`);
      }
    }
  });

  try {
    client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Ошибка входа в Discord:', error);
  }
}

// Console interface
function startConsoleInterface() {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('=== AI Бот ===');
  console.log('Выберите режим:');
  console.log('1 - Обучение: Читает файлы, сообщения Discord и URL, обучает модель.');
  console.log('2 - Ответ: Обрабатывает запросы !ai и в AI-канале, обучается на ответах.');
  readline.question('Введите номер режима (1 или 2): ', (modeInput) => {
    const modes = { '1': 'train', '2': 'answer' };
    const mode = modes[modeInput] || 'answer';
    console.log(`Выбран режим: ${mode === 'train' ? 'Обучение' : 'Ответ'}`);
    startBot(mode).then(() => {
      if (mode === 'train') {
        console.log('Обучение завершено. Запустить другой режим?');
        startConsoleInterface();
      }
    });
    readline.close();
  });
}

// Start the bot
startConsoleInterface();