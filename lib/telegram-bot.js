const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const QR_IMAGE_URL =
  process.env.QR_IMAGE_URL ||
  'https://i.ibb.co.com/hJ99X7Bb/IMG-20260317-064144.png';

const ORDER_TTL_MINUTES = 15;
const AUTO_CHECK_INTERVAL_MS = 10_000;
const AUTO_CHECK_MAX_MS = ORDER_TTL_MINUTES * 60 * 1000;

if (!token) throw new Error('TELEGRAM_BOT_TOKEN belum di-set');
if (!BACKEND_BASE_URL) throw new Error('BACKEND_BASE_URL belum di-set');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL belum di-set');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY belum di-set');

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

// in-memory task auto check
const AUTO_CHECK_TASKS = new Map();
// anti spam klik cek
const CHECK_LOCK = new Map();

function rupiah(n) {
  return new Intl.NumberFormat('id-ID').format(Number(n || 0));
}

function nowUtc() {
  return new Date();
}

function parseDt(s) {
  if (!s) return null;
  const dt = new Date(String(s));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function escapeMarkdownV2(text) {
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function paymentKeyboard(orderId, autoOn = true) {
  const rows = [
    [Markup.button.callback('🔄 Cek Pembayaran', `cekpay:${orderId}`)],
  ];

  if (autoOn) {
    rows.push([Markup.button.callback('⏹ Stop Auto Check', `stopauto:${orderId}`)]);
  }

  return Markup.inlineKeyboard(rows);
}

function produkKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔥 Beli Gemini', 'buy:gemini:1')],
    [Markup.button.callback('🤖 Beli ChatGPT', 'buy:chatgpt:1')],
    [Markup.button.callback('📦 Refresh Produk', 'refresh_produk')],
    [
      Markup.button.url('🌐 Buka Website', BACKEND_BASE_URL),
      Markup.button.callback('🧾 Cek Order Saya', 'cek_manual'),
    ],
  ]);
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

async function createOrder(productId, qty = 1) {
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
    return {
      ...order,
      ttl_sec: 0,
    };
  }

  const created = parseDt(order.created_at) || nowUtc();
  const elapsed = Math.floor((nowUtc().getTime() - created.getTime()) / 1000);
  const ttlSec = Math.max(0, ORDER_TTL_MINUTES * 60 - elapsed);

  if (ttlSec > 0) {
    return {
      ...order,
      ttl_sec: ttlSec,
    };
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

function buildProductText(data) {
  const stock = data.stock || {};
  const sold = data.sold || {};

  return [
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
}

async function kirimProduk(ctx, edit = false) {
  const data = await apiGet('/api/stats');
  const text = buildProductText(data);

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

function buildPendingText(order) {
  return [
    '⏳ Pembayaran belum terverifikasi',
    '',
    `Order ID: ${order.id}`,
    `Produk: ${PRODUCTS[order.product_id]?.name || order.product_id}`,
    `Jumlah: ${order.qty}`,
    `Nominal: Rp ${rupiah(order.amount_idr)}`,
    `Sisa waktu: ${Number(order.ttl_sec || 0)} detik`,
    '',
    'Kalau kamu baru saja bayar, tunggu sebentar.',
    'Bot akan auto check tiap 10 detik tanpa spam.',
  ].join('\n');
}

function buildCancelledText(order) {
  return [
    '❌ Order sudah cancelled / expired',
    '',
    `Order ID: ${order.id}`,
    `Produk: ${PRODUCTS[order.product_id]?.name || order.product_id}`,
  ].join('\n');
}

function buildPaidReadyText(order) {
  return [
    '✅ Pembayaran berhasil',
    '',
    `Order ID: ${order.id}`,
    `Produk: ${PRODUCTS[order.product_id]?.name || order.product_id}`,
    '',
    'Produk kamu sudah siap, mengirim sekarang...',
  ].join('\n');
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
  const st = String(checked.status || 'pending').toLowerCase();

  if (st === 'paid' && checked.voucher_code) {
    await kirimVoucherByChat(ctx.chat.id, checked);
    return;
  }

  if (st === 'cancelled') {
    await ctx.reply(buildCancelledText(checked));
    return;
  }

  await ctx.reply(buildPendingText(checked), {
    ...paymentKeyboard(checked.id, true),
  });
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
  ].join('\n');

  try {
    await ctx.replyWithPhoto(QR_IMAGE_URL, { caption });
  } catch (err) {
    console.error('replyWithPhoto error:', err);
    await ctx.reply(`${caption}\n\nQRIS: ${QR_IMAGE_URL}`);
  }

  const statusMsg = await ctx.reply(buildPendingText({
    ...order,
    ttl_sec: ORDER_TTL_MINUTES * 60,
  }), {
    ...paymentKeyboard(order.id, true),
  });

  startAutoCheck({
    orderId: order.id,
    chatId: statusMsg.chat.id,
    messageId: statusMsg.message_id,
    startedAt: Date.now(),
  });
}

async function kirimVoucherByChat(chatId, order) {
  if (!order.voucher_code) {
    await bot.telegram.sendMessage(
      chatId,
      'Pembayaran sudah masuk, tapi voucher belum tersedia. Coba lagi sebentar.'
    );
    return;
  }

  const product = PRODUCTS[order.product_id];
  const text = [
    '✅ Pembayaran berhasil',
    '',
    `Produk: ${product?.name || order.product_id}`,
    `Order ID: ${order.id}`,
    '',
    'Akun / Voucher:',
    '',
    String(order.voucher_code),
  ].join('\n');

  await bot.telegram.sendMessage(chatId, text);
}

async function updateOrderMessage(chatId, messageId, orderId, autoOn = true) {
  const rawOrder = await getOrder(orderId);

  if (!rawOrder) {
    await bot.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      'Order tidak ditemukan.'
    );
    stopAutoCheck(orderId);
    return { done: true, status: 'not_found' };
  }

  const order = await ensureNotExpired(rawOrder);
  const st = String(order.status || 'pending').toLowerCase();

  if (st === 'paid' && order.voucher_code) {
    await bot.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      buildPaidReadyText(order)
    );

    await kirimVoucherByChat(chatId, order);
    stopAutoCheck(orderId);
    return { done: true, status: 'paid' };
  }

  if (st === 'cancelled') {
    await bot.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      buildCancelledText(order)
    );
    stopAutoCheck(orderId);
    return { done: true, status: 'cancelled' };
  }

  await bot.telegram.editMessageText(
    chatId,
    messageId,
    undefined,
    buildPendingText(order),
    {
      ...paymentKeyboard(order.id, autoOn),
    }
  );

  return { done: false, status: 'pending' };
}

function stopAutoCheck(orderId) {
  const task = AUTO_CHECK_TASKS.get(orderId);
  if (task?.timer) {
    clearTimeout(task.timer);
  }
  AUTO_CHECK_TASKS.delete(orderId);
}

function startAutoCheck({ orderId, chatId, messageId, startedAt }) {
  stopAutoCheck(orderId);

  const task = {
    orderId,
    chatId,
    messageId,
    startedAt: startedAt || Date.now(),
    timer: null,
  };

  AUTO_CHECK_TASKS.set(orderId, task);

  const loop = async () => {
    try {
      const current = AUTO_CHECK_TASKS.get(orderId);
      if (!current) return;

      const runtime = Date.now() - current.startedAt;
      if (runtime > AUTO_CHECK_MAX_MS) {
        stopAutoCheck(orderId);
        try {
          await bot.telegram.editMessageReplyMarkup(chatId, messageId, undefined, {
            inline_keyboard: [
              [Markup.button.callback('🔄 Cek Pembayaran', `cekpay:${orderId}`)],
            ],
          });
        } catch {}
        return;
      }

      const result = await updateOrderMessage(chatId, messageId, orderId, true);
      if (result.done) return;

      current.timer = setTimeout(loop, AUTO_CHECK_INTERVAL_MS);
    } catch (err) {
      console.error('auto check error:', err);
      const current = AUTO_CHECK_TASKS.get(orderId);
      if (!current) return;
      current.timer = setTimeout(loop, AUTO_CHECK_INTERVAL_MS);
    }
  };

  task.timer = setTimeout(loop, AUTO_CHECK_INTERVAL_MS);
}

function isLocked(lockKey, ms = 3000) {
  const last = CHECK_LOCK.get(lockKey) || 0;
  const now = Date.now();

  if (now - last < ms) {
    return true;
  }

  CHECK_LOCK.set(lockKey, now);
  return false;
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

    const order = await createOrder(productId, qty);
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
    const orderId = ctx.match[1];
    const lockKey = `${ctx.from?.id}:${orderId}`;

    if (isLocked(lockKey, 2500)) {
      await ctx.answerCbQuery('Tunggu sebentar...');
      return;
    }

    await ctx.answerCbQuery('Mengecek pembayaran...');

    const chatId = ctx.chat.id;
    const messageId = ctx.callbackQuery.message.message_id;

    const result = await updateOrderMessage(chatId, messageId, orderId, true);

    if (!result.done) {
      const task = AUTO_CHECK_TASKS.get(orderId);
      if (!task) {
        startAutoCheck({
          orderId,
          chatId,
          messageId,
          startedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    console.error('cekpay error:', err);
    try {
      await ctx.answerCbQuery('Gagal cek pembayaran');
    } catch {}
  }
});

bot.action(/^stopauto:(.+)$/, async (ctx) => {
  try {
    const orderId = ctx.match[1];
    stopAutoCheck(orderId);
    await ctx.answerCbQuery('Auto check dimatikan');

    const rawOrder = await getOrder(orderId);
    if (!rawOrder) return;

    const order = await ensureNotExpired(rawOrder);
    await ctx.editMessageText(buildPendingText(order), {
      ...paymentKeyboard(order.id, false),
    });
  } catch (err) {
    console.error('stopauto error:', err);
    try {
      await ctx.answerCbQuery('Gagal stop auto check');
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
