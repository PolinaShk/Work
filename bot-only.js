const { Telegraf, Markup } = require('telegraf');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ========== НАСТРОЙКИ ПРОКСИ ==========
const PROXY_URL = 'socks5://192.168.2.100:8085';

const agent = new SocksProxyAgent(PROXY_URL);

// ========== НАСТРОЙКИ ==========
const BOT_TOKEN = '8956101079:AAGK9P0epRl0lPen_Rtg3A8-SXS8CeS_3g8';
const NOTIFY_BOT_TOKEN = '8994848427:AAH2WIqaQW5D_eWD3YVW168gxYmYpnpO2j8';
const MANAGER_CHAT_ID = '801163470';

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'restaurant_bot',
  waitForConnections: true,
  connectionLimit: 10,
});

// ========== СОЗДАНИЕ БОТА С ПРОКСИ ==========
const bot = new Telegraf(BOT_TOKEN, {
  telegram: { agent: agent }
});
const carts = new Map();
const tempOrders = new Map();
const tempItemSelection = new Map();

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

// Отправка нового сообщения и удаление старого (если есть callback)
async function sendNewMessage(ctx, text, keyboard = null) {
  // Удаляем предыдущее сообщение, если оно от бота и было callback
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    }
  } catch (error) {
    // Игнорируем ошибки удаления
  }
  
  const opts = { parse_mode: 'Markdown' };
  if (keyboard) opts.reply_markup = keyboard.reply_markup;
  return await ctx.reply(text, opts);
}

// Короткое временное сообщение (для подтверждений)
async function sendTempMessage(ctx, text, delay = 2000) {
  const msg = await ctx.reply(text, { parse_mode: 'Markdown' });
  setTimeout(async () => {
    try {
      await ctx.deleteMessage(msg.message_id);
    } catch (e) {}
  }, delay);
}

// ========== ПОЛУЧЕНИЕ МОДИФИКАТОРОВ ==========
async function getModifiersForItem(itemId) {
  const [modifiers] = await pool.execute(`
    SELECT m.*, im.maxSelect FROM modifier m
    JOIN item_modifier im ON m.id = im.modifierId
    WHERE im.itemId = ? AND m.isAvailable = 1
    ORDER BY FIELD(m.type, 'SIZE', 'ADDITIVE', 'SPICINESS'), m.price
  `, [itemId]);
  
  return {
    size: modifiers.filter(m => m.type === 'SIZE'),
    additives: modifiers.filter(m => m.type === 'ADDITIVE'),
    spiciness: modifiers.filter(m => m.type === 'SPICINESS')
  };
}

// ========== ПРОВЕРКА ДОСТУПНОСТИ ==========
async function checkCartAvailability(cart) {
  const unavailable = [];
  for (const item of cart) {
    const [itemRows] = await pool.execute('SELECT isAvailable, name FROM item WHERE id = ?', [item.id]);
    if (itemRows.length > 0 && itemRows[0].isAvailable === 0) {
      unavailable.push({ type: 'item', itemName: itemRows[0].name });
    }
    if (item.modifiers && item.modifiers.length > 0) {
      for (const mod of item.modifiers) {
        const [modRows] = await pool.execute('SELECT isAvailable FROM modifier WHERE id = ?', [mod.id]);
        if (modRows.length > 0 && modRows[0].isAvailable === 0) {
          unavailable.push({ type: 'modifier', itemName: item.name, modifierName: mod.name });
        }
      }
    }
  }
  return unavailable;
}

// ========== УВЕДОМЛЕНИЕ МЕНЕДЖЕРУ (с прокси) ==========
async function notifyManager(orderNumber, total, customerName, selectedTime, hasUnavailable) {
  const timeStr = selectedTime ? new Date(selectedTime).toLocaleString() : 'Как можно скорее';
  const unavailableText = hasUnavailable ? '\n⚠️ Есть недоступные позиции! Требуется согласование.' : '';
  const message = `🆕 *Новый заказ!*${unavailableText}\n\n📦 Заказ: ${orderNumber}\n👤 Клиент: ${customerName}\n💰 Сумма: ${total} руб.\n⏰ Время получения: ${timeStr}\n\n📋 Перейдите в админ-панель для обработки.`;
  await fetch(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: MANAGER_CHAT_ID, text: message, parse_mode: 'Markdown' }),
    agent: agent
  });
}

// ========== УВЕДОМЛЕНИЕ КЛИЕНТУ О СТАТУСЕ ==========
async function notifyCustomer(customerId, orderNumber, status) {
  try {
    let message = '';
    if (status === 'CONFIRMED') {
      message = `✅ *Заказ #${orderNumber} принят!*\n\nВаш заказ передан на кухню. Ожидайте уведомление о начале приготовления.`;
    } else if (status === 'PREPARING') {
      message = `🍳 *Заказ #${orderNumber} готовится!*\n\nНачинаем готовить ваш заказ. Скоро будет готов!`;
    } else if (status === 'READY') {
      message = `🎉 *Заказ #${orderNumber} готов!*\n\nМожете забирать в ресторане.\nОплата при получении.`;
    }
    if (message) {
      await bot.telegram.sendMessage(customerId, message, { parse_mode: 'Markdown' });
      console.log(`📨 Уведомление о статусе ${status} отправлено клиенту ${customerId}`);
    }
  } catch (error) {
    console.error('Ошибка отправки уведомления клиенту:', error.message);
  }
}

// ========== ОТСЛЕЖИВАНИЕ ИЗМЕНЕНИЙ СТАТУСА ==========
let lastStatuses = new Map();

async function checkStatusChanges() {
  try {
    const [orders] = await pool.execute(
      `SELECT id, orderNumber, customerId, status, notified 
       FROM \`order\` 
       WHERE status IN ('CONFIRMED', 'PREPARING', 'READY')`
    );
    
    for (const order of orders) {
      const lastStatus = lastStatuses.get(order.id);
      if (lastStatus !== order.status) {
        lastStatuses.set(order.id, order.status);
        if (order.status === 'CONFIRMED' || order.status === 'PREPARING' || order.status === 'READY') {
          await notifyCustomer(order.customerId, order.orderNumber, order.status);
        }
      }
    }
  } catch (error) {
    console.error('Ошибка проверки статусов:', error);
  }
}

// ========== СОХРАНЕНИЕ ЗАКАЗА ==========
async function saveOrder(userId, customerName, cart, selectedTime) {
  const total = cart.reduce((sum, item) => sum + Number(item.price), 0);
  const orderNumber = `ORD${Date.now()}`;
  const unavailable = await checkCartAvailability(cart);
  const status = unavailable.length > 0 ? 'PENDING' : 'NEW';
  const unavailableText = unavailable.length > 0 ? JSON.stringify(unavailable) : null;
  
  const [orderResult] = await pool.execute(
    `INSERT INTO \`order\` (orderNumber, customerId, customerName, totalPrice, status, selectedTime, unavailableItems, createdAt, updatedAt, notified)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 0)`,
    [orderNumber, userId, customerName, total, status, selectedTime, unavailableText]
  );
  const orderId = orderResult.insertId;
  for (const item of cart) {
    const modifiersJson = item.modifiers ? JSON.stringify(item.modifiers) : null;
    await pool.execute(
      `INSERT INTO order_item (orderId, itemId, itemName, itemPrice, quantity, modifiers) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, item.id, item.name, Number(item.price), 1, modifiersJson]
    );
  }
  
  if (status === 'NEW') {
    await notifyCustomer(userId, orderNumber, 'CONFIRMED');
  }
  
  return { orderNumber, total, hasUnavailable: unavailable.length > 0, orderId };
}

// ========== ПРОВЕРКА ПРЕДЛОЖЕНИЙ ==========
async function checkPendingSuggestions() {
  try {
    const [suggestions] = await pool.execute(
      'SELECT * FROM suggestions WHERE status = "PENDING" ORDER BY createdAt ASC'
    );
    for (const sug of suggestions) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, согласен', `accept_${sug.id}`)],
        [Markup.button.callback('❌ Нет, уберите добавку', `reject_${sug.id}`)],
        [Markup.button.callback('🔴 Отменить заказ', `cancel_${sug.id}`)]
      ]);
      await bot.telegram.sendMessage(sug.customerId, 
        `📝 *Предложение по заказу #${sug.orderNumber}*\n\n${sug.message}\n\nЧто выберете?`,
        { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) { console.error('Ошибка проверки предложений:', error); }
}

// ========== ОБРАБОТКА ОТВЕТА КЛИЕНТА ==========
bot.action(/accept_(.+)/, async (ctx) => {
  const suggestionId = parseInt(ctx.match[1]);
  await pool.execute('UPDATE suggestions SET status = "ACCEPTED" WHERE id = ?', [suggestionId]);
  const [sug] = await pool.execute('SELECT orderId FROM suggestions WHERE id = ?', [suggestionId]);
  if (sug.length > 0) {
    await pool.execute('UPDATE `order` SET status = "CONFIRMED" WHERE id = ?', [sug[0].orderId]);
    const [order] = await pool.execute('SELECT customerId, orderNumber FROM `order` WHERE id = ?', [sug[0].orderId]);
    if (order.length > 0) {
      await notifyCustomer(order[0].customerId, order[0].orderNumber, 'CONFIRMED');
    }
  }
  await sendNewMessage(ctx, `✅ Спасибо! Ваш заказ подтверждён и передан в приготовление.`);
  await ctx.answerCbQuery();
});

bot.action(/reject_(.+)/, async (ctx) => {
  const suggestionId = parseInt(ctx.match[1]);
  await pool.execute('UPDATE suggestions SET status = "REJECTED" WHERE id = ?', [suggestionId]);
  const [sug] = await pool.execute('SELECT orderId FROM suggestions WHERE id = ?', [suggestionId]);
  if (sug.length > 0) {
    await pool.execute('UPDATE `order` SET status = "CONFIRMED" WHERE id = ?', [sug[0].orderId]);
    const [order] = await pool.execute('SELECT customerId, orderNumber FROM `order` WHERE id = ?', [sug[0].orderId]);
    if (order.length > 0) {
      await notifyCustomer(order[0].customerId, order[0].orderNumber, 'CONFIRMED');
    }
  }
  await sendNewMessage(ctx, `✅ Поняли, приготовим без этой добавки.`);
  await ctx.answerCbQuery();
});

bot.action(/cancel_(.+)/, async (ctx) => {
  const suggestionId = parseInt(ctx.match[1]);
  await pool.execute('UPDATE suggestions SET status = "REJECTED" WHERE id = ?', [suggestionId]);
  const [sug] = await pool.execute('SELECT orderId FROM suggestions WHERE id = ?', [suggestionId]);
  if (sug.length > 0) {
    await pool.execute('UPDATE `order` SET status = "CANCELLED" WHERE id = ?', [sug[0].orderId]);
  }
  await sendNewMessage(ctx, `❌ Заказ отменён. Приносим извинения.`);
  await ctx.answerCbQuery();
});

// ========== КОМАНДЫ ==========
bot.start(async (ctx) => {
  const welcomeText = `🍕 *Добро пожаловать в наш ресторан!*\n\nЯ помогу вам оформить заказ на самовывоз.\n\n📋 *Что я умею:*\n• Просматривать меню с категориями\n• Добавлять позиции в корзину с выбором размера, добавок и остроты\n• Оформлять заказ на ближайшее или конкретное время\n• Отслеживать статус заказа\n\n📌 *Команды:*\n/menu — посмотреть меню\n/cart — корзина\n/order — оформить заказ\n/clear — очистить корзину\n/help — помощь\n\nПриятного аппетита! 🍽️`;
  await ctx.reply(welcomeText, { parse_mode: 'Markdown' });
});

bot.command('menu', async (ctx) => { await showCategories(ctx); });
bot.command('cart', async (ctx) => { await showCart(ctx); });
bot.command('order', async (ctx) => { await startOrder(ctx); });
bot.command('clear', async (ctx) => {
  const userId = ctx.from.id;
  carts.delete(userId);
  await sendTempMessage(ctx, `🗑 Корзина очищена`, 2000);
});
bot.command('help', async (ctx) => {
  const helpText = `📋 *Помощь*\n\n/menu — посмотреть меню\n/cart — корзина\n/order — оформить заказ\n/clear — очистить корзину\n/help — эта справка`;
  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// ========== КОРЗИНА ==========
async function showCart(ctx) {
  const userId = ctx.from.id;
  const cart = carts.get(userId) || [];
  if (cart.length === 0) { 
    await sendTempMessage(ctx, `🛒 Корзина пуста. Добавьте позиции через /menu`, 3000);
    return; 
  }
  let message = '🛒 *Ваша корзина:*\n\n';
  let total = 0;
  cart.forEach((item, i) => { 
    const price = Number(item.price);
    message += `${i+1}. ${item.name} — ${price} руб.\n`;
    if (item.modifiers && item.modifiers.length > 0) {
      message += `   ${item.modifiers.map(m => m.name).join(', ')}\n`;
    }
    total += price;
  });
  message += `\n*Итого: ${total} руб.*`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Оформить заказ', 'checkout')],
    [Markup.button.callback('🗑 Очистить корзину', 'clear_cart')],
    [Markup.button.callback('🍕 Продолжить выбор', 'continue_shopping')]
  ]);
  await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function startOrder(ctx) {
  const userId = ctx.from.id;
  const cart = carts.get(userId) || [];
  if (cart.length === 0) { 
    await sendTempMessage(ctx, `🛒 Корзина пуста. Добавьте позиции через /menu`, 3000);
    return; 
  }
  await askForTime(ctx, userId, cart);
}

async function askForTime(ctx, userId, cart) {
  tempOrders.set(userId, { cart });
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⚡ На ближайшее время', 'time_nearest')],
    [Markup.button.callback('📅 На конкретное время', 'time_specific')],
    [Markup.button.callback('🔙 Вернуться в корзину', 'back_to_cart')]
  ]);
  await ctx.reply('🕐 *Выберите время получения:*', { parse_mode: 'Markdown', ...keyboard });
}

// ========== ВЫБОР ВРЕМЕНИ ==========
bot.action('checkout', async (ctx) => {
  const userId = ctx.from.id;
  const cart = carts.get(userId) || [];
  if (cart.length === 0) { 
    await ctx.answerCbQuery('Корзина пуста'); 
    return; 
  }
  await askForTime(ctx, userId, cart);
  await ctx.answerCbQuery();
});

bot.action('back_to_cart', async (ctx) => {
  await sendNewMessage(ctx, '🔄 Возврат в корзину...');
  await showCart(ctx);
  await ctx.answerCbQuery();
});

bot.action('clear_cart', async (ctx) => {
  const userId = ctx.from.id;
  carts.delete(userId);
  await ctx.answerCbQuery('Корзина очищена');
  await sendNewMessage(ctx, `🗑 Корзина очищена.`);
});

bot.action('continue_shopping', async (ctx) => {
  await showCategories(ctx);
  await ctx.answerCbQuery();
});

bot.action('time_nearest', async (ctx) => {
  const userId = ctx.from.id;
  const temp = tempOrders.get(userId);
  if (!temp) return;
  const customerName = ctx.from.first_name || 'Клиент';
  const selectedTime = new Date();
  selectedTime.setMinutes(selectedTime.getMinutes() + 15);
  const { orderNumber, total, hasUnavailable } = await saveOrder(userId, customerName, temp.cart, selectedTime);
  carts.delete(userId);
  tempOrders.delete(userId);
  let replyMsg = `✅ Заказ #${orderNumber} оформлен!\n💰 Сумма: ${total} руб.\n⏰ Будет готово примерно к ${selectedTime.getHours()}:${selectedTime.getMinutes().toString().padStart(2,'0')}\n`;
  replyMsg += hasUnavailable ? `\n⚠️ Некоторые позиции недоступны. Менеджер свяжется с вами.` : `\n✅ Заказ принят. Ожидайте уведомление о начале приготовления.`;
  await sendNewMessage(ctx, replyMsg);
  await notifyManager(orderNumber, total, customerName, selectedTime, hasUnavailable);
  await ctx.answerCbQuery();
});

bot.action('time_specific', async (ctx) => {
  await showDateSelection(ctx);
  await ctx.answerCbQuery();
});

async function showDateSelection(ctx) {
  const dates = [];
  const now = new Date();
  
  for (let i = 0; i <= 7; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() + i);
    date.setHours(0, 0, 0, 0);
    const dayName = date.toLocaleDateString('ru-RU', { weekday: 'short' });
    const dateStr = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' });
    dates.push({
      date: date,
      timestamp: date.getTime(),
      label: `${dayName}, ${dateStr}`
    });
  }
  
  const buttons = dates.map(d => 
    Markup.button.callback(d.label, `date_${d.timestamp}`)
  );
  
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  keyboard.push([Markup.button.callback('🔙 Назад', 'back_to_time_choice')]);
  
  await sendNewMessage(ctx, '📅 *Выберите дату:*', Markup.inlineKeyboard(keyboard));
}

bot.action(/date_(\d+)/, async (ctx) => {
  const timestamp = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const temp = tempOrders.get(userId);
  if (temp) {
    temp.selectedDate = new Date(timestamp);
    tempOrders.set(userId, temp);
  }
  await showTimeSlotsForDate(ctx, new Date(timestamp));
  await ctx.answerCbQuery();
});

async function showTimeSlotsForDate(ctx, date) {
  const buttons = [];
  const now = new Date();
  
  for (let hour = 10; hour <= 22; hour++) {
    for (let minute of [0, 30]) {
      if (hour === 22 && minute > 0) continue;
      
      const slotTime = new Date(date);
      slotTime.setHours(hour, minute, 0, 0);
      
      if (slotTime > now) {
        const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        buttons.push(Markup.button.callback(timeStr, `timeslot_${slotTime.getTime()}`));
      }
    }
  }
  
  if (buttons.length === 0) {
    await sendTempMessage(ctx, '❌ На выбранную дату нет доступного времени. Выберите другую дату.', 3000);
    await showDateSelection(ctx);
    return;
  }
  
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) {
    keyboard.push(buttons.slice(i, i + 3));
  }
  keyboard.push([Markup.button.callback('🔙 Выбрать другую дату', 'back_to_date_selection')]);
  
  await sendNewMessage(ctx, `📅 *${date.toLocaleDateString('ru-RU')}*\n\n🕐 *Выберите время:*`, Markup.inlineKeyboard(keyboard));
}

bot.action('back_to_date_selection', async (ctx) => {
  await showDateSelection(ctx);
  await ctx.answerCbQuery();
});

bot.action('back_to_time_choice', async (ctx) => {
  const userId = ctx.from.id;
  const temp = tempOrders.get(userId);
  if (temp) {
    await askForTime(ctx, userId, temp.cart);
  }
  await ctx.answerCbQuery();
});

bot.action(/timeslot_(\d+)/, async (ctx) => {
  const userId = ctx.from.id;
  const timestamp = parseInt(ctx.match[1]);
  const temp = tempOrders.get(userId);
  if (!temp) return;
  
  const customerName = ctx.from.first_name || 'Клиент';
  const selectedTime = new Date(timestamp);
  const { orderNumber, total, hasUnavailable } = await saveOrder(userId, customerName, temp.cart, selectedTime);
  carts.delete(userId);
  tempOrders.delete(userId);
  
  let replyMsg = `✅ Заказ #${orderNumber} оформлен!\n💰 Сумма: ${total} руб.\n⏰ Время получения: ${selectedTime.toLocaleString()}\n`;
  replyMsg += hasUnavailable ? `\n⚠️ Некоторые позиции недоступны. Менеджер свяжется с вами.` : `\n✅ Заказ принят. Ожидайте уведомление о начале приготовления.`;
  await sendNewMessage(ctx, replyMsg);
  await notifyManager(orderNumber, total, customerName, selectedTime, hasUnavailable);
  await ctx.answerCbQuery();
});

// ========== МЕНЮ ==========
async function showCategories(ctx) {
  try {
    const res = await fetch('http://127.0.0.1:3000/menu/categories');
    const cats = await res.json();
    if (!cats || !Array.isArray(cats)) {
      await sendTempMessage(ctx, '❌ Ошибка загрузки меню', 3000);
      return;
    }
    const buttons = cats.filter(c => c.isActive).map(c => Markup.button.callback(c.name, `cat_${c.id}`));
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i+2));
    keyboard.push([Markup.button.callback('🛒 Корзина', 'go_to_cart')]);
    await sendNewMessage(ctx, '🍕 *Выберите категорию:*', Markup.inlineKeyboard(keyboard));
  } catch (error) {
    console.error(error);
    await sendTempMessage(ctx, '❌ Ошибка загрузки меню', 3000);
  }
}

bot.action(/cat_(\d+)/, async (ctx) => {
  const catId = parseInt(ctx.match[1]);
  try {
    const res = await fetch(`http://127.0.0.1:3000/menu/categories/${catId}/items`);
    const items = await res.json();
    const catRes = await fetch('http://127.0.0.1:3000/menu/categories');
    const cats = await catRes.json();
    const category = cats.find(c => c.id === catId);
    
    // Удаляем сообщение с категориями
    try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
    
    // Формируем ОДНО сообщение со всеми позициями
    let message = `📋 *${category?.name}*\n\n`;
    const buttons = [];
    
    for (const item of items) {
      message += `🍽 *${item.name}* — ${Number(item.price)} руб.\n`;
      if (item.description) message += `📝 ${item.description}\n`;
      if (item.composition) message += `🥗 ${item.composition}\n`;
      message += `\n`;
      
      buttons.push([Markup.button.callback(`➕ ${item.name}`, `add_${item.id}`)]);
    }
    
    buttons.push([Markup.button.callback('🔙 Назад к категориям', 'back_to_categories')]);
    buttons.push([Markup.button.callback('🛒 Корзина', 'go_to_cart')]);
    
    await sendNewMessage(ctx, message, Markup.inlineKeyboard(buttons));
  } catch (error) {
    console.error(error);
    await sendTempMessage(ctx, '❌ Ошибка загрузки позиций', 3000);
  }
  await ctx.answerCbQuery();
});

// ========== ДОБАВЛЕНИЕ ТОВАРА ==========
bot.action(/add_(\d+)/, async (ctx) => {
  const itemId = parseInt(ctx.match[1]);
  const res = await fetch('http://127.0.0.1:3000/menu/items');
  const items = await res.json();
  const item = items.find(i => i.id === itemId);
  if (!item) return;
  
  const userId = ctx.from.id;
  const modifiers = await getModifiersForItem(itemId);
  
  // Удаляем сообщение с информацией о товаре
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  
  const [itemCheck] = await pool.execute('SELECT isAvailable FROM item WHERE id = ?', [itemId]);
  if (itemCheck.length > 0 && itemCheck[0].isAvailable === 0) {
    await sendNewMessage(ctx, `❌ *${item.name}* временно недоступен. Приносим извинения.`);
    await ctx.answerCbQuery();
    return;
  }
  
  // Если нет модификаторов - добавляем сразу и показываем кнопки
  if (modifiers.size.length === 0 && modifiers.additives.length === 0 && modifiers.spiciness.length === 0) {
    const cart = carts.get(userId) || [];
    cart.push({ id: item.id, name: item.name, price: Number(item.price), modifiers: [] });
    carts.set(userId, cart);
    await ctx.answerCbQuery(`✅ ${item.name} добавлен в корзину!`);
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🛒 В корзину', 'go_to_cart')],
      [Markup.button.callback('🍕 Продолжить выбор', 'continue_shopping')]
    ]);
    await sendNewMessage(ctx, `✅ *${item.name}* добавлен в корзину!`, keyboard);
    return;
  }
  
  // Если есть модификаторы - начинаем выбор
  tempItemSelection.set(userId, { 
    item: { id: item.id, name: item.name, basePrice: Number(item.price) },
    selectedSize: null,
    selectedAdditives: [],
    selectedSpiciness: null
  });
  await showSizeOptions(ctx, userId);
  await ctx.answerCbQuery();
});

async function showSizeOptions(ctx, userId) {
  const selection = tempItemSelection.get(userId);
  if (!selection) return;
  
  const modifiers = await getModifiersForItem(selection.item.id);
  const sizeModifiers = modifiers.size;
  
  if (sizeModifiers.length === 0) {
    await showAdditiveOptions(ctx, userId);
    return;
  }
  
  const buttons = sizeModifiers.map(m => 
    Markup.button.callback(
      `${m.name}${Number(m.price) > 0 ? ` (+${Number(m.price)} руб)` : ''}`, 
      `size_${m.id}`
    )
  );
  buttons.push(Markup.button.callback('🔙 Отмена', 'cancel_item_selection'));
  
  await sendNewMessage(ctx, `🍕 *${selection.item.name}*\n\nВыберите размер:`, Markup.inlineKeyboard([buttons]));
}

bot.action(/size_(\d+)/, async (ctx) => {
  const sizeId = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const selection = tempItemSelection.get(userId);
  if (!selection) return;
  
  // Удаляем сообщение с выбором размера
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  
  const [size] = await pool.execute('SELECT * FROM modifier WHERE id = ?', [sizeId]);
  if (size.length === 0) return;
  
  selection.selectedSize = { 
    id: size[0].id, 
    name: size[0].name, 
    price: Number(size[0].price) || 0 
  };
  tempItemSelection.set(userId, selection);
  
  await showAdditiveOptions(ctx, userId);
  await ctx.answerCbQuery();
});

async function showAdditiveOptions(ctx, userId) {
  const selection = tempItemSelection.get(userId);
  if (!selection) return;
  
  const modifiers = await getModifiersForItem(selection.item.id);
  const additives = modifiers.additives;
  
  if (additives.length === 0) {
    await showSpicinessOptions(ctx, userId);
    return;
  }
  
  const buttons = additives.map(m => 
    Markup.button.callback(
      `${m.name}${Number(m.price) > 0 ? ` (+${Number(m.price)} руб)` : ''}`,
      `additive_${m.id}`
    )
  );
  
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i+2));
  }
  keyboard.push([Markup.button.callback('➡️ Далее', 'skip_additives')]);
  keyboard.push([Markup.button.callback('🔙 Назад к размеру', 'back_to_size')]);
  
  let message = `🍕 *${selection.item.name}*\n`;
  if (selection.selectedSize) {
    message += `📏 Размер: ${selection.selectedSize.name} (+${selection.selectedSize.price} руб)\n`;
  }
  message += `\n🥗 *Выберите добавки:* (можно несколько)\n`;
  if (selection.selectedAdditives.length > 0) {
    message += `\n✅ Уже выбраны: ${selection.selectedAdditives.map(a => a.name).join(', ')}`;
  }
  
  await sendNewMessage(ctx, message, Markup.inlineKeyboard(keyboard));
}

bot.action('back_to_size', async (ctx) => {
  const userId = ctx.from.id;
  // Удаляем текущее сообщение с добавками
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  await showSizeOptions(ctx, userId);
  await ctx.answerCbQuery();
});

bot.action(/additive_(\d+)/, async (ctx) => {
  const additiveId = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const selection = tempItemSelection.get(userId);
  if (!selection) return;
  
  const [additive] = await pool.execute('SELECT * FROM modifier WHERE id = ?', [additiveId]);
  if (additive.length === 0) return;
  
  const existing = selection.selectedAdditives.find(a => a.id === additiveId);
  if (existing) {
    selection.selectedAdditives = selection.selectedAdditives.filter(a => a.id !== additiveId);
    await sendTempMessage(ctx, `❌ ${additive[0].name} убран`, 1500);
  } else {
    selection.selectedAdditives.push({ id: additive[0].id, name: additive[0].name, price: Number(additive[0].price) });
    await sendTempMessage(ctx, `✅ ${additive[0].name} добавлен`, 1500);
  }
  tempItemSelection.set(userId, selection);
  await showAdditiveOptions(ctx, userId);
  await ctx.answerCbQuery();
});

bot.action('skip_additives', async (ctx) => {
  const userId = ctx.from.id;
  // Удаляем сообщение с добавками
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  await showSpicinessOptions(ctx, userId);
  await ctx.answerCbQuery();
});

async function showSpicinessOptions(ctx, userId) {
  const selection = tempItemSelection.get(userId);
  if (!selection) return;
  
  const modifiers = await getModifiersForItem(selection.item.id);
  const spicinessOptions = modifiers.spiciness;
  
  if (spicinessOptions.length === 0) {
    await finalizeAddToCart(ctx, userId);
    return;
  }
  
  const buttons = spicinessOptions.map(m => 
    Markup.button.callback(m.name, `spiciness_${m.id}`)
  );
  buttons.push(Markup.button.callback('🔙 Назад к добавкам', 'back_to_additives'));
  
  let message = `🍕 *${selection.item.name}*\n`;
  if (selection.selectedSize) {
    message += `📏 Размер: ${selection.selectedSize.name} (+${selection.selectedSize.price} руб)\n`;
  }
  if (selection.selectedAdditives.length > 0) {
    message += `🥗 Добавки: ${selection.selectedAdditives.map(a => a.name).join(', ')}\n`;
  }
  message += `\n🌶️ *Выберите остроту:*`;
  
  await sendNewMessage(ctx, message, Markup.inlineKeyboard([buttons]));
}

bot.action('back_to_additives', async (ctx) => {
  const userId = ctx.from.id;
  // Удаляем сообщение с остротой
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  await showAdditiveOptions(ctx, userId);
  await ctx.answerCbQuery();
});

bot.action(/spiciness_(\d+)/, async (ctx) => {
  const spicinessId = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const selection = tempItemSelection.get(userId);
  if (!selection) return;
  
  // Удаляем сообщение с выбором остроты
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  
  const [spiciness] = await pool.execute('SELECT * FROM modifier WHERE id = ?', [spicinessId]);
  if (spiciness.length === 0) return;
  
  selection.selectedSpiciness = { id: spiciness[0].id, name: spiciness[0].name, price: Number(spiciness[0].price) };
  tempItemSelection.set(userId, selection);
  
  await finalizeAddToCart(ctx, userId);
  await ctx.answerCbQuery();
});

async function finalizeAddToCart(ctx, userId) {
  const selection = tempItemSelection.get(userId);
  if (!selection) return;
  
  const allModifiers = [];
  let modifiersPrice = 0;
  
  if (selection.selectedSize) {
    allModifiers.push(selection.selectedSize);
    modifiersPrice += Number(selection.selectedSize.price || 0);
  }
  
  for (const a of selection.selectedAdditives) {
    allModifiers.push(a);
    modifiersPrice += Number(a.price || 0);
  }
  
  if (selection.selectedSpiciness) {
    allModifiers.push(selection.selectedSpiciness);
    modifiersPrice += Number(selection.selectedSpiciness.price || 0);
  }
  
  const basePrice = Number(selection.item.basePrice);
  const totalPrice = basePrice + modifiersPrice;
  
  const cart = carts.get(userId) || [];
  cart.push({ 
    id: selection.item.id, 
    name: selection.item.name, 
    price: totalPrice, 
    modifiers: allModifiers 
  });
  carts.set(userId, cart);
  
  tempItemSelection.delete(userId);
  
  let replyMsg = `✅ *${selection.item.name}* добавлен в корзину!\n\n`;
  if (selection.selectedSize) replyMsg += `📏 ${selection.selectedSize.name}\n`;
  if (selection.selectedAdditives.length > 0) replyMsg += `🥗 Добавки: ${selection.selectedAdditives.map(a => a.name).join(', ')}\n`;
  if (selection.selectedSpiciness) replyMsg += `🌶️ ${selection.selectedSpiciness.name}\n`;
  replyMsg += `💰 Итого: ${totalPrice} руб. (${basePrice} + ${modifiersPrice})`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛒 В корзину', 'go_to_cart')],
    [Markup.button.callback('🍕 Продолжить выбор', 'continue_shopping')]
  ]);
  await sendNewMessage(ctx, replyMsg, keyboard);
}

// ========== НАВИГАЦИЯ ==========
bot.action('go_to_cart', async (ctx) => {
  // Удаляем текущее сообщение
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  await showCart(ctx);
  await ctx.answerCbQuery();
});

bot.action('continue_shopping', async (ctx) => {
  // Удаляем текущее сообщение
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  await showCategories(ctx);
  await ctx.answerCbQuery();
});

bot.action('back_to_categories', async (ctx) => {
  // Удаляем текущее сообщение
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  await showCategories(ctx);
  await ctx.answerCbQuery();
});

bot.action('cancel_item_selection', async (ctx) => {
  const userId = ctx.from.id;
  tempItemSelection.delete(userId);
  // Удаляем сообщение с выбором
  try { await ctx.deleteMessage(ctx.callbackQuery.message.message_id); } catch(e) {}
  await sendNewMessage(ctx, `❌ Выбор отменён`);
  await showCategories(ctx);
  await ctx.answerCbQuery();
});

// Команда /history - история заказов
bot.command('history', async (ctx) => {
  const userId = ctx.from.id;
  try {
    const [orders] = await pool.execute(
      'SELECT * FROM `order` WHERE customerId = ? ORDER BY createdAt DESC LIMIT 10',
      [userId]
    );
    
    if (orders.length === 0) {
      await sendTempMessage(ctx, '📋 У вас пока нет заказов', 3000);
      return;
    }
    
    let message = '📋 *Ваши последние заказы:*\n\n';
    const buttons = [];
    
    for (const order of orders) {
      message += `📦 *${order.orderNumber}* — ${order.totalPrice} руб. (${order.status})\n`;
      buttons.push([Markup.button.callback(`📦 Повторить заказ #${order.orderNumber}`, `repeat_${order.id}`)]);
    }
    
    buttons.push([Markup.button.callback('🛒 Корзина', 'go_to_cart')]);
    
    await sendPersistentMessage(ctx, message, Markup.inlineKeyboard(buttons));
  } catch (error) {
    console.error(error);
    await sendTempMessage(ctx, '❌ Ошибка загрузки истории', 3000);
  }
});

// Обработка повторного заказа
bot.action(/repeat_(\d+)/, async (ctx) => {
  const orderId = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  try {
    const [items] = await pool.execute(
      'SELECT itemId, itemName, itemPrice, modifiers FROM order_item WHERE orderId = ?',
      [orderId]
    );
    
    const cart = carts.get(userId) || [];
    for (const item of items) {
      let modifiers = [];
      if (item.modifiers) {
        try {
          modifiers = JSON.parse(item.modifiers);
        } catch(e) {}
      }
      cart.push({
        id: item.itemId,
        name: item.itemName,
        price: parseFloat(item.itemPrice),
        modifiers: modifiers
      });
    }
    carts.set(userId, cart);
    
    await sendNewMessage(ctx, `✅ Заказ повторён! Товары добавлены в корзину.`);
    await showCart(ctx);
  } catch (error) {
    console.error(error);
    await sendTempMessage(ctx, '❌ Ошибка при повторении заказа', 3000);
  }
  await ctx.answerCbQuery();
});

// ========== ЗАПУСК ==========
setInterval(checkStatusChanges, 5000);
setInterval(checkPendingSuggestions, 5000);
bot.launch();
console.log('🤖 Бот запущен с логикой "ответил → удалилось"!');