const { VK } = require('vk-io');
require('dotenv').config();

const vk = new VK({
    token: process.env.VK_TOKEN,
    apiVersion: '5.131'
});

let lastMessageId = null;

vk.updates.startPolling().catch(err => console.error(err));

vk.updates.on('message_new', async (context) => {
    // Проверяем по ID сообщения
    if (lastMessageId === context.id) {
        console.log('⏩ Дубликат, пропускаем');
        return;
    }
    
    // Проверяем, что сообщение не от бота
    if (context.peerId === context.senderId) {
        console.log('⏩ Сообщение от самого себя, пропускаем');
        return;
    }
    
    lastMessageId = context.id;
    
    console.log(`📨 [${context.senderId}]: ${context.text}`);
    
    try {
        await context.send(`🍕 Бот работает!`);
        console.log(`✅ Ответ отправлен`);
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
    }
});

console.log('🤖 Бот запущен');