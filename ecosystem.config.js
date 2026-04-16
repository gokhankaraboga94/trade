module.exports = {
  apps: [
    {
      name: 'trade-bot',
      script: 'server.js',
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',

        // --- ZORUNLU: Trading bot'un dinleyeceği Firebase kullanıcı UID'si ---
        // Adım: Vercel'deki siteye giriş yap → üst çubukta "UID: xxxx" badge'e tıkla → kopyala → buraya yapıştır
        TRADING_BOT_UID: 'dIwM1KOqg2bK550iqZrBoIpIztm1',

        // --- ZORUNLU: Firebase Admin SDK service account JSON dosyasının tam yolu (Windows yolu) ---
        // Firebase Console → Proje Ayarları → Hizmet Hesapları → Yeni özel anahtar oluştur
        // İndirdiğin JSON'u VPS'teki bir klasöre koy, tam yolunu yaz
        // Örnek: C:\trade-bot\serviceAccount.json
        FIREBASE_SERVICE_ACCOUNT_PATH: 'C:\Windows\System32\cmd.exe',

        // --- Firebase Realtime Database URL ---
        FIREBASE_DATABASE_URL: 'https://efor-fbd0d-default-rtdb.firebaseio.com',

        // --- Server portu (isteğe bağlı, default: 3131) ---
        MOBILFON_PROXY_PORT: '3131'
      }
    }
  ]
};
