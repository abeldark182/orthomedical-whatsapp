require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xmlrpc = require('xmlrpc');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

const VERIFY_TOKEN = "orthomedical_token_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// CORRECCIÓN 1: Limpiar la URL de Odoo para extraer solo el host
const rawOdooUrl = process.env.ODOO_URL || "";
const cleanOdooHost = rawOdooUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
const db = process.env.ODOO_DB;
const username = process.env.ODOO_USER;
const password = process.env.ODOO_PASSWORD;

const clientCommon = xmlrpc.createSecureClient({ host: cleanOdooHost, port: 443, path: '/xmlrpc/2/common' });
const clientObject = xmlrpc.createSecureClient({ host: cleanOdooHost, port: 443, path: '/xmlrpc/2/object' });

// --- LÓGICA DE STOCK EN ODOO (Sin cambios) ---
async function getOdooStock(productQuery) {
    return new Promise((resolve) => {
        clientCommon.methodCall('authenticate', [db, username, password, {}], (err, uid) => {
            if (err || !uid) return resolve("Error de conexión al ERP.");
            clientObject.methodCall('execute_kw', [db, uid, password, 'product.product', 'search_read',
                [[['name', 'ilike', productQuery]]], { fields: ['id', 'name'], limit: 1 }
            ], (err, products) => {
                if (err || !products || products.length === 0) return resolve("Producto no encontrado.");
                const productId = products[0].id;
                const productName = products[0].name;
                
                clientObject.methodCall('execute_kw', [db, uid, password, 'stock.quant', 'search_read',
                    [[['product_id', '=', productId]]], { fields: ['location_id', 'quantity', 'reserved_quantity'] }
                ], (err, stockData) => {
                    if (err || !stockData) return resolve(`Sin datos de stock para ${productName}.`);
                    let stockMsg = `Datos del ERP para ${productName}:\n`;
                    let totalAvailable = 0;
                    stockData.forEach(s => {
                        const available = s.quantity - s.reserved_quantity;
                        if(available > 0) {
                            stockMsg += `- Ubicación ${s.location_id[1]}: ${available} unid.\n`;
                            totalAvailable += available;
                        }
                    });
                    if (totalAvailable === 0) return resolve(`Producto: ${productName}. Stock: 0.`);
                    resolve(stockMsg);
                });
            });
        });
    });
}

// LÓGICA PARA VISUALIZAR MENSAJES EN ODOO (MÓDULO CONVERSACIONES)
async function logMessageToOdoo(phone, text, senderName) {
    return new Promise((resolve) => {
        clientCommon.methodCall('authenticate', [db, username, password, {}], (err, uid) => {
            if (err || !uid) return resolve(false);

            const channelName = `WhatsApp: ${phone}`;
            
            // 1. Buscar si ya existe el chat para este número
            clientObject.methodCall('execute_kw', [db, uid, password, 'discuss.channel', 'search',
                [[['name', '=', channelName]]]
            ], (err, channels) => {
                let channelId;
                
                const postMessage = (chId) => {
                    const body = `<b>${senderName}:</b> ${text}`;
                    clientObject.methodCall('execute_kw', [db, uid, password, 'mail.message', 'create',
                        [{ model: 'discuss.channel', res_id: chId, body: body, message_type: 'comment' }]
                    ], () => resolve(true));
                };

                if (channels && channels.length > 0) {
                    postMessage(channels[0]); // Usar canal existente
                } else {
                    // 2. Crear un canal nuevo si es la primera vez que escribe
                    clientObject.methodCall('execute_kw', [db, uid, password, 'discuss.channel', 'create',
                        [{ name: channelName, channel_type: 'chat' }]
                    ], (err, newChannelId) => {
                        if (newChannelId) postMessage(newChannelId);
                        else resolve(false);
                    });
                }
            });
        });
    });
}

// --- GEMINI LÓGICA ---
async function getGeminiResponse(userMessage, stockInfo) {
    const systemPrompt = `Eres el asistente virtual experto de Orthomedical A&R S.A.C. ... (mantén tu prompt) ... Info ERP: [${stockInfo}]`;
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: userMessage,
            config: { systemInstruction: systemPrompt }
        });
        return response.text;
    } catch (error) {
        return "Lo siento, nuestros servidores están en mantenimiento. ¿Deseas dejar tus datos?";
    }
}

// MODIFICACIÓN CLAVE PARA PRUEBAS: Actualizada a v25.0
async function sendWhatsApp(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_ID}/messages`, // CORRECCIÓN AQUÍ
            data: { messaging_product: "whatsapp", to: to, text: { body: text } },
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }
        });
        console.log(`Mensaje enviado exitosamente a ${to}`);
    } catch (error) {
        console.error("Error API:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

// --- WEBHOOKS ---
app.get('/webhook', (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        res.sendStatus(200); 
        
        if (body.entry?.[0]?.changes?.[0]?.value?.messages) {
            const msg = body.entry[0].changes[0].value.messages[0];
            if (msg.type === 'text') {
                const from = msg.from;
                const text = msg.text.body;
                
                console.log(`Webhook recibido de ${from}: ${text}`);

                // 1. Guardar mensaje del cliente en Odoo
                await logMessageToOdoo(from, text, "Cliente");

                const productQuery = text.split(" ")[0]; 
                const stockData = await getOdooStock(productQuery);
                const finalResponse = await getGeminiResponse(text, stockData);
                
                // 2. Enviar a WhatsApp
                await sendWhatsApp(from, finalResponse);
                
                // 3. Guardar la respuesta del Bot en Odoo
                await logMessageToOdoo(from, finalResponse, "🤖 Bot Gemini");
            }
        }
    } else {
        res.sendStatus(404);
    }
});

app.listen(port, () => console.log(`Servidor de Orthomedical escuchando en el puerto ${port}`));
