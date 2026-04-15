// Binance Gerçek Zamanlı Piyasa Veri Motoru
const market = {
  ws: null,
  currentSymbol: 'BTCUSDT',
  currentInterval: '1m',
  candles: [],          // OHLCV mum verisi
  priceHistory: [],     // sadece kapanış fiyatları (strateji için)
  currentPrice: 0,
  currentCandle: null,  // şu anda oluşan mum
  onPriceUpdate: null,  // callback
  onCandleClose: null,  // callback
  reconnectTimer: null,
  isConnecting: false,

  SYMBOLS: [
    { value: 'BTCUSDT',  label: 'BTC/USDT',  name: 'Bitcoin' },
    { value: 'ETHUSDT',  label: 'ETH/USDT',  name: 'Ethereum' },
    { value: 'BNBUSDT',  label: 'BNB/USDT',  name: 'BNB' },
    { value: 'SOLUSDT',  label: 'SOL/USDT',  name: 'Solana' },
    { value: 'XRPUSDT',  label: 'XRP/USDT',  name: 'Ripple' },
    { value: 'DOGEUSDT', label: 'DOGE/USDT', name: 'Dogecoin' },
    { value: 'ADAUSDT',  label: 'ADA/USDT',  name: 'Cardano' },
    { value: 'AVAXUSDT', label: 'AVAX/USDT', name: 'Avalanche' },
    { value: 'DOTUSDT',  label: 'DOT/USDT',  name: 'Polkadot' },
    { value: 'LTCUSDT',  label: 'LTC/USDT',  name: 'Litecoin' },
    { value: 'MATICUSDT',label: 'MATIC/USDT',name: 'Polygon' },
    { value: 'LINKUSDT', label: 'LINK/USDT', name: 'Chainlink' },
  ],

  INTERVALS: [
    { value: '1m',  label: '1 Dk' },
    { value: '3m',  label: '3 Dk' },
    { value: '5m',  label: '5 Dk' },
    { value: '15m', label: '15 Dk' },
    { value: '1h',  label: '1 Saat' },
  ],

  // Geçmiş mum verisi çek (Binance REST)
  async fetchKlines(symbol, interval, limit = 100) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance API hatası: ' + res.status);
    const raw = await res.json();
    return raw.map(k => ({
      time:   k[0],
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closed: true
    }));
  },

  // Anlık fiyat çek
  async fetchTicker(symbol) {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Ticker hatası');
    const data = await res.json();
    return parseFloat(data.price);
  },

  // 24 saat istatistikler
  async fetch24h(symbol) {
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('24h istatistik hatası');
    return await res.json();
  },

  // WebSocket bağlantısı kur
  async connect(symbol, interval) {
    if (this.isConnecting) return;
    this.isConnecting = true;

    // Önceki bağlantıyı kapat
    this.disconnect();

    this.currentSymbol = symbol || this.currentSymbol;
    this.currentInterval = interval || this.currentInterval;

    try {
      // 1. Geçmiş veriyi yükle
      this.candles = await this.fetchKlines(this.currentSymbol, this.currentInterval, 100);
      this.priceHistory = this.candles.map(c => c.close);
      this.currentPrice = this.priceHistory[this.priceHistory.length - 1];

      // 2. WebSocket bağlantısı
      const stream = `${this.currentSymbol.toLowerCase()}@kline_${this.currentInterval}`;
      this.ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);

      this.ws.onopen = () => {
        console.log(`[Market] Bağlandı: ${this.currentSymbol} ${this.currentInterval}`);
        this.isConnecting = false;
        this._updateStatus('Bağlı', 'green');
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.e !== 'kline') return;

        const k = msg.k;
        const candle = {
          time:   k.t,
          open:   parseFloat(k.o),
          high:   parseFloat(k.h),
          low:    parseFloat(k.l),
          close:  parseFloat(k.c),
          volume: parseFloat(k.v),
          closed: k.x   // mum kapandı mı?
        };

        this.currentPrice = candle.close;
        this.currentCandle = candle;

        if (candle.closed) {
          // Yeni kapanan mum
          this.candles.push(candle);
          if (this.candles.length > 200) this.candles.shift();
          this.priceHistory.push(candle.close);
          if (this.priceHistory.length > 200) this.priceHistory.shift();

          if (typeof this.onCandleClose === 'function') this.onCandleClose(candle);
        } else {
          // Devam eden mum → son mumu güncelle
          if (this.candles.length > 0) {
            this.candles[this.candles.length - 1] = { ...candle, closed: false };
          }
        }

        if (typeof this.onPriceUpdate === 'function') this.onPriceUpdate(this.currentPrice, candle);
      };

      this.ws.onclose = () => {
        this._updateStatus('Bağlantı Kesildi', 'red');
        console.warn('[Market] WebSocket kapandı, yeniden bağlanılıyor...');
        this.isConnecting = false;
        this.reconnectTimer = setTimeout(() => this.connect(this.currentSymbol, this.currentInterval), 3000);
      };

      this.ws.onerror = (err) => {
        console.error('[Market] WebSocket hatası', err);
        this._updateStatus('Hata', 'red');
        this.isConnecting = false;
      };

    } catch (err) {
      console.error('[Market] Bağlantı hatası:', err);
      this._updateStatus('API Hatası', 'red');
      this.isConnecting = false;
    }
  },

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null; // auto-reconnect iptal
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
  },

  // Piyasa değiştir
  async changeSymbol(symbol, interval) {
    this._updateStatus('Değiştiriliyor...', 'yellow');
    await this.connect(symbol, interval || this.currentInterval);
  },

  _updateStatus(text, color) {
    const el = document.getElementById('wsStatus');
    if (!el) return;
    const colors = {
      green:  'bg-emerald-600',
      red:    'bg-rose-600',
      yellow: 'bg-amber-500'
    };
    el.className = `text-xs px-2 py-1 rounded text-white ${colors[color] || 'bg-slate-600'}`;
    el.textContent = text;
  }
};
