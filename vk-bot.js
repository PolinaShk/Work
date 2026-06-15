const { VK } = require('vk-io');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');
require('dotenv').config();

// ========== НАСТРОЙКИ ==========
const API_BASE_URL = 'http://127.0.0.1:3001';
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

const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: '5.131'
});

// ========== ХРАНИЛИЩА ==========
const carts = new Map();
const userStates = new Map();
const userOrderStates = new Map();

// ========== КРАСИВЫЕ ОПИСАНИЯ ==========
const itemDescriptions = {
  'Маргарита': '🍅 Классика итальянской кухни! Нежный вкус моцареллы, ароматный базилик и томатный соус.',
  'Пепперони': '🌶 Острая и сочная! Пикантная пепперони с расплавленным сыром.',
  'Гавайская': '🍍 Необычное сочетание! Сочная ветчина и сладкие ананасы под сырной шапкой.',
  'Четыре сыра': '🧀 Рай для сыромана! Моцарелла, пармезан, дор блю и чеддер в одной пицце.',
  'Кола': '🥤 Классическая Coca-Cola. Идеально дополнит вашу пиццу!',
  'Спрайт': '🍋 Освежающий Sprite. С цитрусовой ноткой!',
  'Фанта': '🍊 Апельсиновая Fanta. Солнечное настроение в каждом глотке!',
  'Сок яблочный': '🍎 Натуральный яблочный сок. Для тех, кто выбирает здоровье!',
  'Чизкейк': '🍰 Нежный чизкейк с ягодным соусом. Тает во рту!',
  'Тирамису': '☕ Итальянский десерт с кофейным вкусом и маскарпоне.',
  'Мороженое': '🍦 Классический пломбир с шоколадной крошкой.',
  'Классическая шаурма': '🌯 Хит продаж! Сочная курица, свежие овощи и наш фирменный чесночный соус.',
  'Шаурма с говядиной': '🥩 Нежная говядина с пряностями и острый соус.',
  'Острая шаурма': '🌶🔥 Пикантная курица с халапеньо и острым соусом чили!',
  'Шаурма с сыром': '🧀 Нежная курица, расплавленный сыр чеддер и сырный соус.',
  'Вегетарианская шаурма': '🥑 Сочные овощи, авокадо и соус цезарь.',
  'Американо': '☕ Классический черный кофе. Бодрость с утра! Цена: 120 руб.',
  'Латте': '🥛 Нежный кофе с молоком и воздушной пенкой. Цена: 180 руб.',
  'Капучино': '🇮🇹 Насыщенный эспрессо, горячее молоко и густая пенка. Цена: 170 руб.',
  'Раф': '🍦 Нежнейший кофе со сливками и ванилью. Цена: 200 руб.',
  'Мокко': '🍫 Кофе с шоколадным сиропом и сливками. Цена: 210 руб.',
  'Гляссе': '🍨 Кофе с шариком мороженого! Цена: 190 руб.'
};

const categoryEmoji = {
  'Пиццы': '🍕',
  'Напитки': '🥤',
  'Десерты': '🍰',
  'Шаурма': '🌯',
  'Кофе': '☕'
};

// ========== УВЕДОМЛЕНИЕ МЕНЕДЖЕРУ ==========
async function notifyManager(orderNumber, total, customerName, itemsList, userId) {
  const itemsText = itemsList.map(item => {
    const modifiersText = item.modifiers?.length ? ` (${item.modifiers.join(', ')})` : '';
    return `• ${item.name}${modifiersText} — ${item.price} руб.`;
  }).join('\n');
  
  const message = `🆕 НОВЫЙ ЗАКАЗ в VK!\n\n📦 Заказ: ${orderNumber}\n👤 Клиент: ${customerName}\n🆔 VK ID: ${userId}\n💰 Сумма: ${total} руб.\n\nСостав заказа:\n${itemsText}\n\n⏰ Время: ${new Date().toLocaleString()}`;

  try {
    await fetch(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: MANAGER_CHAT_ID, 
        text: message,
        parse_mode: 'HTML'
      })
    });
    console.log(`📨 Уведомление менеджеру отправлено`);
  } catch (err) {
    console.error('Ошибка уведомления менеджера:', err);
  }
}

// ========== УВЕДОМЛЕНИЕ КЛИЕНТУ ==========
async function notifyCustomerVK(userId, message) {
  try {
    await vk.api.messages.send({
      user_id: userId,
      message: message,
      random_id: Math.floor(Math.random() * 1000000)
    });
    console.log(`📨 Уведомление клиенту ${userId} отправлено`);
  } catch (err) {
    console.error('Ошибка уведомления клиента:', err);
  }
}

// ========== ИСТОРИЯ ЗАКАЗОВ ==========
async function showOrderHistory(context, userId) {
  console.log(`📋 История заказов для ${userId}`);
  
  try {
    const [orders] = await pool.execute(
      `SELECT id, orderNumber, totalPrice, status, createdAt 
       FROM \`order\` 
       WHERE customerId = ? 
       ORDER BY createdAt DESC 
       LIMIT 10`,
      [userId.toString()]
    );
    
    if (orders.length === 0) {
      await context.send('📋 У вас пока нет заказов.');
      return;
    }
    
    let message = '📋 Ваши последние заказы:\n\n';
    const buttons = [];
    
    for (const order of orders) {
      const date = new Date(order.createdAt).toLocaleString();
      let statusText = '';
      if (order.status === 'NEW') statusText = '🕐 Принят';
      else if (order.status === 'READY') statusText = '✅ Готов';
      else if (order.status === 'CANCELLED') statusText = '❌ Отменён';
      else statusText = order.status;
      
      message += `📦 Заказ #${order.orderNumber}\n`;
      message += `   💰 ${order.totalPrice} руб. | ${date}\n`;
      message += `   Статус: ${statusText}\n\n`;
      
      buttons.push([{
        action: { type: 'text', label: `🔄 Повторить заказ #${order.orderNumber}` },
        color: 'primary'
      }]);
    }
    
    buttons.push([{
      action: { type: 'text', label: '🔙 Назад в меню' },
      color: 'secondary'
    }]);
    
    const keyboard = JSON.stringify({ one_time: false, buttons: buttons });
    
    await context.send(message, { keyboard: keyboard });
    
    userStates.set(`history_${userId}`, orders);
    
  } catch (err) {
    console.error('Ошибка истории:', err);
    await context.send('❌ Ошибка загрузки истории');
  }
}

async function repeatOrder(context, userId, orderNumber) {
  console.log(`🔄 Повтор заказа ${orderNumber}`);
  
  try {
    const [orders] = await pool.execute(
      `SELECT id FROM \`order\` WHERE orderNumber = ? AND customerId = ?`,
      [orderNumber, userId.toString()]
    );
    
    if (orders.length === 0) {
      await context.send('❌ Заказ не найден');
      return;
    }
    
    const [items] = await pool.execute(
      `SELECT itemId, itemName, itemPrice, modifiers, quantity 
       FROM order_item 
       WHERE orderId = ?`,
      [orders[0].id]
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
        price: Number(item.itemPrice),
        quantity: item.quantity,
        modifiers: modifiers
      });
    }
    
    carts.set(userId, cart);
    
    await context.send(`✅ Заказ #${orderNumber} повторён! Товары добавлены в корзину.`);
    await showCart(context);
    
  } catch (err) {
    console.error('Ошибка повтора:', err);
    await context.send('❌ Ошибка при повторении заказа');
  }
}

// ========== ОТСЛЕЖИВАНИЕ СТАТУСОВ ==========
async function checkStatusChanges() {
  try {
    const [orders] = await pool.execute(
      `SELECT id, orderNumber, customerId, status, notified 
       FROM \`order\` 
       WHERE status IN ('CONFIRMED', 'PREPARING', 'READY', 'CANCELLED')
       AND notified = 0`
    );
    
    for (const order of orders) {
      let message = '';
      let needKeyboard = false;
      
      if (order.status === 'CONFIRMED') {
        message = `✅ Заказ #${order.orderNumber} подтверждён!

Ожидайте начала приготовления.`;
        
      } else if (order.status === 'PREPARING') {
        message = `👨‍🍳 Заказ #${order.orderNumber} начали готовить!

Скоро будет готово.`;
        
      } else if (order.status === 'READY') {
        message = `🎉 Заказ #${order.orderNumber} готов!

Можете забирать в ресторане. Оплата при получении.

Хотите сделать еще заказ?`;
        needKeyboard = true;
        
      } else if (order.status === 'CANCELLED') {
        message = `❌ Заказ #${order.orderNumber} отменён.

Приносим извинения.`;
      }
      
      if (message) {
        if (needKeyboard) {
          const keyboard = JSON.stringify({
            one_time: true,
            buttons: [
              [{ action: { type: 'text', label: '✅ Да, хочу заказ' }, color: 'positive' }],
              [{ action: { type: 'text', label: '❌ Нет, спасибо' }, color: 'negative' }]
            ]
          });
          
          await vk.api.messages.send({
            user_id: order.customerId,
            message: message,
            keyboard: keyboard,
            random_id: Math.floor(Math.random() * 1000000)
          });
          
          userOrderStates.set(order.customerId, { waitingForResponse: true, orderNumber: order.orderNumber });
        } else {
          await vk.api.messages.send({
            user_id: order.customerId,
            message: message,
            random_id: Math.floor(Math.random() * 1000000)
          });
        }
        
        await pool.execute('UPDATE `order` SET notified = 1 WHERE id = ?', [order.id]);
      }
    }
  } catch (error) {
    console.error('Ошибка проверки статусов:', error);
  }
}

// ========== КЛАВИАТУРЫ ==========
function getMainMenuKeyboard(categories) {
  const buttons = [];
  let row = [];
  
  for (const cat of categories) {
    if (cat.isActive === false) continue;
    const emoji = categoryEmoji[cat.name] || '📋';
    row.push({
      action: { type: 'text', label: `${emoji} ${cat.name}` },
      color: 'primary'
    });
    if (row.length === 2) {
      buttons.push([...row]);
      row = [];
    }
  }
  if (row.length > 0) buttons.push(row);
  
  buttons.push([{ action: { type: 'text', label: '🛒 Моя корзина' }, color: 'secondary' }]);
  buttons.push([{ action: { type: 'text', label: '📋 Мои заказы' }, color: 'secondary' }]);
  
  return JSON.stringify({ one_time: false, buttons: buttons });
}

function getItemsKeyboard(items, categoryName) {
  const buttons = [];
  let row = [];
  
  const emoji = categoryEmoji[categoryName] || '🍽';
  
  for (const item of items) {
    let shortName = item.name;
    if (shortName.length > 25) {
      shortName = shortName.substring(0, 23) + '..';
    }
    row.push({
      action: { type: 'text', label: `${emoji} ${shortName}` },
      color: 'primary'
    });
    if (row.length === 2) {
      buttons.push([...row]);
      row = [];
    }
  }
  if (row.length > 0) buttons.push(row);
  
  buttons.push([{
    action: { type: 'text', label: '🔙 Назад в меню' },
    color: 'secondary'
  }]);
  
  return JSON.stringify({ one_time: false, buttons: buttons });
}

function getSizeKeyboard(sizes) {
  const buttons = [];
  for (const size of sizes) {
    const priceText = size.price > 0 ? ` +${size.price}₽` : '';
    buttons.push([{
      action: { type: 'text', label: `${size.name}${priceText}` },
      color: 'primary'
    }]);
  }
  buttons.push([{
    action: { type: 'text', label: '❌ Отмена' },
    color: 'negative'
  }]);
  
  return JSON.stringify({ one_time: true, buttons: buttons });
}

function getAdditiveKeyboard(additives, selectedIds) {
  const buttons = [];
  
  for (const add of additives) {
    const isSelected = selectedIds.includes(add.id);
    const prefix = isSelected ? '✅' : '➕';
    const priceText = add.price > 0 ? ` +${add.price}₽` : '';
    buttons.push([{
      action: { type: 'text', label: `${prefix} ${add.name}${priceText}` },
      color: 'secondary'
    }]);
  }
  
  buttons.push([{
    action: { type: 'text', label: '➡️ Далее' },
    color: 'positive'
  }]);
  buttons.push([{
    action: { type: 'text', label: '🔙 Назад к размеру' },
    color: 'secondary'
  }]);
  buttons.push([{
    action: { type: 'text', label: '❌ Отмена' },
    color: 'negative'
  }]);
  
  return JSON.stringify({ one_time: true, buttons: buttons });
}

function getSpicinessKeyboard(spicinessOptions) {
  const buttons = [];
  for (const spice of spicinessOptions) {
    buttons.push([{
      action: { type: 'text', label: spice.name },
      color: 'primary'
    }]);
  }
  buttons.push([{
    action: { type: 'text', label: '🔙 Назад к добавкам' },
    color: 'secondary'
  }]);
  buttons.push([{
    action: { type: 'text', label: '❌ Отмена' },
    color: 'negative'
  }]);
  
  return JSON.stringify({ one_time: true, buttons: buttons });
}

function getCartKeyboard() {
  return JSON.stringify({
    one_time: false,
    buttons: [
      [{ action: { type: 'text', label: '✅ Оформить заказ' }, color: 'positive' }],
      [{ action: { type: 'text', label: '🗑 Очистить корзину' }, color: 'negative' }],
      [{ action: { type: 'text', label: '🍕 Продолжить выбор' }, color: 'secondary' }]
    ]
  });
}

function getAfterAddKeyboard() {
  return JSON.stringify({
    one_time: true,
    buttons: [
      [{ action: { type: 'text', label: '🛒 Перейти в корзину' }, color: 'positive' }],
      [{ action: { type: 'text', label: '🍕 Продолжить выбор' }, color: 'primary' }]
    ]
  });
}

// ========== API ==========
async function apiGet(endpoint) {
  try {
    const res = await fetch(`${API_BASE_URL}${endpoint}`);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error(`API error:`, err.message);
    return [];
  }
}

async function getModifiersForItem(itemId) {
  try {
    const [rows] = await pool.execute(`
      SELECT m.*, im.maxSelect 
      FROM item_modifier im
      JOIN modifier m ON im.modifierId = m.id
      WHERE im.itemId = ? AND m.isAvailable = 1
      ORDER BY FIELD(m.type, 'SIZE', 'ADDITIVE', 'SPICINESS'), m.price
    `, [itemId]);
    
    return {
      size: rows.filter(m => m.type === 'SIZE'),
      additives: rows.filter(m => m.type === 'ADDITIVE'),
      spiciness: rows.filter(m => m.type === 'SPICINESS')
    };
  } catch (err) {
    console.error('Ошибка модификаторов:', err);
    return { size: [], additives: [], spiciness: [] };
  }
}

// ========== ОСНОВНЫЕ ФУНКЦИИ ==========
async function sendMainMenu(context) {
  const categories = await apiGet('/api/categories');
  
  if (!categories || categories.length === 0) {
    await context.send('🍕 Меню временно недоступно.');
    return;
  }
  
  const keyboard = getMainMenuKeyboard(categories);
  
  await context.send('🍕 Добро пожаловать!\n\nВыберите категорию:', { keyboard: keyboard });
}

async function sendItems(context, categoryId, categoryName) {
  const items = await apiGet(`/api/categories/${categoryId}/items`);
  
  if (!items || items.length === 0) {
    await context.send('В этой категории пока нет товаров.');
    await sendMainMenu(context);
    return;
  }
  
  const uniqueItems = [];
  const itemNames = new Set();
  for (const item of items) {
    if (!itemNames.has(item.name)) {
      itemNames.add(item.name);
      uniqueItems.push(item);
    }
  }
  
  const emoji = categoryEmoji[categoryName] || '📋';
  let message = `${emoji} ${categoryName}\n\n`;
  
  for (const item of uniqueItems) {
    const price = Number(item.price) || 0;
    const description = itemDescriptions[item.name] || item.description || 'Вкусное блюдо!';
    
    message += `🍽 ${item.name}\n`;
    message += `💰 ${price} руб.\n`;
    message += `📝 ${description}\n\n`;
  }
  
  message += `👇 Нажмите на кнопку с названием, чтобы заказать`;
  
  userStates.set(`items_${context.senderId}`, uniqueItems);
  
  const keyboard = getItemsKeyboard(uniqueItems, categoryName);
  
  await context.send(message, { keyboard: keyboard });
}

async function startItemSelection(context, userId, buttonText) {
  const items = userStates.get(`items_${userId}`);
  if (!items) {
    await context.send('❌ Выберите категорию сначала.');
    await sendMainMenu(context);
    return;
  }
  
  console.log(`🔍 Кнопка: "${buttonText}"`);
  
  let itemName = buttonText;
  
  // Убираем эмодзи
  const emojiPattern = /^[🍕🥤🍰🌯☕📋🍽]\s*/;
  itemName = itemName.replace(emojiPattern, '');
  itemName = itemName.replace(/[🍕🥤🍰🌯☕📋🍽]/g, '');
  itemName = itemName.trim();
  
  if (itemName.endsWith('..')) {
    itemName = itemName.slice(0, -2);
  }
  
  console.log(`🔍 Ищем: "${itemName}"`);
  console.log(`🔍 Доступно: ${items.map(i => i.name).join(', ')}`);
  
  let item = items.find(i => i.name === itemName);
  if (!item) {
    item = items.find(i => i.name.toLowerCase() === itemName.toLowerCase());
  }
  if (!item) {
    item = items.find(i => i.name.startsWith(itemName));
  }
  if (!item) {
    item = items.find(i => itemName.includes(i.name) || i.name.includes(itemName));
  }
  
  if (!item) {
    await context.send(`❌ Товар "${itemName}" не найден.`);
    return;
  }
  
  console.log(`✅ Найден: ${item.name}`);
  
  await addToCart(context, userId, {
    id: item.id,
    name: item.name,
    price: Number(item.price)
  });
}

async function addToCart(context, userId, itemData) {
  const modifiers = await getModifiersForItem(itemData.id);
  const hasSize = modifiers.size.length > 0;
  const hasAdditives = modifiers.additives.length > 0;
  const hasSpiciness = modifiers.spiciness.length > 0;
  
  if (!hasSize && !hasAdditives && !hasSpiciness) {
    const cart = carts.get(userId) || [];
    cart.push({
      id: itemData.id,
      name: itemData.name,
      price: Number(itemData.price),
      quantity: 1
    });
    carts.set(userId, cart);
    
    const keyboard = getAfterAddKeyboard();
    await context.send(`✅ ${itemData.name} добавлен!\n💰 ${Number(itemData.price).toFixed(0)} руб.`, { keyboard: keyboard });
    return;
  }
  
  let step = 'size';
  if (!hasSize && hasAdditives) step = 'additives';
  if (!hasSize && !hasAdditives && hasSpiciness) step = 'spiciness';
  
  userStates.set(`select_${userId}`, {
    item: itemData,
    selectedSize: null,
    selectedAdditives: [],
    selectedSpiciness: null,
    modifiers: modifiers,
    step: step
  });
  
  if (hasSize) {
    await showSizeOptions(context, userId);
  } else if (hasAdditives) {
    await showAdditiveOptions(context, userId);
  } else if (hasSpiciness) {
    await showSpicinessOptions(context, userId);
  }
}

async function showSizeOptions(context, userId) {
  const state = userStates.get(`select_${userId}`);
  if (!state) return;
  
  const sizes = state.modifiers.size;
  
  if (sizes.length === 0) {
    if (state.modifiers.additives.length > 0) {
      state.step = 'additives';
      userStates.set(`select_${userId}`, state);
      await showAdditiveOptions(context, userId);
    } else if (state.modifiers.spiciness.length > 0) {
      state.step = 'spiciness';
      userStates.set(`select_${userId}`, state);
      await showSpicinessOptions(context, userId);
    } else {
      await finalizeAddToCart(context, userId);
    }
    return;
  }
  
  const keyboard = getSizeKeyboard(sizes);
  await context.send(`🍕 ${state.item.name}\n\nВыберите размер:`, { keyboard: keyboard });
}

async function showAdditiveOptions(context, userId) {
  const state = userStates.get(`select_${userId}`);
  if (!state) return;
  
  const additives = state.modifiers.additives;
  
  if (additives.length === 0) {
    if (state.modifiers.spiciness.length > 0) {
      state.step = 'spiciness';
      userStates.set(`select_${userId}`, state);
      await showSpicinessOptions(context, userId);
    } else {
      await finalizeAddToCart(context, userId);
    }
    return;
  }
  
  let message = `${state.item.name}\n`;
  if (state.selectedSize) {
    message += `📏 ${state.selectedSize.name}\n`;
  }
  message += `\n🥤 Выберите добавки (можно несколько):\n\n`;
  
  for (const add of additives) {
    const isSelected = state.selectedAdditives.some(a => a.id === add.id);
    message += `${isSelected ? '✅' : '➕'} ${add.name}${add.price > 0 ? ` (+${add.price}₽)` : ''}\n`;
  }
  message += `\n👇 После выбора нажмите "Далее"`;
  
  const selectedIds = state.selectedAdditives.map(a => a.id);
  const keyboard = getAdditiveKeyboard(additives, selectedIds);
  
  await context.send(message, { keyboard: keyboard });
}

async function showSpicinessOptions(context, userId) {
  const state = userStates.get(`select_${userId}`);
  if (!state) return;
  
  const spicinessOptions = state.modifiers.spiciness;
  
  if (spicinessOptions.length === 0) {
    await finalizeAddToCart(context, userId);
    return;
  }
  
  let message = `${state.item.name}\n`;
  if (state.selectedSize) {
    message += `📏 ${state.selectedSize.name}\n`;
  }
  if (state.selectedAdditives.length > 0) {
    message += `🥗 Добавки: ${state.selectedAdditives.map(a => a.name).join(', ')}\n`;
  }
  message += `\n🌶️ Выберите остроту:`;
  
  const keyboard = getSpicinessKeyboard(spicinessOptions);
  
  await context.send(message, { keyboard: keyboard });
}

async function finalizeAddToCart(context, userId) {
  const state = userStates.get(`select_${userId}`);
  if (!state) return;
  
  let totalPrice = Number(state.item.price) || 0;
  const modifiersList = [];
  let priceBreakdown = `💰 ${state.item.price} руб. (базовая цена)`;
  
  if (state.selectedSize) {
    const sizePrice = Number(state.selectedSize.price) || 0;
    totalPrice += sizePrice;
    modifiersList.push(`${state.selectedSize.name} (+${sizePrice} руб.)`);
    priceBreakdown += `\n📏 ${state.selectedSize.name}: +${sizePrice} руб.`;
  }
  
  for (const add of state.selectedAdditives) {
    const addPrice = Number(add.price) || 0;
    totalPrice += addPrice;
    modifiersList.push(`${add.name} (+${addPrice} руб.)`);
    priceBreakdown += `\n🥗 ${add.name}: +${addPrice} руб.`;
  }
  
  if (state.selectedSpiciness) {
    const spicePrice = Number(state.selectedSpiciness.price) || 0;
    totalPrice += spicePrice;
    modifiersList.push(`${state.selectedSpiciness.name} (+${spicePrice} руб.)`);
    priceBreakdown += `\n🌶️ ${state.selectedSpiciness.name}: +${spicePrice} руб.`;
  }
  
  priceBreakdown += `\n\n━━━━━━━━━━━━━━━━━━━━\n💰 ИТОГО: ${totalPrice.toFixed(0)} руб.`;
  
  const cart = carts.get(userId) || [];
  cart.push({
    id: state.item.id,
    name: state.item.name,
    price: totalPrice,
    quantity: 1,
    modifiers: modifiersList
  });
  carts.set(userId, cart);
  
  userStates.delete(`select_${userId}`);
  
  const keyboard = getAfterAddKeyboard();
  
  await context.send(`✅ ${state.item.name} добавлен в корзину!\n\n${priceBreakdown}`, { keyboard: keyboard });
}

async function showCart(context) {
  const userId = context.senderId;
  const cart = carts.get(userId) || [];
  
  if (cart.length === 0) {
    const keyboard = JSON.stringify({
      one_time: true,
      buttons: [[{ action: { type: 'text', label: '🍕 Меню' }, color: 'primary' }]]
    });
    await context.send('🛒 Корзина пуста', { keyboard: keyboard });
    return;
  }
  
  let message = '🛒 ВАША КОРЗИНА:\n\n';
  let total = 0;
  
  cart.forEach((item, i) => {
    const price = Number(item.price) || 0;
    message += `${i+1}. ${item.name}\n`;
    if (item.modifiers && item.modifiers.length > 0) {
      message += `   📋 ${item.modifiers.join(', ')}\n`;
    }
    message += `   💰 ${price.toFixed(0)} руб.\n\n`;
    total += price;
  });
  message += `━━━━━━━━━━━━━━━━━━━━\n💰 ВСЕГО: ${total.toFixed(0)} руб.`;
  
  const keyboard = getCartKeyboard();
  
  await context.send(message, { keyboard: keyboard });
}

async function checkout(context, userId) {
  const cart = carts.get(userId) || [];
  if (cart.length === 0) {
    await context.send('🛒 Корзина пуста');
    return;
  }
  
  const total = cart.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  const orderNumber = `ORD${Date.now()}`;
  const customerName = `Пользователь ${userId}`;
  
  try {
    const [orderResult] = await pool.execute(
      `INSERT INTO \`order\` (orderNumber, customerId, customerName, totalPrice, status, createdAt, updatedAt, notified)
       VALUES (?, ?, ?, ?, 'NEW', NOW(), NOW(), 0)`,
      [orderNumber, userId.toString(), customerName, total]
    );
    const orderId = orderResult.insertId;
    
    for (const item of cart) {
      const modifiersJson = JSON.stringify(item.modifiers || []);
      await pool.execute(
        `INSERT INTO order_item (orderId, itemId, itemName, itemPrice, quantity, modifiers) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, item.id, item.name, Number(item.price), item.quantity || 1, modifiersJson]
      );
    }
    
    await notifyManager(orderNumber, total, customerName, cart, userId);
    
    // ТОЛЬКО ОДНО СООБЩЕНИЕ ПОСЛЕ ЗАКАЗА
    let itemsText = '';
    for (const item of cart) {
      itemsText += `${item.name}`;
      if (item.modifiers?.length) {
        itemsText += ` (${item.modifiers.join(', ')})`;
      }
      itemsText += ` — ${item.price.toFixed(0)} руб.\n`;
    }
    
    const message = `✅ Заказ #${orderNumber} принят!

📋 ${itemsText}
💰 Итого: ${total.toFixed(0)} руб.

⏰ Ваш заказ передан в заведение. Ожидайте подтверждения администратора.

Мы сообщим, когда заказ будет готов.`;

    await context.send(message);
    
    carts.delete(userId);
    
  } catch (err) {
    console.error('Ошибка заказа:', err);
    await context.send('❌ Ошибка оформления заказа. Попробуйте позже.');
  }
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ==========
function parseSizeSelection(text, sizes) {
  for (const size of sizes) {
    if (text.includes(size.name)) {
      return size;
    }
  }
  return null;
}

function parseAdditiveSelection(text, additives) {
  for (const add of additives) {
    if (text.includes(add.name)) {
      return add;
    }
  }
  return null;
}

function parseSpicinessSelection(text, spicinessOptions) {
  for (const spice of spicinessOptions) {
    if (text.includes(spice.name)) {
      return spice;
    }
  }
  return null;
}

// ========== ЗАПУСК ==========
setInterval(checkStatusChanges, 10000);

vk.updates.startPolling().catch(err => console.error('Ошибка:', err));

vk.updates.on('message_new', async (context) => {
  if (context.isOutbox) return;
  
  const userId = context.senderId;
  const text = context.text || '';
  
  console.log(`📨 [${userId}] "${text}"`);
  
  try {
    const waitingState = userOrderStates.get(userId);
    if (waitingState?.waitingForResponse) {
      if (text === '✅ Да, хочу сделать заказ') {
        userOrderStates.delete(userId);
        await sendMainMenu(context);
      } else if (text === '❌ Нет, спасибо') {
        userOrderStates.delete(userId);
        await context.send('✨ Спасибо за заказ! Будем рады видеть вас снова! ✨');
      }
      return;
    }
    
    if (text === '/start' || text === '/menu' || text === 'Начать' || 
        text === '🍕 Продолжить выбор' || text === '🔙 Назад в меню' ||
        text === '🍕 Открыть меню' || text === 'Открыть меню' || text === '🍕 Меню') {
      await sendMainMenu(context);
      return;
    }
    
    if (text === '/cart' || text === 'корзина' || text === '🛒 Моя корзина' || text === '🛒 Перейти в корзину') {
      await showCart(context);
      return;
    }
    
    if (text === '✅ Оформить заказ') {
      await checkout(context, userId);
      return;
    }
    
    if (text === '📋 Мои заказы' || text === '/history') {
      await showOrderHistory(context, userId);
      return;
    }
    
    if (text.startsWith('🔄 Повторить заказ #')) {
      const orderNumber = text.replace('🔄 Повторить заказ #', '');
      await repeatOrder(context, userId, orderNumber);
      return;
    }
    
    if (text === '/clear' || text === 'очистить' || text === '🗑 Очистить корзину') {
      carts.delete(userId);
      userStates.delete(`items_${userId}`);
      userStates.delete(`select_${userId}`);
      await context.send('🗑 Корзина очищена');
      await sendMainMenu(context);
      return;
    }
    
    const categories = await apiGet('/api/categories');
    for (const cat of categories) {
      const categoryLabel = `${categoryEmoji[cat.name] || '📋'} ${cat.name}`;
      if (text === categoryLabel || text === cat.name) {
        await sendItems(context, cat.id, cat.name);
        return;
      }
    }
    
    const categoryEmojis = ['🍕', '🥤', '🍰', '🌯', '☕', '📋', '🍽'];
    const isProductButton = categoryEmojis.some(emoji => text.startsWith(emoji)) && 
                           !text.includes('Назад') && 
                           !text.includes('Корзина') &&
                           !text.includes('Продолжить') &&
                           !text.includes('Открыть') &&
                           !text.includes('Меню') &&
                           !text.includes('Оформить') &&
                           !text.includes('Мои заказы');
    
    if (isProductButton) {
      await startItemSelection(context, userId, text);
      return;
    }
    
    const state = userStates.get(`select_${userId}`);
    
    if (state) {
      if (state.step === 'size') {
        const selectedSize = parseSizeSelection(text, state.modifiers.size);
        if (selectedSize) {
          state.selectedSize = selectedSize;
          if (state.modifiers.additives.length > 0) {
            state.step = 'additives';
            userStates.set(`select_${userId}`, state);
            await showAdditiveOptions(context, userId);
          } else if (state.modifiers.spiciness.length > 0) {
            state.step = 'spiciness';
            userStates.set(`select_${userId}`, state);
            await showSpicinessOptions(context, userId);
          } else {
            await finalizeAddToCart(context, userId);
          }
          return;
        }
      }
      
      if (state.step === 'additives') {
        if (text === '➡️ Далее') {
          if (state.modifiers.spiciness.length > 0) {
            state.step = 'spiciness';
            userStates.set(`select_${userId}`, state);
            await showSpicinessOptions(context, userId);
          } else {
            await finalizeAddToCart(context, userId);
          }
          return;
        }
        
        if (text === '🔙 Назад к размеру') {
          state.selectedSize = null;
          state.step = 'size';
          userStates.set(`select_${userId}`, state);
          await showSizeOptions(context, userId);
          return;
        }
        
        const selectedAdditive = parseAdditiveSelection(text, state.modifiers.additives);
        if (selectedAdditive) {
          const existing = state.selectedAdditives.find(a => a.id === selectedAdditive.id);
          if (existing) {
            state.selectedAdditives = state.selectedAdditives.filter(a => a.id !== selectedAdditive.id);
            await context.send(`❌ ${selectedAdditive.name} убран`);
          } else {
            state.selectedAdditives.push(selectedAdditive);
            await context.send(`✅ ${selectedAdditive.name} добавлен`);
          }
          userStates.set(`select_${userId}`, state);
          await showAdditiveOptions(context, userId);
          return;
        }
      }
      
      if (state.step === 'spiciness') {
        if (text === '🔙 Назад к добавкам') {
          state.step = 'additives';
          userStates.set(`select_${userId}`, state);
          await showAdditiveOptions(context, userId);
          return;
        }
        
        const selectedSpiciness = parseSpicinessSelection(text, state.modifiers.spiciness);
        if (selectedSpiciness) {
          state.selectedSpiciness = selectedSpiciness;
          userStates.set(`select_${userId}`, state);
          await finalizeAddToCart(context, userId);
          return;
        }
      }
      
      if (text === '❌ Отмена') {
        userStates.delete(`select_${userId}`);
        await context.send('❌ Выбор отменён');
        await sendMainMenu(context);
        return;
      }
    }
    
    const unknownKeyboard = JSON.stringify({
      one_time: true,
      buttons: [[{ action: { type: 'text', label: '🍕 Открыть меню' }, color: 'primary' }]]
    });
    await context.send('❓ Неизвестная команда. Нажмите кнопку:', { keyboard: unknownKeyboard });
    
  } catch(err) {
    console.error('❌ Ошибка:', err);
    await context.send(`❌ Ошибка: ${err.message}`);
  }
});

console.log('🤖 VK Бот запущен!');
console.log('📌 Команды: /start, /menu, /cart, /history');