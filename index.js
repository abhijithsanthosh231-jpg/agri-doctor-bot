require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const twilio = require('twilio');
const { LRUCache } = require('lru-cache');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ================================================
// YOUR AD SYSTEM — edit these to add sponsors
// ================================================
const adsByCategory = {
  fungal:  "🌿 *സ്പോൺസർ*: ആന്ത്രക്കോൾ കുമിൾനാശിനി — ശ്രീറാം അഗ്രോ, നേടുംകണ്ടം. വിളി: 9495000000",
  pest:    "🐛 *സ്പോൺസർ*: കോറജൻ കീടനാശിനി — ഗ്രീൻ ലീഫ് അഗ്രോ, കുമളി. 20% ഓഫ്. വിളി: 9446000000",
  nutrient:"🌱 *സ്പോൺസർ*: NPK വളം — അഗ്രി പ്ലസ്, നേടുംകണ്ടം. ഡോർ ഡെലിവറി. വിളി: 9847000000",
  default: "🌾 *സ്പോൺസർ*: ഉയർന്ന നിലവാരമുള്ള വിത്തുകളും വളങ്ങളും — അഗ്രി പ്ലസ്, നേടുംകണ്ടം. വിളി: 9847000000"
};

// Track how many messages each farmer sends (for free limit)
const farmerUsage = new LRUCache({
  max: 5000, // keep max 5000 users in memory
  ttl: 1000 * 60 * 60 * 24 * 30, // 30 days
});
const FREE_LIMIT = 10;

function getAd(responseText) {
  const text = responseText.toLowerCase();
  if (text.includes('fungal') || text.includes('blight') || text.includes('rot') || text.includes('കുമിൾ')) 
    return adsByCategory.fungal;
  if (text.includes('pest') || text.includes('insect') || text.includes('worm') || text.includes('കീട'))
    return adsByCategory.pest;
  if (text.includes('yellow') || text.includes('deficiency') || text.includes('nutrient') || text.includes('വളം'))
    return adsByCategory.nutrient;
  return adsByCategory.default;
}

async function sendWhatsAppReply(to, message) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;
  await axios.post(url,
    new URLSearchParams({ From: process.env.TWILIO_WHATSAPP_FROM, To: to, Body: message }),
    { auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }}
  );
}

app.post('/webhook', async (req, res) => {
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.get('host')}${req.originalUrl}`;

  if (process.env.NODE_ENV === 'production') {
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      url,
      req.body
    );

    if (!isValid) {
      return res.status(403).send('Forbidden: Invalid Twilio Signature');
    }
  }

  const incomingMsg = req.body.Body || '';
  const fromNumber  = req.body.From;
  const mediaUrl    = req.body.MediaUrl0;

  if (!fromNumber) {
    return res.status(400).send('Bad Request: Missing From Number');
  }

  res.status(200).send('OK'); // Reply to Twilio immediately

  // Check free usage limit
  let currentUsage = farmerUsage.get(fromNumber) || 0;
  currentUsage++;
  farmerUsage.set(fromNumber, currentUsage);

  if (currentUsage > FREE_LIMIT) {
    await sendWhatsAppReply(fromNumber,
      `നിങ്ങളുടെ ${FREE_LIMIT} സൗജന്യ ചോദ്യങ്ങൾ തീർന്നു.\n\n` +
      `അൺലിമിറ്റഡ് ഡയഗ്നോസിസിനായി ₹99/month സബ്സ്ക്രൈബ് ചെയ്യൂ:\n` +
      `https://rzp.io/l/agri-doctor\n\n` +
      `📞 സഹായത്തിന്: 9447000000`
    );
    return;
  }

  try {
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    let prompt;
    let imagePart = null;

    if (mediaUrl) {
      // Farmer sent a photo
      const imageResponse = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
      });
      const base64Image = Buffer.from(imageResponse.data).toString('base64');
      const mimeType = req.body.MediaContentType0 || 'image/jpeg';

      imagePart = { inlineData: { data: base64Image, mimeType } };
      prompt = `ഈ ചിത്രത്തിലെ ചെടിയുടെ രോഗം തിരിച്ചറിയുക. ഒപ്പം കർഷകൻ പറഞ്ഞത്: "${incomingMsg}"`;
    } else {
      // Text question
      prompt = incomingMsg;
    }

    const parts = imagePart ? [imagePart, { text: prompt }] : [{ text: prompt }];
    const result = await model.generateContent(parts);
    const aiReply = result.response.text();

    // Get relevant ad
    const ad = getAd(aiReply + incomingMsg);

    // Build final message
    const finalMessage =
      `🌿 *അഗ്രി ഡോക്ടർ*\n\n` +
      aiReply +
      `\n\n━━━━━━━━━━━━━━\n` +
      ad +
      `\n━━━━━━━━━━━━━━\n` +
      `_(${currentUsage}/${FREE_LIMIT} സൗജന്യ ചോദ്യങ്ങൾ ഉപയോഗിച്ചു)_`;

    await sendWhatsAppReply(fromNumber, finalMessage);

  } catch (err) {
    console.error("FULL ERROR:", JSON.stringify(err, null, 2));
    if (err.response) {
      console.error('Axios Error Response Data:', err.response.data);
    }
    try {
      if (fromNumber) {
        await sendWhatsAppReply(fromNumber, 'ക്ഷമിക്കണം, ഒരു നിമിഷം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കൂ.');
      }
    } catch (replyErr) {
      console.error('Failed to send error reply:', replyErr.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agri Doctor bot running on port ${PORT}`));
