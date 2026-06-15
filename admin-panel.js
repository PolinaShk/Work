const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3001;

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'restaurant_bot',
  waitForConnections: true,
  connectionLimit: 10,
});

app.use(express.json());
app.use(express.static('public'));

// ========== НАСТРОЙКИ ЗАГРУЗКИ ФОТО ==========
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// ========== ПРОДУКТЫ ==========
app.get('/api/products', async (req, res) => {
  try {
    const [products] = await pool.execute('SELECT * FROM product WHERE isActive = 1 ORDER BY `order`');
    res.json(products);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки продуктов' });
  }
});

app.get('/api/products/:id/categories', async (req, res) => {
  const productId = req.params.id;
  try {
    const [categories] = await pool.execute(
      'SELECT * FROM category WHERE productId = ? AND isActive = 1 ORDER BY `order`',
      [productId]
    );
    res.json(categories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки категорий' });
  }
});

app.get('/api/categories/:id/items', async (req, res) => {
  const categoryId = req.params.id;
  try {
    const [items] = await pool.execute(
      'SELECT * FROM item WHERE categoryId = ? AND isAvailable = 1 ORDER BY name',
      [categoryId]
    );
    res.json(items);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки товаров' });
  }
});

app.get('/api/items/:id/modifiers', async (req, res) => {
  const itemId = req.params.id;
  try {
    const [modifiers] = await pool.execute(`
      SELECT m.*, im.maxSelect 
      FROM item_modifier im
      JOIN modifier m ON im.modifierId = m.id
      WHERE im.itemId = ? AND m.isAvailable = 1
    `, [itemId]);
    
    const result = {
      size: modifiers.filter(m => m.type === 'SIZE'),
      additives: modifiers.filter(m => m.type === 'ADDITIVE'),
      spiciness: modifiers.filter(m => m.type === 'SPICINESS')
    };
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки модификаторов' });
  }
});

// ========== ЗАКАЗЫ ==========
app.get('/api/orders', async (req, res) => {
  try {
    const [orders] = await pool.execute(`
      SELECT o.*, 
        (SELECT COUNT(*) FROM order_item WHERE orderId = o.id) as itemsCount
      FROM \`order\` o 
      ORDER BY 
        FIELD(o.status, 'NEW', 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'CANCELLED'),
        o.createdAt DESC
    `);
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки заказов' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const [order] = await pool.execute('SELECT * FROM `order` WHERE id = ?', [req.params.id]);
    const [items] = await pool.execute('SELECT * FROM order_item WHERE orderId = ?', [req.params.id]);
    res.json({ order: order[0], items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки деталей' });
  }
});

app.put('/api/orders/:id/status', async (req, res) => {
  const { status, comment } = req.body;
  try {
    await pool.execute(
      'UPDATE `order` SET status = ?, updatedAt = NOW() WHERE id = ?',
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления статуса' });
  }
});

app.post('/api/orders/:id/cancel', async (req, res) => {
  const { reason } = req.body;
  try {
    await pool.execute(
      'UPDATE `order` SET status = "CANCELLED", updatedAt = NOW() WHERE id = ?',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка отмены заказа' });
  }
});

app.post('/api/orders/:id/suggest', async (req, res) => {
  const { orderId, customerId, orderNumber, originalItemName, suggestedItemName, message } = req.body;
  try {
    await pool.execute(
      `INSERT INTO suggestions (orderId, orderNumber, customerId, originalItemName, suggestedModifierName, message, status) 
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [orderId, orderNumber, customerId, originalItemName, suggestedItemName, message]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка отправки предложения' });
  }
});

app.get('/api/orders/:id/unavailable', async (req, res) => {
  try {
    const [order] = await pool.execute('SELECT unavailableItems FROM `order` WHERE id = ?', [req.params.id]);
    const unavailable = order[0]?.unavailableItems ? JSON.parse(order[0].unavailableItems) : [];
    res.json({ unavailable });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// ========== КАТЕГОРИИ ==========
app.get('/api/categories', async (req, res) => {
  try {
    const [categories] = await pool.execute('SELECT * FROM category ORDER BY `order`');
    res.json(categories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.post('/api/categories', async (req, res) => {
  const { name, description, order, productId } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO category (name, description, `order`, productId) VALUES (?, ?, ?, ?)',
      [name, description, order || 0, productId || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка создания' });
  }
});

app.put('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, order, isActive, productId } = req.body;
  try {
    await pool.execute(
      'UPDATE category SET name = ?, description = ?, `order` = ?, isActive = ?, productId = ? WHERE id = ?',
      [name, description, order, isActive, productId, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.execute('DELETE FROM category WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ========== ТОВАРЫ ==========
app.get('/api/items', async (req, res) => {
  try {
    const [items] = await pool.execute('SELECT * FROM item ORDER BY categoryId, name');
    res.json(items);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.post('/api/items', async (req, res) => {
  const { name, price, categoryId, description, composition, isAvailable } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO item (name, price, categoryId, description, composition, isAvailable) VALUES (?, ?, ?, ?, ?, ?)',
      [name, price, categoryId, description || null, composition || null, isAvailable ? 1 : 0]
    );
    res.json({ success: true, id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка создания' });
  }
});

app.put('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price, categoryId, description, composition, isAvailable } = req.body;
  try {
    await pool.execute(
      'UPDATE item SET name = ?, price = ?, categoryId = ?, description = ?, composition = ?, isAvailable = ? WHERE id = ?',
      [name, price, categoryId, description || null, composition || null, isAvailable ? 1 : 0, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.execute('DELETE FROM item WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

app.post('/api/items/:id/upload', upload.single('photo'), async (req, res) => {
  const itemId = req.params.id;
  const imageUrl = `/uploads/${req.file.filename}`;
  try {
    await pool.execute('UPDATE item SET imageUrl = ? WHERE id = ?', [imageUrl, itemId]);
    res.json({ success: true, imageUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// ========== СТОП-ЛИСТ ==========
app.get('/api/stoplist', async (req, res) => {
  try {
    const [items] = await pool.execute(`
      SELECT i.*, c.name as categoryName 
      FROM item i
      JOIN category c ON i.categoryId = c.id
      ORDER BY c.name, i.name
    `);
    res.json(items);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.patch('/api/stoplist/:id/toggle', async (req, res) => {
  const itemId = req.params.id;
  try {
    const [item] = await pool.execute('SELECT isAvailable FROM item WHERE id = ?', [itemId]);
    const newStatus = item[0].isAvailable ? 0 : 1;
    await pool.execute('UPDATE item SET isAvailable = ? WHERE id = ?', [newStatus, itemId]);
    res.json({ success: true, isAvailable: newStatus });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

// ========== МОДИФИКАТОРЫ ==========
app.get('/api/modifiers', async (req, res) => {
  try {
    const [modifiers] = await pool.execute(`
      SELECT * FROM modifier ORDER BY FIELD(type, 'ADDITIVE', 'SIZE', 'SPICINESS'), name
    `);
    res.json(modifiers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.post('/api/modifiers', async (req, res) => {
  const { name, type, price, isRequired } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO modifier (name, type, price, isRequired, isAvailable) VALUES (?, ?, ?, ?, 1)',
      [name, type, price, isRequired]
    );
    res.json({ success: true, id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка создания' });
  }
});

app.put('/api/modifiers/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, price, isRequired } = req.body;
  try {
    await pool.execute(
      'UPDATE modifier SET name = ?, type = ?, price = ?, isRequired = ? WHERE id = ?',
      [name, type, price, isRequired, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

app.patch('/api/modifiers/:id/toggle', async (req, res) => {
  const modifierId = req.params.id;
  try {
    const [modifier] = await pool.execute('SELECT isAvailable FROM modifier WHERE id = ?', [modifierId]);
    const newStatus = modifier[0].isAvailable ? 0 : 1;
    await pool.execute('UPDATE modifier SET isAvailable = ? WHERE id = ?', [newStatus, modifierId]);
    res.json({ success: true, isAvailable: newStatus });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

app.delete('/api/modifiers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.execute('DELETE FROM modifier WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ========== НАСТРОЙКИ ==========
app.get('/api/settings', async (req, res) => {
  try {
    const [settings] = await pool.execute('SELECT * FROM settings');
    const result = {};
    for (const s of settings) {
      try {
        result[s.key] = JSON.parse(s.value);
      } catch (e) {
        result[s.key] = s.value;
      }
    }
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки настроек' });
  }
});

app.put('/api/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  try {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    await pool.execute(
      'INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE value = ?, updatedAt = NOW()',
      [key, stringValue, stringValue]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка сохранения настроек' });
  }
});

// ========== ПОЛЬЗОВАТЕЛИ ==========
app.get('/api/users', async (req, res) => {
  try {
    const [users] = await pool.execute('SELECT id, email, name, phone, role, isActive, createdAt FROM users ORDER BY createdAt DESC');
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

app.post('/api/users', async (req, res) => {
  const { email, password, name, phone, role } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.execute(
      'INSERT INTO users (email, password, name, phone, role, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())',
      [email, hashedPassword, name, phone, role]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка создания пользователя' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, role, isActive } = req.body;
  try {
    await pool.execute(
      'UPDATE users SET name = ?, phone = ?, role = ?, isActive = ?, updatedAt = NOW() WHERE id = ?',
      [name, phone, role, isActive, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления пользователя' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ========== АНАЛИТИКА ==========
app.get('/api/analytics', async (req, res) => {
  try {
    const [totalOrders] = await pool.execute('SELECT COUNT(*) as count, SUM(totalPrice) as total FROM `order`');
    const [todayOrders] = await pool.execute('SELECT COUNT(*) as count, SUM(totalPrice) as total FROM `order` WHERE DATE(createdAt) = CURDATE()');
    const [weekOrders] = await pool.execute('SELECT COUNT(*) as count, SUM(totalPrice) as total FROM `order` WHERE YEARWEEK(createdAt) = YEARWEEK(NOW())');
    const [popularItems] = await pool.execute(`
      SELECT oi.itemName, SUM(oi.quantity) as totalCount, SUM(oi.itemPrice * oi.quantity) as totalRevenue
      FROM order_item oi
      GROUP BY oi.itemName
      ORDER BY totalCount DESC
      LIMIT 10
    `);
    const [ordersByHour] = await pool.execute(`
      SELECT HOUR(createdAt) as hour, COUNT(*) as count 
      FROM \`order\` 
      WHERE DATE(createdAt) = CURDATE() 
      GROUP BY HOUR(createdAt)
    `);
    
    res.json({
      total: { count: totalOrders[0]?.count || 0, total: totalOrders[0]?.total || 0 },
      today: { count: todayOrders[0]?.count || 0, total: todayOrders[0]?.total || 0 },
      week: { count: weekOrders[0]?.count || 0, total: weekOrders[0]?.total || 0 },
      popularItems: popularItems || [],
      ordersByHour: ordersByHour || []
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки аналитики' });
  }
});

// ========== HTML СТРАНИЦА ==========
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Админ-панель ресторана</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { color: #333; margin-bottom: 20px; text-align: center; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
        .status-NEW { background: #ff9800; color: #fff; }
        .status-PENDING { background: #ff5722; color: #fff; }
        .status-CONFIRMED { background: #2196f3; color: #fff; }
        .status-PREPARING { background: #9c27b0; color: #fff; }
        .status-READY { background: #4caf50; color: #fff; }
        .status-CANCELLED { background: #f44336; color: #fff; }
        .orders-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 20px; }
        .order-card { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .order-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #eee; }
        .order-number { font-weight: bold; font-size: 16px; }
        .order-time { font-size: 12px; color: #666; margin-bottom: 10px; }
        .order-items { margin: 10px 0; padding-left: 15px; }
        .order-item { font-size: 13px; margin: 5px 0; }
        .order-total { font-weight: bold; text-align: right; margin: 10px 0; padding-top: 10px; border-top: 1px solid #eee; }
        .order-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        button { padding: 8px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; transition: all 0.3s; }
        button:hover { opacity: 0.8; transform: scale(0.98); }
        .btn-confirm { background: #2196f3; color: white; }
        .btn-prepare { background: #9c27b0; color: white; }
        .btn-ready { background: #4caf50; color: white; }
        .btn-cancel { background: #f44336; color: white; }
        .btn-suggest { background: #ff9800; color: white; }
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .tab { padding: 10px 20px; background: #ddd; border-radius: 8px; cursor: pointer; }
        .tab.active { background: #333; color: white; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: white; padding: 20px; border-radius: 12px; max-width: 400px; width: 90%; }
        .modal-content select, .modal-content input, .modal-content textarea { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 6px; }
        .refresh-btn { background: #333; color: white; padding: 10px 20px; margin-bottom: 20px; cursor: pointer; border: none; border-radius: 8px; }
        .status-select { padding: 5px; border-radius: 6px; border: 1px solid #ddd; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📋 Админ-панель ресторана</h1>
        
        <div class="tabs">
            <div class="tab active" onclick="filterOrders('all')">Все заказы</div>
            <div class="tab" onclick="filterOrders('NEW')">🆕 Новые</div>
            <div class="tab" onclick="filterOrders('PENDING')">⏳ Ожидают</div>
            <div class="tab" onclick="filterOrders('CONFIRMED')">✅ Подтверждены</div>
            <div class="tab" onclick="filterOrders('PREPARING')">👨‍🍳 Готовятся</div>
            <div class="tab" onclick="filterOrders('READY')">🎉 Готовы</div>
            <div class="tab" onclick="filterOrders('CANCELLED')">❌ Отменены</div>
        </div>
        
        <button class="refresh-btn" onclick="loadOrders()">🔄 Обновить</button>
        
        <div id="orders-container" class="orders-grid"></div>
    </div>
    
    <div id="modal" class="modal">
        <div class="modal-content">
            <h3 id="modal-title">Действие с заказом</h3>
            <div id="modal-body"></div>
            <button onclick="closeModal()" style="margin-top:10px;">Отмена</button>
        </div>
    </div>

    <script>
        let currentOrders = [];
        let currentFilter = 'all';
        
        async function loadOrders() {
            try {
                const res = await fetch('/api/orders');
                currentOrders = await res.json();
                renderOrders();
            } catch(e) {
                console.error('Ошибка загрузки заказов:', e);
            }
        }
        
        function filterOrders(status) {
            currentFilter = status;
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            event.target.classList.add('active');
            renderOrders();
        }
        
        function getFilteredOrders() {
            if (currentFilter === 'all') return currentOrders;
            return currentOrders.filter(o => o.status === currentFilter);
        }
        
        async function renderOrders() {
            const container = document.getElementById('orders-container');
            const orders = getFilteredOrders();
            
            if (!orders || orders.length === 0) {
                container.innerHTML = '<p style="text-align:center">Нет заказов</p>';
                return;
            }
            
            container.innerHTML = '';
            
            for (const order of orders) {
                const statusText = {
                    'NEW': '🆕 Новый',
                    'PENDING': '⏳ Ожидает',
                    'CONFIRMED': '✅ Подтверждён',
                    'PREPARING': '👨‍🍳 Готовится',
                    'READY': '🎉 Готов',
                    'CANCELLED': '❌ Отменён'
                }[order.status] || order.status;
                
                const card = document.createElement('div');
                card.className = 'order-card';
                card.setAttribute('data-id', order.id);
                card.innerHTML = 
                    '<div class="order-header">' +
                        '<span class="order-number">📦 ' + order.orderNumber + '</span>' +
                        '<span class="status-badge status-' + order.status + '">' + statusText + '</span>' +
                    '</div>' +
                    '<div class="order-time">🕐 ' + new Date(order.createdAt).toLocaleString() + '</div>' +
                    '<div class="order-items" id="items-' + order.id + '">Загрузка...</div>' +
                    '<div class="order-total">💰 ' + order.totalPrice + ' руб.</div>' +
                    '<div class="order-actions" id="actions-' + order.id + '"></div>';
                
                container.appendChild(card);
                await loadOrderItems(order.id);
                renderOrderActions(order);
            }
        }
        
        async function loadOrderItems(orderId) {
            try {
                const res = await fetch('/api/orders/' + orderId);
                const data = await res.json();
                const container = document.getElementById('items-' + orderId);
                if (container && data.items) {
                    let html = '';
                    for (const item of data.items) {
                        html += '<div class="order-item">🍽 ' + item.itemName + ' x' + item.quantity + ' — ' + item.itemPrice + ' руб.</div>';
                    }
                    container.innerHTML = html;
                }
            } catch(e) {
                console.error('Ошибка загрузки позиций:', e);
            }
        }
        
        function renderOrderActions(order) {
            const container = document.getElementById('actions-' + order.id);
            if (!container) return;
            
            let buttonsHtml = '';
            
            if (order.status === 'NEW') {
                buttonsHtml = 
                    '<button class="btn-confirm" onclick="updateStatus(' + order.id + ', \'CONFIRMED\')">✅ Подтвердить</button>' +
                    '<button class="btn-suggest" onclick="showSuggestModal(' + order.id + ')">🔄 Предложить замену</button>' +
                    '<button class="btn-cancel" onclick="showCancelModal(' + order.id + ')">❌ Отменить</button>';
            } else if (order.status === 'CONFIRMED') {
                buttonsHtml = 
                    '<button class="btn-prepare" onclick="updateStatus(' + order.id + ', \'PREPARING\')">👨‍🍳 Начать готовить</button>' +
                    '<button class="btn-cancel" onclick="showCancelModal(' + order.id + ')">❌ Отменить</button>';
            } else if (order.status === 'PREPARING') {
                buttonsHtml = 
                    '<button class="btn-ready" onclick="updateStatus(' + order.id + ', \'READY\')">🎉 Завершить готовку</button>' +
                    '<button class="btn-cancel" onclick="showCancelModal(' + order.id + ')">❌ Отменить</button>';
            } else if (order.status === 'READY') {
                buttonsHtml = '<span style="color:green">✅ Заказ готов</span>';
            } else if (order.status === 'CANCELLED') {
                buttonsHtml = '<span style="color:red">❌ Заказ отменён</span>';
            }
            
            container.innerHTML = buttonsHtml;
        }
        
        async function updateStatus(orderId, status) {
            const statusNames = {
                'CONFIRMED': 'подтвердить',
                'PREPARING': 'начать готовить',
                'READY': 'завершить готовку'
            };
            
            if (confirm('Вы уверены, что хотите ' + (statusNames[status] || status) + ' заказ?')) {
                try {
                    await fetch('/api/orders/' + orderId + '/status', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: status })
                    });
                    loadOrders();
                } catch(e) {
                    alert('Ошибка при обновлении статуса');
                }
            }
        }
        
        function showCancelModal(orderId) {
            const modal = document.getElementById('modal');
            const modalBody = document.getElementById('modal-body');
            modalBody.innerHTML = 
                '<label>Причина отмены:</label>' +
                '<select id="cancel-reason">' +
                    '<option value="Товар недоступен">Товар недоступен</option>' +
                    '<option value="Слишком много заказов">Слишком много заказов</option>' +
                    '<option value="Технические проблемы">Технические проблемы</option>' +
                    '<option value="Ресторан закрыт">Ресторан закрыт</option>' +
                    '<option value="Другое">Другое</option>' +
                '</select>' +
                '<input type="text" id="cancel-custom-reason" placeholder="Если другое, укажите причину...">' +
                '<button onclick="cancelOrder(' + orderId + ')">Подтвердить отмену</button>';
            document.getElementById('modal-title').innerText = 'Отмена заказа';
            modal.style.display = 'flex';
        }
        
        function showSuggestModal(orderId) {
            const modal = document.getElementById('modal');
            const modalBody = document.getElementById('modal-body');
            modalBody.innerHTML = 
                '<label>Недоступный товар:</label>' +
                '<input type="text" id="suggest-original" placeholder="Название товара">' +
                '<label>Предложить вместо:</label>' +
                '<input type="text" id="suggest-replacement" placeholder="Предложение замены">' +
                '<label>Сообщение клиенту:</label>' +
                '<textarea id="suggest-message" rows="3" placeholder="Напишите сообщение клиенту..."></textarea>' +
                '<button onclick="sendSuggestion(' + orderId + ')">Отправить предложение</button>';
            document.getElementById('modal-title').innerText = 'Предложение замены';
            modal.style.display = 'flex';
        }
        
        async function cancelOrder(orderId) {
            let reason = document.getElementById('cancel-reason')?.value;
            const customReason = document.getElementById('cancel-custom-reason')?.value;
            if (customReason) reason = customReason;
            
            try {
                await fetch('/api/orders/' + orderId + '/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: reason })
                });
                closeModal();
                loadOrders();
            } catch(e) {
                alert('Ошибка при отмене заказа');
            }
        }
        
        async function sendSuggestion(orderId) {
            const originalItem = document.getElementById('suggest-original')?.value;
            const suggestedItem = document.getElementById('suggest-replacement')?.value;
            const message = document.getElementById('suggest-message')?.value;
            
            if (!originalItem || !suggestedItem) {
                alert('Заполните все поля');
                return;
            }
            
            try {
                await fetch('/api/orders/' + orderId + '/suggest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        orderId: orderId,
                        originalItemName: originalItem,
                        suggestedItemName: suggestedItem,
                        message: message || 'Вместо ' + originalItem + ' предлагаем ' + suggestedItem
                    })
                });
                closeModal();
                alert('Предложение отправлено клиенту');
            } catch(e) {
                alert('Ошибка при отправке предложения');
            }
        }
        
        function closeModal() {
            document.getElementById('modal').style.display = 'none';
        }
        
        loadOrders();
        setInterval(loadOrders, 15000);
    </script>
</body>
</html>
  `);
});

// ========== ЗАПУСК ==========
app.listen(port, () => {
  console.log(`📊 Админ-панель запущена на http://127.0.0.1:${port}`);
  console.log(`   - Заказы: http://127.0.0.1:${port}/`);
  console.log(`   - Стоп-лист: http://127.0.0.1:${port}/stoplist.html`);
  console.log(`   - Модификаторы: http://127.0.0.1:${port}/modifiers.html`);
  console.log(`   - Настройки: http://127.0.0.1:${port}/settings.html`);
  console.log(`   - Пользователи: http://127.0.0.1:${port}/users.html`);
  console.log(`   - Аналитика: http://127.0.0.1:${port}/analytics.html`);
});