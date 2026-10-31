const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Endpoint GET que Meta usará para verificar el Webhook
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = "orthomedical_token_123"; // Puedes cambiar este texto por tu propia contraseña secreta
  
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verificado exitosamente por Meta");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

app.listen(port, () => {
  console.log(`Servidor de Orthomedical ejecutándose en el puerto ${port}`);
});