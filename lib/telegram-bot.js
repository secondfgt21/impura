const { Telegraf } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN belum di-set');
}

const bot = new Telegraf(token);

// WAJIB INI UNTUK WEBHOOK
bot.launch = () => {}; // disable launch

bot.start(async (ctx) => {
  await ctx.reply('Bot aktif ✅');
});

bot.on('text', async (ctx) => {
  await ctx.reply(`Kamu kirim: ${ctx.message.text}`);
});

module.exports = bot;
