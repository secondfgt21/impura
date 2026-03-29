const { Telegraf, Markup } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN || '';

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN belum di-set');
}

const bot = new Telegraf(token);

// jangan polling di Vercel webhook
bot.launch = () => {};

bot.start(async (ctx) => {
  try {
    await ctx.reply(
      'Bot aktif ✅\n\nKetik /produk untuk lihat produk.',
      Markup.inlineKeyboard([
        [Markup.button.callback('📦 Lihat Produk', 'lihat_produk')],
      ])
    );
  } catch (err) {
    console.error('START ERROR:', err);
  }
});

bot.command('produk', async (ctx) => {
  try {
    await ctx.reply(
      'Pilih produk:',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔥 Beli Gemini', 'buy_gemini')],
        [Markup.button.callback('🤖 Beli ChatGPT', 'buy_chatgpt')],
      ])
    );
  } catch (err) {
    console.error('PRODUK ERROR:', err);
  }
});

bot.action('lihat_produk', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply(
      'Pilih produk:',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔥 Beli Gemini', 'buy_gemini')],
        [Markup.button.callback('🤖 Beli ChatGPT', 'buy_chatgpt')],
      ])
    );
  } catch (err) {
    console.error('LIHAT_PRODUK ERROR:', err);
  }
});

bot.action('buy_gemini', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('Order Gemini dibuat ✅');
  } catch (err) {
    console.error('BUY GEMINI ERROR:', err);
  }
});

bot.action('buy_chatgpt', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('Order ChatGPT dibuat ✅');
  } catch (err) {
    console.error('BUY CHATGPT ERROR:', err);
  }
});

bot.on('text', async (ctx) => {
  try {
    const msg = String(ctx.message?.text || '').trim();
    if (msg.startsWith('/')) return;
    await ctx.reply('Ketik /produk untuk mulai.');
  } catch (err) {
    console.error('TEXT ERROR:', err);
  }
});

bot.catch((err) => {
  console.error('BOT ERROR FULL:', err);
});

module.exports = bot;
