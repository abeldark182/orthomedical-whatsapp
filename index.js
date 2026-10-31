require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json()); // Necesario para leer los datos que envía Meta

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "orthomedical_token_123";

// 1. Endpoint de Validación (El que ya usamos)
app.get('/webhook', (req, res) => {
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 2. Endpoint de Recepción de Mensajes (Nuevo)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Verificar si es un mensaje de WhatsApp
  if (body.object === 'whatsapp_business_account') {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const message = body.entry[0].changes[0].value.messages[0];
      const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
      const from = message.from; // Número del cliente
      
      if (message.type === 'text') {
         const msgBody = message.text.body;
         console.log(`Mensaje recibido de ${from}: ${msgBody}`);
         
         // Aquí conectaremos Gemini y Odoo en el siguiente paso
      }
    }
    // Siempre debemos responder 200 OK a Meta rápidamente
    res.sendStatus(200); 
  } else {
    res.sendStatus(404);
  }
});

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});
