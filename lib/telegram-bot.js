const { Telegraf } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new Telegraf(token);

bot.start(async (ctx) => {
  await ctx.reply('Bot aktif ✅');
});

bot.on('text', async (ctx) => {
  await ctx.reply(`Kamu kirim: ${ctx.message.text}`);
});

module.exports = bot;
