require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xmlrpc = require('xmlrpc');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

// ==========================================
// 1. CONFIGURACIÓN DE CREDENCIALES
// ==========================================
const VERIFY_TOKEN = "orthomedical_token_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// Inicializar Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Inicializar Odoo XML-RPC
const odooUrl = process.env.ODOO_URL;
const db = process.env.ODOO_DB;
const username = process.env.ODOO_USER;
const password = process.env.ODOO_PASSWORD;
const clientCommon = xmlrpc.createSecureClient({ host: odooUrl, port: 443, path: '/xmlrpc/2/common' });
const clientObject = xmlrpc.createSecureClient({ host: odooUrl, port: 443, path: '/xmlrpc/2/object' });

// ==========================================
// 2. LÓGICA DE CONEXIÓN A ODOO
// ==========================================
async function getOdooStock(productQuery) {
    return new Promise((resolve) => {
        clientCommon.methodCall('authenticate', [db, username, password, {}], (err, uid) => {
            if (err || !uid) return resolve("Error de conexión al ERP.");
            
            // Buscar el producto en la base de datos (Búsqueda flexible)
            clientObject.methodCall('execute_kw', [db, uid, password, 'product.product', 'search_read',
                [[['name', 'ilike', productQuery]]], { fields: ['id', 'name'], limit: 1 }
            ], (err, products) => {
                if (err || !products || products.length === 0) {
                    return resolve("Producto no encontrado en la base de datos.");
                }
                
                const productId = products[0].id;
                const productName = products[0].name;
                
                // Consultar las cantidades disponibles por ubicación
                clientObject.methodCall('execute_kw', [db, uid, password, 'stock.quant', 'search_read',
                    [[['product_id', '=', productId]]], { fields: ['location_id', 'quantity', 'reserved_quantity'] }
                ], (err, stockData) => {
                    if (err || !stockData) return resolve(`Producto: ${productName}. Sin datos de stock.`);
                    
                    let stockMsg = `Datos del ERP para ${productName}:\n`;
                    let totalAvailable = 0;

                    stockData.forEach(s => {
                        const locName = s.location_id[1];
                        const available = s.quantity - s.reserved_quantity; // Stock real libre
                        if(available > 0) {
                            stockMsg += `- Ubicación ${locName}: ${available} unidades disponibles.\n`;
                            totalAvailable += available;
                        }
                    });

                    if (totalAvailable === 0) {
                        return resolve(`Producto: ${productName}. Stock físico actual: 0 unidades.`);
                    }
                    resolve(stockMsg);
                });
            });
        });
    });
}

// ==========================================
// 3. LÓGICA DE INTELIGENCIA ARTIFICIAL (GEMINI)
// ==========================================
async function getGeminiResponse(userMessage, stockInfo) {
    const systemPrompt = `Eres el asistente virtual experto en ventas técnicas de Orthomedical A&R S.A.C., fabricante y distribuidor peruano de insumos médicos y textiles ortopédicos.
Reglas estrictas:
1. Sé cálido, empático, muy profesional y conciso (formato ideal para leer rápido en WhatsApp).
2. Usa ESTA información extraída en tiempo real de nuestro ERP para responder: [${stockInfo}]. No inventes stock ni precios que no estén ahí.
3. Si el stock está en 'Fayloc 158', menciona amablemente que pueden recogerlo de inmediato en Av. Emancipación 343. Si está en 'Almacén General', indica que se requiere coordinar el despacho.
4. Si el stock es 0, ofrece disculpas, pregunta si desean evaluar un producto alternativo o derivar el caso a un asesor humano para revisar tiempos de fabricación.
5. Si mencionan ventas institucionales, B2B, compras por volumen o licitaciones con el Estado, destaca que contamos con Registro Nacional de Proveedores (RNP) y diles que un asesor corporativo los contactará en breve.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: userMessage,
            config: { systemInstruction: systemPrompt }
        });
        return response.text;
    } catch (error) {
        console.error("Error en Gemini:", error);
        return "Lo siento, nuestros servidores de atención están en mantenimiento breve. ¿Deseas dejarme tus datos para que un asesor te escriba pronto?";
    }
}

// ==========================================
// 4. ENVÍO DE MENSAJES A WHATSAPP
// ==========================================
async function sendWhatsApp(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`,
            data: { messaging_product: "whatsapp", to: to, text: { body: text } },
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }
        });
    } catch (error) {
        console.error("Error de WhatsApp API:", error.response ? error.response.data : error);
    }
}

// ==========================================
// 5. ENDPOINTS DEL WEBHOOK
// ==========================================
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
        // Responder 200 OK inmediatamente a Meta para evitar bloqueos por timeout
        res.sendStatus(200); 
        
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const msg = body.entry[0].changes[0].value.messages[0];
            
            if (msg.type === 'text') {
                const from = msg.from;
                const text = msg.text.body;
                
                console.log(`Nuevo mensaje de ${from}: ${text}`);

                // 1. Extraer una palabra clave rápida del mensaje para buscar en Odoo
                // (En una versión avanzada, Gemini puede hacer esta extracción. Aquí usamos una heurística rápida).
                const productQuery = text.split(" ")[0]; 
                
                // 2. Consultar inventario real en Odoo
                const stockData = await getOdooStock(productQuery);
                
                // 3. Generar la respuesta inteligente con Gemini inyectando el stock
                const finalResponse = await getGeminiResponse(text, stockData);
                
                // 4. Entregar el mensaje final al cliente
                await sendWhatsApp(from, finalResponse);
            }
        }
    } else {
        res.sendStatus(404);
    }
});

app.listen(port, () => {
    console.log(`Servidor de Orthomedical escuchando en el puerto ${port}`);
});
