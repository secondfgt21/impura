const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || 'https://i.ibb.co.com/hJ99X7Bb/IMG-20260317-064144.png';

const ORDER_TTL_MINUTES = 15;

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN belum di-set');
}

if (!BACKEND_BASE_URL) {
  throw new Error('BACKEND_BASE_URL belum di-set');
}

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL belum di-set');
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY belum di-set');
}

const bot = new Telegraf(token);
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

async function getStockMap() {
  const stock = Object.fromEntries(Object.keys(PRODUCTS).map((k) => [k, 0]));

  const { data, error } = await supabase
    .from('vouchers')
    .select('product_id')
    .eq('status', 'available');

  if (error) throw error;

  for (const row of data || []) {
    if (row.product_id in stock) {
      stock[row.product_id] += 1;
    }
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
    if (row.product_id in sold) {
      sold[row.product_id] += 1;
    }
  }

  return sold;
}

async function createOrder(productId, qty, tgUser) {
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
    telegram_user_id: String(tgUser?.id || ''),
    telegram_username: tgUser?.username || null,
    telegram_name: [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ') || null,
  };

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

  return data[0];
}

async function ensureNotExpired(order) {
  const st = String(order?.status || 'pending').toLowerCase();
  if (st !== 'pending') {
    return { ...order, ttl_sec: 0 };
  }

  const created = parseDt(order.created_at) || nowUtc();
  const elapsed = Math.floor((nowUtc().getTime() - created.getTime()) / 1000);
  const ttlSec = Math.max(0, ORDER_TTL_MINUTES * 60 - elapsed);

  if (ttlSec > 0) {
    return { ...order, ttl_sec: ttlSec };
  }

  await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', order.id);

  return {
    ...order,
    status: 'cancelled',
    ttl_sec: 0,
  };
}

function produkKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔥 Beli Gemini', 'buy:gemini:1'),
    ],
    [
      Markup.button.callback('🤖 Beli ChatGPT', 'buy:chatgpt:1'),
    ],
    [
      Markup.button.callback('📦 Refresh Produk', 'refresh_produk'),
    ],
    [
      Markup.button.url('🌐 Buka Website', BACKEND_BASE_URL),
      Markup.button.callback('🧾 Cek Order Saya', 'cek_manual'),
    ],
  ]);
}

function paymentKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Cek Pembayaran', `cekpay:${orderId}`),
    ],
    [
      Markup.button.callback('🔄 Refresh Status', `cekpay:${orderId}`),
    ],
  ]);
}

async function kirimProduk(ctx, edit = false) {
  const data = await apiGet('/api/stats');
  const stock = data.stock || {};
  const sold = data.sold || {};

  const text = [
    '📦 Produk Impura',
    '',
    'Gemini AI Pro 3/4 Bulan',
    `Harga: Rp ${rupiah(20000)}`,
    `Stok: ${Number(stock.gemini || 0)}`,
    `Terjual: ${Number(sold.gemini || 0)}`,
    '',
    'ChatGPT Plus 1 Bulan',
    `Harga: Rp ${rupiah(10000)}`,
    `Stok: ${Number(stock.chatgpt || 0)}`,
    `Terjual: ${Number(sold.chatgpt || 0)}`,
    '',
    `Total terjual: ${Number(data.total_sold || 0)}`,
    '',
    'Klik tombol di bawah untuk beli langsung di bot.',
  ].join('\n');

  if (edit) {
    await ctx.editMessageText(text, {
      ...produkKeyboard(),
    });
  } else {
    await ctx.reply(text, {
      ...produkKeyboard(),
    });
  }
}

async function kirimStatusOrder(ctx, orderId) {
  if (!orderId) {
    await ctx.reply('Format salah.\nContoh:\n/cek 123e4567-e89b-12d3-a456-426614174000');
    return;
  }

  const order = await getOrder(orderId);

  if (!order) {
    await ctx.reply('Order tidak ditemukan.');
    return;
  }

  const checked = await ensureNotExpired(order);

  const statusMap = {
    pending: 'PENDING ⏳',
    paid: 'PAID ✅',
    cancelled: 'CANCELLED ❌',
  };

  const statusText = statusMap[checked.status] || String(checked.status || '-').toUpperCase();

  const buttons = [
    [Markup.button.callback('🔄 Refresh Status', `cekpay:${checked.id}`)],
  ];

  if (checked.status === 'paid' && checked.voucher_code) {
    buttons.push([
      Markup.button.callback('📩 Ambil Produk', `ambil:${checked.id}`),
    ]);
  }

  await ctx.reply(
    [
      '🧾 Status Order',
      '',
      `Order ID: ${checked.id}`,
      `Status: ${statusText}`,
      `Sisa waktu: ${Number(checked.ttl_sec || 0)} detik`,
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function kirimPembayaran(ctx, order) {
  const product = PRODUCTS[order.product_id];
  const caption = [
    '🧾 Order berhasil dibuat',
    '',
    `Produk: ${product?.name || order.product_id}`,
    `Jumlah: ${order.qty}`,
    `Nominal transfer: Rp ${rupiah(order.amount_idr)}`,
    '',
    `Order ID: ${order.id}`,
    '',
    'Silakan bayar QRIS sesuai nominal tepat.',
    'Setelah bayar, tekan tombol Cek Pembayaran.',
  ].join('\n');

  try {
    await ctx.replyWithPhoto(QR_IMAGE_URL, {
      caption,
      ...paymentKeyboard(order.id),
    });
  } catch (err) {
    console.error('replyWithPhoto error:', err);

    await ctx.reply(
      [
        caption,
        '',
        `QRIS: ${QR_IMAGE_URL}`,
      ].join('\n'),
      {
        ...paymentKeyboard(order.id),
      }
    );
  }
}

async function kirimVoucher(ctx, order) {
  if (!order.voucher_code) {
    await ctx.reply('Pembayaran sudah masuk, tapi voucher belum tersedia. Coba lagi sebentar.');
    return;
  }

  const product = PRODUCTS[order.product_id];

  await ctx.reply(
    [
      '✅ Pembayaran berhasil',
      '',
      `Produk: ${product?.name || order.product_id}`,
      `Order ID: ${order.id}`,
      '',
      'Akun / Voucher:',
      '',
      String(order.voucher_code),
    ].join('\n')
  );
}

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Halo, selamat datang di Impura Bot 🚀',
      '',
      'Perintah yang tersedia:',
      '/produk - lihat produk & stok',
      '/cek <order_id> - cek status order',
      '/order <order_id> - sama seperti /cek',
      '/web - buka website',      
      '',
      'Ketik /produk untuk mulai beli.',
    ].join('\n'),
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 Lihat Produk', 'lihat_produk')],
        [Markup.button.callback('🧾 Cek Order Saya', 'cek_manual')],
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

bot.action('cek_manual', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('Kirim perintah:\n/cek ORDER_ID');
  } catch (err) {
    console.error('cek_manual error:', err);
  }
});

bot.action(/^buy:(.+):(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Membuat order...');

    const productId = ctx.match[1];
    const qty = Number(ctx.match[2] || 1);

    const order = await createOrder(productId, qty, ctx.from);
    await kirimPembayaran(ctx, order);
  } catch (err) {
    console.error('buy error:', err);
    try {
      await ctx.reply(`Gagal membuat order:\n${err.message}`);
    } catch {}
  }
});

bot.action(/^cekpay:(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Mengecek pembayaran...');

    const orderId = ctx.match[1];
    const order = await getOrder(orderId);

    if (!order) {
      await ctx.reply('Order tidak ditemukan.');
      return;
    }

    const checked = await ensureNotExpired(order);
    const st = String(checked.status || 'pending').toLowerCase();

    if (st === 'paid' && checked.voucher_code) {
      await kirimVoucher(ctx, checked);
      return;
    }

    if (st === 'cancelled') {
      await ctx.reply(
        [
          '❌ Order sudah cancelled / expired',
          '',
          `Order ID: ${checked.id}`,
        ].join('\n')
      );
      return;
    }

    await ctx.reply(
      [
        '⏳ Pembayaran belum terverifikasi',
        '',
        `Order ID: ${checked.id}`,
        `Nominal: Rp ${rupiah(checked.amount_idr)}`,
        `Sisa waktu: ${Number(checked.ttl_sec || 0)} detik`,
        '',
        'Kalau kamu baru saja bayar, tunggu sebentar lalu tekan cek lagi.',
      ].join('\n'),
      {
        ...paymentKeyboard(checked.id),
      }
    );
  } catch (err) {
    console.error('cekpay error:', err);
    try {
      await ctx.reply(`Gagal cek pembayaran:\n${err.message}`);
    } catch {}
  }
});

bot.action(/^ambil:(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Mengambil produk...');

    const orderId = ctx.match[1];
    const order = await getOrder(orderId);

    if (!order) {
      await ctx.reply('Order tidak ditemukan.');
      return;
    }

    if (String(order.status || '').toLowerCase() !== 'paid') {
      await ctx.reply('Order belum paid.');
      return;
    }

    await kirimVoucher(ctx, order);
  } catch (err) {
    console.error('ambil error:', err);
    try {
      await ctx.reply(`Gagal ambil produk:\n${err.message}`);
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
