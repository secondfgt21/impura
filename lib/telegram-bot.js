let TelegrafLib = null;
let Markup = null;

try {
  const telegraf = require('telegraf');
  TelegrafLib = telegraf.Telegraf;
  Markup = telegraf.Markup;
} catch (err) {
  console.error('Telegraf tidak bisa diload:', err);
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!BOT_TOKEN) {
  console.warn('TELEGRAM_BOT_TOKEN belum di-set');
}

if (!BACKEND_BASE_URL) {
  console.warn('BACKEND_BASE_URL belum di-set');
}

if (!TelegrafLib || !BOT_TOKEN || !BACKEND_BASE_URL) {
  module.exports = {
    handleUpdate: async () => {
      throw new Error('telegram bot belum siap');
    }
  };
  return;
}

const bot = new TelegrafLib(BOT_TOKEN);

async function apiGet(path) {
  const url = `${BACKEND_BASE_URL}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${path} gagal: ${res.status}`);
  }
  return res.json();
}

function formatRupiah(n) {
  return new Intl.NumberFormat('id-ID').format(Number(n || 0));
}

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Halo, selamat datang di bot Impura.',
      '',
      'Perintah yang tersedia:',
      '/produk',
      '/cek <order_id>',
      '/web',
      '/admin'
    ].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.url('Buka Website', BACKEND_BASE_URL)]
    ])
  );
});

bot.command('web', async (ctx) => {
  await ctx.reply(
    'Ini web Impura:',
    Markup.inlineKeyboard([
      [Markup.button.url('Buka Website', BACKEND_BASE_URL)],
      [Markup.button.url('Cek Order', `${BACKEND_BASE_URL}/cek-order`)]
    ])
  );
});

bot.command('produk', async (ctx) => {
  try {
    const data = await apiGet('/api/stats');
    const stock = data.stock || {};
    const sold = data.sold || {};

    await ctx.reply(
      [
        '📦 Produk tersedia',
        '',
        `Gemini: stok ${Number(stock.gemini || 0)} | terjual ${Number(sold.gemini || 0)} | Rp ${formatRupiah(20000)}`,
        `ChatGPT: stok ${Number(stock.chatgpt || 0)} | terjual ${Number(sold.chatgpt || 0)} | Rp ${formatRupiah(10000)}`
      ].join('\n')
    );
  } catch (err) {
    await ctx.reply(`Gagal ambil data: ${err.message}`);
  }
});

bot.command('cek', async (ctx) => {
  const text = ctx.message?.text || '';
  const orderId = text.split(' ').slice(1).join(' ').trim();

  if (!orderId) {
    await ctx.reply('Contoh: /cek 123e4567-e89b-12d3-a456-426614174000');
    return;
  }

  try {
    const data = await apiGet(`/api/order/${encodeURIComponent(orderId)}`);
    await ctx.reply(
      [
        '🧾 Status Order',
        `Order ID: ${orderId}`,
        `Status: ${String(data.status || '-').toUpperCase()}`,
        `Sisa waktu: ${Number(data.ttl_sec || 0)} detik`
      ].join('\n')
    );
  } catch (err) {
    await ctx.reply(`Gagal cek order: ${err.message}`);
  }
});

bot.command('admin', async (ctx) => {
  const adminUrl = `${BACKEND_BASE_URL}/admin?token=${encodeURIComponent(ADMIN_TOKEN)}`;
  await ctx.reply(
    'Admin panel:',
    Markup.inlineKeyboard([
      [Markup.button.url('Buka Admin Panel', adminUrl)]
    ])
  );
});

module.exports = bot;
