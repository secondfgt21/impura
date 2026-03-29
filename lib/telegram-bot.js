const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN belum di-set');
}

if (!BACKEND_BASE_URL) {
  throw new Error('BACKEND_BASE_URL belum di-set');
}

const bot = new Telegraf(BOT_TOKEN);

async function apiGet(path) {
  const url = `${BACKEND_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} gagal: ${res.status} ${text}`);
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
      '/produk - lihat stok & penjualan',
      '/cek <order_id> - cek status order',
      '/order <order_id> - sama seperti /cek',
      '/web - buka website',
      '/admin - buka panel admin',
    ].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.url('Buka Website', BACKEND_BASE_URL)],
      [Markup.button.callback('Lihat Produk', 'produk')],
    ])
  );
});

bot.command('web', async (ctx) => {
  await ctx.reply(
    'Ini web Impura:',
    Markup.inlineKeyboard([
      [Markup.button.url('Buka Website', BACKEND_BASE_URL)],
      [Markup.button.url('Cek Order', `${BACKEND_BASE_URL}/cek-order`)],
    ])
  );
});

bot.command('produk', async (ctx) => {
  try {
    const data = await apiGet('/api/stats');
    const stock = data.stock || {};
    const sold = data.sold || {};

    const products = [
      { id: 'gemini', name: 'Gemini AI Pro 3/4 Bulan', price: 20000 },
      { id: 'chatgpt', name: 'ChatGPT Plus 1 Bulan', price: 10000 },
    ];

    const lines = [
      '📦 *Produk tersedia*',
      '',
      ...products.map((p) => {
        const s = Number(stock[p.id] || 0);
        const terjual = Number(sold[p.id] || 0);

        return [
          `*${p.name}*`,
          `Harga: Rp ${formatRupiah(p.price)}`,
          `Stok: ${s}`,
          `Terjual: ${terjual}`,
          `Checkout: ${BACKEND_BASE_URL}/checkout/${p.id}`,
        ].join('\n');
      }),
      '',
      `Total terjual: ${Number(data.total_sold || 0)}`,
    ];

    await ctx.reply(lines.join('\n\n'), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('Beli Gemini', `${BACKEND_BASE_URL}/checkout/gemini`)],
        [Markup.button.url('Beli ChatGPT', `${BACKEND_BASE_URL}/checkout/chatgpt`)],
      ]),
    });
  } catch (err) {
    await ctx.reply(`Gagal ambil data produk: ${err.message}`);
  }
});

async function sendOrderStatus(ctx, orderId) {
  if (!orderId) {
    await ctx.reply('Format salah. Contoh: /cek 123e4567-e89b-12d3-a456-426614174000');
    return;
  }

  try {
    const data = await apiGet(`/api/order/${encodeURIComponent(orderId)}`);

    const statusMap = {
      pending: 'PENDING',
      paid: 'PAID ✅',
      cancelled: 'CANCELLED ❌',
    };

    const statusLabel = statusMap[data.status] || String(data.status || '-').toUpperCase();
    const statusUrl = `${BACKEND_BASE_URL}/status/${encodeURIComponent(orderId)}`;
    const voucherUrl = `${BACKEND_BASE_URL}/voucher/${encodeURIComponent(orderId)}`;

    const text = [
      '🧾 *Status Order*',
      '',
      `Order ID: \`${orderId}\``,
      `Status: *${statusLabel}*`,
      `Sisa waktu: ${Number(data.ttl_sec || 0)} detik`,
    ].join('\n');

    const buttons = [
      [Markup.button.url('Buka Status', statusUrl)],
    ];

    if (data.status === 'paid') {
      buttons.push([Markup.button.url('Buka Voucher', voucherUrl)]);
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (err) {
    await ctx.reply(`Order tidak ditemukan atau API error: ${err.message}`);
  }
}

bot.command('cek', async (ctx) => {
  const text = ctx.message?.text || '';
  const orderId = text.split(' ').slice(1).join(' ').trim();
  await sendOrderStatus(ctx, orderId);
});

bot.command('order', async (ctx) => {
  const text = ctx.message?.text || '';
  const orderId = text.split(' ').slice(1).join(' ').trim();
  await sendOrderStatus(ctx, orderId);
});

bot.command('admin', async (ctx) => {
  const adminUrl = `${BACKEND_BASE_URL}/admin?token=${encodeURIComponent(ADMIN_TOKEN)}`;
  await ctx.reply(
    'Buka panel admin di sini:',
    Markup.inlineKeyboard([
      [Markup.button.url('Buka Admin Panel', adminUrl)],
    ])
  );
});

bot.action('produk', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const data = await apiGet('/api/stats');
    const stock = data.stock || {};
    const sold = data.sold || {};

    await ctx.editMessageText(
      [
        '📦 Produk tersedia',
        '',
        `Gemini: stok ${Number(stock.gemini || 0)} | terjual ${Number(sold.gemini || 0)}`,
        `ChatGPT: stok ${Number(stock.chatgpt || 0)} | terjual ${Number(sold.chatgpt || 0)}`,
        '',
        `Website: ${BACKEND_BASE_URL}`,
      ].join('\n'),
      {
        ...Markup.inlineKeyboard([
          [Markup.button.url('Beli Gemini', `${BACKEND_BASE_URL}/checkout/gemini`)],
          [Markup.button.url('Beli ChatGPT', `${BACKEND_BASE_URL}/checkout/chatgpt`)],
        ]),
      }
    );
  } catch (err) {
    await ctx.answerCbQuery('Gagal ambil data');
  }
});

bot.catch(async (err, ctx) => {
  console.error('BOT ERROR:', err);
  try {
    await ctx.reply('Terjadi error pada bot. Coba lagi sebentar.');
  } catch (_) {}
});

module.exports = bot;
