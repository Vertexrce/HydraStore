"""Hydra Discord bot.

Run this as a separate Railway Worker service from the website service.
Required environment variable:
    DISCORD_TOKEN

Optional:
    BOT_PREFIX (default: !)
    BOT_STATUS (default: Hydra online)
"""

import os
import logging

import discord
from discord.ext import commands


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
log = logging.getLogger("hydra-bot")

intents = discord.Intents.default()
intents.message_content = True

prefix = os.getenv("BOT_PREFIX", "!")
bot = commands.Bot(command_prefix=prefix, intents=intents)


@bot.event
async def on_ready():
    log.info("Hydra bot online as %s", bot.user)
    try:
        synced = await bot.tree.sync()
        log.info("Synced %d slash command(s)", len(synced))
    except Exception:
        log.exception("Slash command sync failed")


@bot.tree.command(name="ping", description="Check whether the Hydra bot is online.")
async def ping(interaction: discord.Interaction):
    latency = round(bot.latency * 1000)
    await interaction.response.send_message(
        f"🔴 **Hydra is online** · `{latency}ms`",
        ephemeral=True,
    )


@bot.command(name="ping")
async def prefix_ping(ctx: commands.Context):
    latency = round(bot.latency * 1000)
    await ctx.reply(f"🔴 **Hydra is online** · `{latency}ms`")


@bot.tree.command(name="hydra", description="Show Hydra bot status.")
async def hydra_status(interaction: discord.Interaction):
    await interaction.response.send_message(
        f"🐉 **Hydra**\n{os.getenv('BOT_STATUS', 'Hydra online')}",
        ephemeral=True,
    )


async def main():
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        raise RuntimeError("DISCORD_TOKEN is missing from the environment.")
    async with bot:
        await bot.start(token)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())