# OmniDed

OmniDed is a self-learning neural network Discord bot powered by `brain.js`. It processes queries using the `!ai` command or in designated AI channels, learns from files, Discord messages, and web content, and supports multiple servers and channels.

## Features
- **Self-Learning**: Trains on text files, Discord messages, and URLs using an LSTM neural network.
- **Commands**: Supports `!ai`, `!set-channel`, `!aihelp`, `/set-channel`, and `/aihelp`.
- **Multi-Server Support**: Configurable AI channels for multiple servers.
- **Memory Management**: Configurable memory limit to prevent excessive RAM usage.
- **Web Search Fallback**: Uses DuckDuckGo API for weak responses.
- **Console Interface**: Choose between training and answering modes.

## Commands
- `!ai [query]`: Sends a query to the neural network for a response.
- `!set-channel [channel]`: Sets a channel for AI responses without `!ai` (e.g., `!set-channel #ai-channel`). Requires admin or specific user permissions.
- `!aihelp`: Displays help message with command descriptions.
- `/set-channel [channel]`: Slash command to set AI channel (admin or specific user only).
- `/aihelp`: Slash command to display help message.

## Project Structure
```
project/
├── data/
│   ├── messages/
│   │   ├── Q&A.txt              # Q&A pairs for training (format: В: question О: answer)
│   │   ├── en.wikipedia.org_wiki_Cybersecurity.pdf  # PDF files for training
│   │   └── test/
│   │       └── example.txt      # Additional text files
│   ├── config.json              # AI channels and memory limit
│   ├── model.json               # Neural network model
│   ├── cache.json               # File content cache
├── .env                         # Discord token and application ID
├── index.js                     # Main bot code
├── package.json                 # Dependencies
├── pdf.py                       # website to pdf
├── гкдюече                      # for pdf.py
├── node_modules/
```

## Prerequisites
- **Node.js**: Version 16 or higher.
- **Python**: Version 3.9.13 (for `pdf-parse`).
- **Visual Studio 2022**: With "Desktop development with C++" workload (for `pdf-parse`).
- **Discord Bot**: Created in [Discord Developer Portal](https://discord.com/developers/applications) with `bot` and `applications.commands` scopes, and `Server Members Intent`, `Message Content Intent` enabled.

## Setup
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/NicesGames/OmniDed.git
   cd OmniDed
   ```

2. **Install Dependencies**:
   ```bash
   npm cache clean --force
   rmdir /s /q node_modules
   del package-lock.json
   npm install discord.js brain.js@2.0.0-beta.22 axios franc@6.2.0 pdf-parse node-html-parser dotenv stopword heapdump
   ```

3. **Configure Environment**:
   Create a `.env` file in the root directory:
   ```
   DISCORD_TOKEN=your-discord-bot-token
   APPLICATION_ID=your-application-id
   ```
   - Obtain `DISCORD_TOKEN` and `APPLICATION_ID` from [Discord Developer Portal](https://discord.com/developers/applications).

4. **Prepare Training Data**:
   - Place text, PDF, or HTML files in `data/messages/`.
   - Example `Q&A.txt`:
     ```
     В: ку
     О: Привет! Рад тебя видеть. Как настроение?
     В: как дела?
     О: Всё отлично, а у тебя?
     ```

5. **Configure Memory Limit**:
   Edit `data/config.json` to set `maxMemoryMB` (e.g., 1536 for 1.5GB limit):
   ```json
   {
     "aiChannels": {},
     "maxMemoryMB": 1536
   }
   ```

## Running the Bot
1. Start the bot:
   ```bash
   node --expose-gc index.js
   ```
2. Choose a mode in the console:
   - `1 - Training`: Reads files, Discord messages, and URLs, trains the model.
   - `2 - Answering`: Processes `!ai`, `!set-channel`, `!aihelp`, and AI channel messages, learns incrementally.
3. Use commands in Discord:
   - `!ai [query]`: Get a response from the neural network.
   - `!set-channel #channel` or `/set-channel [channel]`: Set AI channel (admin or user ID `1064781271043166218` only).
   - `!aihelp` or `/aihelp`: Show help message.

## Training
- **Data Sources**: Text files, PDFs, HTML files in `data/messages/`, Discord messages (up to 100 per channel), and URLs in messages.
- **Model Saving**: Saves `model.json` after each epoch, every 5 files, and on Ctrl+C.
- **Memory Management**: Limits training data to 1000 entries and monitors RAM usage.

## Troubleshooting
- **Error `Warning: TT: undefined function: 3`**: Ensure `brain.js@2.0.0-beta.22` is installed and training data is valid. Check logs for invalid inputs.
- **Slash Commands Not Working**: Verify `APPLICATION_ID` in `.env` and `applications.commands` scope in Discord Developer Portal.
- **High Memory Usage**: Reduce `maxMemoryMB` in `config.json` and check `heapdump-*.heapsnapshot` files for memory leaks.
- **Poor Responses**: Add more training data to `data/messages/` or increase incremental training iterations.

## Contributing
Contributions are welcome! Please submit issues or pull requests to [NicesGames/OmniDed](https://github.com/NicesGames/OmniDed).

## License
MIT License
