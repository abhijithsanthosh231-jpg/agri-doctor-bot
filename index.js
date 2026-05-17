require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const adsByCategory = {
  fungal:  "🌿 *സ്പോൺസർ*: ആന്ത്രക്കോൾ കുമിൾനാശിനി — ശ്രീറാം അഗ്രോ, നേടുംകണ്ടം. വിളി: 9495000000",
  pest:    "🐛 *സ്പോൺസർ*: കോറജൻ കീടനാശിനി — ഗ്രീൻ ലീഫ് അഗ്രോ, കുമളി. വിളി: 9446000000",
  nutrient:"🌱 *സ്പോൺസർ*: NPK വളം — അഗ്രി പ്ലസ്, നേടുംകണ്ടം. വിളി: 9847000000",
  default: "🌾 *സ്പോൺസർ*: വിത്തും വളവും — അഗ്രി പ്ലസ്, നേടുംകണ്ടം. വിളി: 9847000000"
};

const farmerUsage = {};
const FREE_LIMIT = 10;

function getAd(text) {
  const t = text.toLowerCase();
  if (t.includes('fungal') || t.includes('blight') || t.includes('rot') || t.includes('കുമിൾ')) return adsByCategory.fungal;
  if (t.includes('pest') || t.includes('insect') || t.includes('worm') || t.includes('കീട')) return adsByCategory.pest;
  if (t.includes('yellow') || t.includes('deficiency') || t.includes('വളം')) return adsByCategory.nutrient;
  return adsByCategory.default;
}

async function sendReply(to, message) {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({ From: process.env.TWILIO_WHATSAPP_FROM, To: to, Body: message }),
    { auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } }
  );
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  const msg   = req.body.Body || '';
  const from  = req.body.From;
  const media = req.body.MediaUrl0;

  if (!from) return;

  farmerUsage[from] = (farmerUsage[from] || 0) + 1;
  const usage = farmerUsage[from];

  if (usage > FREE_LIMIT) {
    await sendReply(from,
      `നിങ്ങളുടെ ${FREE_LIMIT} സൗജന്യ ചോദ്യങ്ങൾ തീർന്നു.\n\n` +
      `അൺലിമിറ്റഡ് ഡയഗ്നോസിസിനായി ₹99/month:\nhttps://rzp.io/l/agri-doctor`
    );
    return;
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    let parts = [];

    if (media) {
      const imgRes = await axios.get(media, {
        responseType: 'arraybuffer',
        auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
      });
      parts.push({ inlineData: { data: Buffer.from(imgRes.data).toString('base64'), mimeType: req.body.MediaContentType0 || 'image/jpeg' } });
      parts.push({ text: `നിങ്ങൾ ഒരു കാർഷിക വിദഗ്ദ്ധ ഡോക്ടറാണ്. ഈ ചിത്രത്തിലെ ചെടിയുടെ രോഗം Malayalam ൽ പറയൂ:\n1. രോഗത്തിന്റെ പേര്\n2. കാരണം\n3. ചികിത്സ\nMax 150 words.` });
    } else {
      parts.push({ text: `നിങ്ങൾ ഒരു കാർഷിക വിദഗ്ദ്ധ ഡോക്ടറാണ്. കർഷകൻ ചോദിക്കുന്നു: "${msg}"\nMalayalam ൽ ലളിതമായി ഉത്തരം പറയൂ. Max 150 words.` });
    }

    const result  = await model.generateContent(parts);
    const aiReply = result.response.text();
    const ad      = getAd(aiReply + msg);

    await sendReply(from,
      `🌿 *അഗ്രി ഡോക്ടർ*\n\n${aiReply}\n\n` +
      `━━━━━━━━━━━━\n${ad}\n━━━━━━━━━━━━\n` +
      `_(${usage}/${FREE_LIMIT} സൗജന്യ ചോദ്യങ്ങൾ)_`
    );

  } catch (err) {
    console.error('Error:', err.message);
    await sendReply(from, 'ക്ഷമിക്കണം, വീണ്ടും ശ്രമിക്കൂ.');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Agri Doctor bot running!'));