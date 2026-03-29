const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || 'https://i.ibb.co.com/hJ99X7Bb/IMG-20260317-064144.png';

const ORDER_TTL_MINUTES = 15;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN belum di-set');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL belum di-set');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY belum di-set');

const bot = new Telegraf(BOT_TOKEN);
bot.launch = () => {};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PRODUCTS = {
  gemini: {
    id: 'gemini',
    name: 'Gemini AI Pro 3/4 Bulan',
    price: 20000,
  },
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT Plus 1 Bulan',
    price: 10000,
  },
};

function rupiah(n) {
  return new Intl.NumberFormat('id-ID').format(Number(n || 0));
}

function parseDt(s) {
  if (!s) return null;
  const dt = new Date(String(s));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function nowUtc() {
  return new Date();
}

async function getStockMap() {
  const stock = Object.fromEntries(Object.keys(PRODUCTS).map((k) => [k, 0]));
  const { data, error } = await supabase
    .from('vouchers')
    .select('product_id')
    .eq('status', 'available');

  if (error) throw error;

  for (const row of data || []) {
    if (row.product_id in stock) stock[row.product_id] += 1;
  }

  return stock;
}

async function getSoldMap() {
  const sold = Object.fromEntries(Object.keys(PRODUCTS).map((k) => [k, 0]));
  const { data, error } = await supabase
    .from('vouchers')
    .select('product_id')
    .eq('status', 'used');

  if (error) throw error;

  for (const row of data || []) {
    if (row.product_id in sold) sold[row.product_id] += 1;
  }

  return sold;
}

async function ensureNotExpired(order) {
  const st = String(order?.status || 'pending').toLowerCase();
  if (st !== 'pending') return { order, expired: false };

  const created = parseDt(order?.created_at) || nowUtc();
  const isExpired = (nowUtc().getTime() - created.getTime()) > ORDER_TTL_MINUTES * 60 * 1000;

  if (!isExpired) {
    return { order, expired: false };
  }

  await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', order.id);

  return {
    order: { ...order, status: 'cancelled' },
    expired: true,
  };
}

async function createOrder(productId, qty = 1, telegramUser = null) {
  const product = PRODUCTS[productId];
  if (!product) throw new Error('Produk tidak ditemukan');

  const stock = await getStockMap();
  if ((stock[productId] || 0) < qty) {
    throw new Error('Stok habis');
  }

  const uniqueCode = crypto.randomInt(101, 1000);
  const total = product.price * qty + uniqueCode;
  const orderId = crypto.randomUUID();

  const payload = {
    id: orderId,
    product_id: productId,
    qty,
    unit: product.price,
    amount_idr: total,
    status: 'pending',
    created_at: nowUtc().toISOString(),
    voucher_code: null,
  };

  if (telegramUser) {
    payload.telegram_user_id = String(telegramUser.id || '');
    payload.telegram_username = telegramUser.username || null;
    payload.telegram_name = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ') || null;
  }

  const { error } = await supabase.from('orders').insert(payload);
  if (error) throw error;

  return payload;
}

async function getOrder(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .limit(1);

  if (error) throw error;
  if (!data || !data.length) return null;

  const checked = await ensureNotExpired(data[0]);
  return checked.order;
}

function productKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔥 Beli Gemini', 'buy:gemini:1')],
    [Markup.button.callback('🤖 Beli ChatGPT', 'buy:chatgpt:1')],
    [Markup.button.callback('📦 Refresh Produk', 'refresh_produk')],
  ]);
}

function orderKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Cek Pembayaran', `cek:${orderId}`)],
    [Markup.button.callback('🔄 Refresh Status', `cek:${orderId}`)],
  ]);
}

async function sendProductList(ctx, edit = false) {
  const stock = await getStockMap();
  const sold = await getSoldMap();
  const totalSold = Object.values(sold).reduce((a, b) => a + b, 0);

  const text = [
    '📦 *Produk Impura*',
    '',
    `*${PRODUCTS.gemini.name}*`,
    `Harga: Rp ${rupiah(PRODUCTS.gemini.price)}`,
    `Stok: ${Number(stock.gemini || 0)}`,
    `Terjual: ${Number(sold.gemini || 0)}`,
    '',
    `*${PRODUCTS.chatgpt.name}*`,
    `Harga: Rp ${rupiah(PRODUCTS.chatgpt.price)}`,
    `Stok: ${Number(stock.chatgpt || 0)}`,
    `Terjual: ${Number(sold.chatgpt || 0)}`,
    '',
    `Total terjual: ${totalSold}`,
    '',
    'Klik tombol di bawah untuk beli langsung di bot.',
  ].join('\n');

  if (edit) {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...productKeyboard(),
    });
  } else {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...productKeyboard(),
    });
  }
}

async function sendPaymentMessage(ctx, order) {
  const product = PRODUCTS[order.product_id];

  const caption = [
    '🧾 *Order Berhasil Dibuat*',
    '',
    `Produk: *${product?.name || order.product_id}*`,
    `Jumlah: *${order.qty}*`,
    `Nominal: *Rp ${rupiah(order.amount_idr)}*`,
    '',
    `Order ID: \`${order.id}\``,
    '',
    'Silakan transfer sesuai nominal sampai 3 digit terakhir.',
    'Setelah bayar, tekan tombol *Cek Pembayaran* di bawah.',
  ].join('\n');

  await ctx.replyWithPhoto(QR_IMAGE_URL, {
    caption,
    parse_mode: 'Markdown',
    ...orderKeyboard(order.id),
  });
}

async function sendPaidVoucher(ctx, order) {
  const product = PRODUCTS[order.product_id];

  await ctx.reply(
    [
      '✅ *Pembayaran Berhasil*',
      '',
      `Produk: *${product?.name || order.product_id}*`,
      `Order ID: \`${order.id}\``,
      '',
      '*Akun / Voucher:*',
      '```',
      String(order.voucher_code || '').trim(),
      '```',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
    }
  );
}

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Halo, selamat datang di *Impura Bot* 🚀',
      '',
      'Semua pembelian bisa langsung lewat Telegram.',
      '',
      'Perintah:',
      '/produk - lihat produk',
      '/cek ORDER_ID - cek order',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      ...productKeyboard(),
    }
  );
});

bot.command('produk', async (ctx) => {
  try {
    await sendProductList(ctx, false);
  } catch (err) {
    console.error('/produk error:', err);
    await ctx.reply(`Gagal ambil produk:\n${err.message}`);
  }
});

bot.command('cek', async (ctx) => {
  try {
    const text = ctx.message?.text || '';
    const orderId = text.split(' ').slice(1).join(' ').trim();

    if (!orderId) {
      await ctx.reply('Contoh:\n/cek ORDER_ID');
      return;
    }

    const order = await getOrder(orderId);
    if (!order) {
      await ctx.reply('Order tidak ditemukan.');
      return;
    }

    const st = String(order.status || 'pending').toLowerCase();

    if (st === 'paid' && order.voucher_code) {
      await sendPaidVoucher(ctx, order);
      return;
    }

    if (st === 'cancelled') {
      await ctx.reply('Order sudah expired / cancelled.');
      return;
    }

    await ctx.reply(
      [
        '⏳ Status order masih *PENDING*',
        '',
        `Order ID: \`${order.id}\``,
        `Nominal: *Rp ${rupiah(order.amount_idr)}*`,
        '',
        'Kalau sudah bayar, tekan tombol cek lagi beberapa detik.',
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        ...orderKeyboard(order.id),
      }
    );
  } catch (err) {
    console.error('/cek error:', err);
    await ctx.reply(`Gagal cek order:\n${err.message}`);
  }
});

bot.action('refresh_produk', async (ctx) => {
  try {
    await ctx.answerCbQuery('Refreshing...');
    await sendProductList(ctx, true);
  } catch (err) {
    console.error('refresh_produk error:', err);
    try {
      await ctx.answerCbQuery('Gagal refresh');
    } catch {}
  }
});

bot.action(/^buy:(.+):(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Membuat order...');

    const productId = ctx.match[1];
    const qty = Number(ctx.match[2] || 1);

    const order = await createOrder(productId, qty, ctx.from);
    await sendPaymentMessage(ctx, order);
  } catch (err) {
    console.error('buy error:', err);
    try {
      await ctx.reply(`Gagal membuat order:\n${err.message}`);
    } catch {}
  }
});

bot.action(/^cek:(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Mengecek pembayaran...');

    const orderId = ctx.match[1];
    const order = await getOrder(orderId);

    if (!order) {
      await ctx.reply('Order tidak ditemukan.');
      return;
    }

    const st = String(order.status || 'pending').toLowerCase();

    if (st === 'paid' && order.voucher_code) {
      await sendPaidVoucher(ctx, order);
      return;
    }

    if (st === 'cancelled') {
      await ctx.reply(
        [
          '❌ Order sudah *CANCELLED*',
          '',
          `Order ID: \`${order.id}\``,
        ].join('\n'),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await ctx.reply(
      [
        '⏳ Pembayaran belum terverifikasi',
        '',
        `Order ID: \`${order.id}\``,
        `Nominal: *Rp ${rupiah(order.amount_idr)}*`,
        '',
        'Kalau kamu baru saja bayar, tunggu sebentar lalu tekan tombol cek lagi.',
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        ...orderKeyboard(order.id),
      }
    );
  } catch (err) {
    console.error('cek action error:', err);
    try {
      await ctx.reply(`Gagal cek pembayaran:\n${err.message}`);
    } catch {}
  }
});

bot.on('text', async (ctx) => {
  const msg = String(ctx.message?.text || '').trim();
  if (msg.startsWith('/')) return;

  await ctx.reply(
    'Ketik /produk untuk lihat produk dan beli langsung di bot.',
    productKeyboard()
  );
});

bot.catch(async (err, ctx) => {
  console.error('BOT ERROR FULL:', err);
  console.error('BOT ERROR MESSAGE:', err?.message);
  console.error('BOT ERROR DESCRIPTION:', err?.description);
  console.error('BOT ERROR RESPONSE:', err?.response?.description);

  try {
    await ctx.reply(`Error detail: ${err?.response?.description || err?.description || err?.message || 'unknown error'}`);
  } catch {}
});
