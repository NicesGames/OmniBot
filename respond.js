const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { searchAnswer } = require('./train.js');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function logError(message, error) {
  const logMessage = `AI: ${new Date().toISOString()} ${message}: ${error.message}\n${error.stack}\n`;
  console.error(logMessage);
  try {
    await fs.appendFile(path.join(__dirname, 'error.log'), logMessage);
  } catch (fsErr) {
    console.error(`AI: Error writing to error.log: ${fsErr.message}`);
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  try {
    const content = message.content.trim();
    console.log(`AI: Received message from ${message.author.tag}: ${content.slice(0, 30)}...`);

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
      let answer = await searchAnswer(query, message.author.id);
      answer = answer.replace(/[\t\n\r]+/g, ' ').trim().slice(0, 1900);
      if (!answer || answer.length < 5) {
        answer = 'No suitable answer found. Please clarify your question!';
      }

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Answer')
        .setDescription(answer)
        .setTimestamp();
      if (message.channel.permissionsFor(client.user).has(['SendMessages'])) {
        await message.reply({ embeds: [embed] });
        console.log(`AI: Sent answer to ${message.author.tag}: ${answer.slice(0, 30)}...`);
      } else {
        console.log(`AI: Cannot respond in channel ${message.channel.name} (ID: ${message.channel.id}): missing permissions`);
      }
    }

    if (message.reference && message.reference.messageId) {
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

      const feedbackDir = path.join(__dirname, 'data', 'feedback');
      await fs.mkdir(feedbackDir, { recursive: true });
      const feedbackLog = `AI: ${new Date().toISOString()} User: ${message.author.id}, Rating: ${rating}, Comment: ${comment}\n`;
      await fs.appendFile(path.join(feedbackDir, 'feedback.log'), feedbackLog);

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
    }
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

function startResponseMode() {
  console.log('AI: Starting response mode');
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error(`AI: Discord login error: ${error.message}`);
    process.exit(1);
  });
}

client.once('ready', () => {
  console.log(`AI: Bot started in response mode: ${client.user.tag}`);
});

module.exports = { startResponseMode };