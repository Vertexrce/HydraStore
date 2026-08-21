# Running the Hydra bot on Railway

Create a **separate Worker service** in the same Railway project for `bot.py`.
Keep the existing web service running `node server.js`.

Set this Railway variable on the bot Worker:

```text
DISCORD_TOKEN=your_bot_token
```

Use these service settings:

- **Install command:** `pip install -r requirements.txt`
- **Start command:** `python bot.py`

In the Discord Developer Portal, enable **Message Content Intent** under
**Bot → Privileged Gateway Intents** if you want to use the `!ping` command.
The `/ping` and `/hydra` slash commands do not require message content.

Never put the bot token in source code or upload it to GitHub.