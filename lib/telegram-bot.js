const { Telegraf, Markup } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN belum di-set');
}

if (!BACKEND_BASE_URL) {
  throw new Error('BACKEND_BASE_URL belum di-set');
}

const bot = new Telegraf(token);

// disable polling launch, karena kita pakai webhook di Vercel
bot.launch = () => {};

function rupiah(n) {
  return new Intl.NumberFormat('id-ID').format(Number(n || 0));
}

async function apiGet(path) {
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GET ${path} gagal: ${res.status} ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Response ${path} bukan JSON valid`);
  }
}

function produkKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.url('🔥 Beli Gemini', `${BACKEND_BASE_URL}/checkout/gemini`),
    ],
    [
      Markup.button.url('🤖 Beli ChatGPT', `${BACKEND_BASE_URL}/checkout/chatgpt`),
    ],
    [
      Markup.button.callback('📦 Refresh Produk', 'refresh_produk'),
    ],
    [
      Markup.button.url('🌐 Buka Website', BACKEND_BASE_URL),
      Markup.button.url('🧾 Cek Order', `${BACKEND_BASE_URL}/cek-order`),
    ],
  ]);
}

async function kirimProduk(ctx, edit = false) {
  const data = await apiGet('/api/stats');
  const stock = data.stock || {};
  const sold = data.sold || {};

  const text = [
    '📦 *Produk Impura*',
    '',
    '*Gemini AI Pro 3/4 Bulan*',
    `Harga: Rp ${rupiah(20000)}`,
    `Stok: ${Number(stock.gemini || 0)}`,
    `Terjual: ${Number(sold.gemini || 0)}`,
    '',
    '*ChatGPT Plus 1 Bulan*',
    `Harga: Rp ${rupiah(10000)}`,
    `Stok: ${Number(stock.chatgpt || 0)}`,
    `Terjual: ${Number(sold.chatgpt || 0)}`,
    '',
    `Total terjual: ${Number(data.total_sold || 0)}`,
    '',
    'Klik tombol di bawah untuk checkout.',
  ].join('\n');

  if (edit) {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...produkKeyboard(),
    });
  } else {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...produkKeyboard(),
    });
  }
}

async function kirimStatusOrder(ctx, orderId) {
  if (!orderId) {
    await ctx.reply('Format salah.\nContoh:\n`/cek 123e4567-e89b-12d3-a456-426614174000`', {
      parse_mode: 'Markdown',
    });
    return;
  }

  const data = await apiGet(`/api/order/${encodeURIComponent(orderId)}`);

  const statusMap = {
    pending: 'PENDING ⏳',
    paid: 'PAID ✅',
    cancelled: 'CANCELLED ❌',
  };

  const statusText = statusMap[data.status] || String(data.status || '-').toUpperCase();

  const buttons = [
    [Markup.button.url('🧾 Buka Status', `${BACKEND_BASE_URL}/status/${encodeURIComponent(orderId)}`)],
  ];

  if (data.status === 'paid') {
    buttons.push([
      Markup.button.url('📩 Buka Voucher', `${BACKEND_BASE_URL}/voucher/${encodeURIComponent(orderId)}`),
    ]);
  }

  await ctx.reply(
    [
      '🧾 *Status Order*',
      '',
      `Order ID: \`${orderId}\``,
      `Status: *${statusText}*`,
      `Sisa waktu: ${Number(data.ttl_sec || 0)} detik`,
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Halo, selamat datang di *Impura Bot* 🚀',
      '',
      'Perintah yang tersedia:',
      '/produk - lihat produk & stok',
      '/cek <order_id> - cek status order',
      '/order <order_id> - sama seperti /cek',
      '/web - buka website',
      '/admin - buka panel admin',
      '',
      'Ketik /produk untuk mulai beli.',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 Lihat Produk', 'lihat_produk')],
        [Markup.button.url('🌐 Website', BACKEND_BASE_URL)],
      ]),
    }
  );
});

bot.command('produk', async (ctx) => {
  try {
    await kirimProduk(ctx, false);
  } catch (err) {
    console.error('/produk error:', err);
    await ctx.reply(`Gagal ambil data produk:\n${err.message}`);
  }
});

bot.command('web', async (ctx) => {
  await ctx.reply(
    'Buka web Impura:',
    Markup.inlineKeyboard([
      [Markup.button.url('🌐 Website', BACKEND_BASE_URL)],
      [Markup.button.url('🧾 Cek Order', `${BACKEND_BASE_URL}/cek-order`)],
    ])
  );
});

bot.command('admin', async (ctx) => {
  if (!ADMIN_TOKEN) {
    await ctx.reply('ADMIN_TOKEN belum di-set.');
    return;
  }

  await ctx.reply(
    'Buka panel admin:',
    Markup.inlineKeyboard([
      [Markup.button.url('🔐 Admin Panel', `${BACKEND_BASE_URL}/admin?token=${encodeURIComponent(ADMIN_TOKEN)}`)],
    ])
  );
});

bot.command('cek', async (ctx) => {
  try {
    const text = ctx.message?.text || '';
    const orderId = text.split(' ').slice(1).join(' ').trim();
    await kirimStatusOrder(ctx, orderId);
  } catch (err) {
    console.error('/cek error:', err);
    await ctx.reply(`Gagal cek order:\n${err.message}`);
  }
});

bot.command('order', async (ctx) => {
  try {
    const text = ctx.message?.text || '';
    const orderId = text.split(' ').slice(1).join(' ').trim();
    await kirimStatusOrder(ctx, orderId);
  } catch (err) {
    console.error('/order error:', err);
    await ctx.reply(`Gagal cek order:\n${err.message}`);
  }
});

bot.action('lihat_produk', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await kirimProduk(ctx, true);
  } catch (err) {
    console.error('lihat_produk error:', err);
    try {
      await ctx.answerCbQuery('Gagal ambil produk');
    } catch {}
  }
});

bot.action('refresh_produk', async (ctx) => {
  try {
    await ctx.answerCbQuery('Refreshing...');
    await kirimProduk(ctx, true);
  } catch (err) {
    console.error('refresh_produk error:', err);
    try {
      await ctx.answerCbQuery('Gagal refresh');
    } catch {}
  }
});

bot.on('text', async (ctx) => {
  const msg = (ctx.message?.text || '').trim();

  if (msg.startsWith('/')) return;

  await ctx.reply(
    [
      'Perintah tidak dikenali.',
      '',
      'Gunakan:',
      '/produk',
      '/cek <order_id>',
      '/web',
    ].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('📦 Lihat Produk', 'lihat_produk')],
    ])
  );
});

bot.catch(async (err, ctx) => {
  console.error('BOT ERROR:', err);
  try {
    await ctx.reply('Terjadi error pada bot. Coba lagi sebentar.');
  } catch {}
});

module.exports = bot;
