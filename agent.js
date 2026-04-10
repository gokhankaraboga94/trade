// ═══════════════════════════════════════════════════════════════
// AutoTrade Pro — Dual Position Agent
// Strateji: Her zaman simetrik LONG + SHORT pozisyon tut
// TP vurunca: aynı yönü yeniden aç + karşı taraf limit emir
// Trailing Stop: TP mesafesinin %50'sine ulaşınca kâr kilitle
// Öğrenme: Yön bazlı win rate → adaptif lot çarpanı
// ═══════════════════════════════════════════════════════════════
const agent = {

  // ─── Hafıza, Durum & Limit Emirler ────────────────────────
  memory:        [],   // son 30 işlem
  pendingOrders: [],   // simüle edilmiş limit emirler (BUY/SELL LIMIT)

  state: {
    // TP / Trailing parametreleri (ATR çarpanları)
    tpMult:             1.0,   // ATR × tpMult = TP mesafesi
    trailingMult:       0.5,   // Trailing SL mesafesi = tpDist × trailingMult
    trailingActivation: 0.50,  // TP mesafesinin %50'sine ulaşınca trailing aktif
    trailingStep:       0.10,  // Trailing SL güncelleme adımı (tpDist'in %10'u)
    pendingMult:        0.8,   // ATR × pendingMult = limit emir mesafesi
    sizePercent:        0.02,  // Bakiyenin %2'si temel lot

    // Genel istatistikler
    totalTrades:    0,
    totalPnL:       0,
    pauseUntil:     0,
    consecutiveLosses: 0,

    // Yön bazlı takip
    longWins:  0, longTotal:  0,
    shortWins: 0, shortTotal: 0,

    // Adaptif lot çarpanları (öğrenme ile değişir)
    longSizeMult:  1.0,
    shortSizeMult: 1.0,
  },

  // ─── ATR (volatilite ölçüsü) ───────────────────────────────
  calcATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const slice = candles.slice(-(period + 1));
    const trs = [];
    for (let i = 1; i < slice.length; i++) {
      const h = slice[i].high, l = slice[i].low, pc = slice[i-1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  },

  // ─── Dual Karar Motoru ─────────────────────────────────────
  // Her zaman hem LONG hem SHORT için parametre üretir
  decideDual(candles, balance) {
    if (!candles || candles.length < 20) return null;

    if (Date.now() < this.state.pauseUntil) {
      const s = Math.ceil((this.state.pauseUntil - Date.now()) / 1000);
      return { paused: true, reason: `Koruma molası (${s}sn)` };
    }

    const atr = this.calcATR(candles);
    if (!atr) return null;

    const currentPrice = candles[candles.length - 1].close;
    const atrPct       = (atr / currentPrice) * 100;

    // TP ve trailing mesafeleri (ATR bazlı)
    const tpPct      = parseFloat(Math.max(0.08, atrPct * this.state.tpMult).toFixed(4));
    const trailPct   = parseFloat(Math.max(0.03, atrPct * this.state.trailingMult).toFixed(4));
    const pendingPct = parseFloat(Math.max(0.04, atrPct * this.state.pendingMult).toFixed(4));

    // Volatilite düzeltmeli lot hesabı
    const volAdj   = Math.max(0.4, 1 - Math.max(0, atrPct - 0.1) * 1.5);
    const baseAmt  = Math.max(10, Math.min(balance * 0.08,
                       Math.round(balance * this.state.sizePercent * volAdj)));
    const longAmt  = Math.max(10, Math.min(balance * 0.1,
                       Math.round(baseAmt * this.state.longSizeMult)));
    const shortAmt = Math.max(10, Math.min(balance * 0.1,
                       Math.round(baseAmt * this.state.shortSizeMult)));

    return {
      paused:     false,
      tpPct,
      trailPct,
      pendingPct,
      long:  { direction: 'long',  amount: longAmt,  tpPct },
      short: { direction: 'short', amount: shortAmt, tpPct },
      meta:  { atrPct: atrPct.toFixed(4), atr: atr.toFixed(2) },
    };
  },

  // ─── Limit Emir Yönetimi ────────────────────────────────────
  // BUY LIMIT: triggerPrice altına düşünce alım yapar
  // SELL LIMIT: triggerPrice üstüne çıkınca satış yapar
  addPendingOrder(direction, triggerPrice, tpPct, amount) {
    // Yakın fiyatta aynı yönde emir varsa ekleme
    const exists = this.pendingOrders.some(o =>
      o.direction === direction &&
      Math.abs(o.triggerPrice - triggerPrice) / triggerPrice < 0.001
    );
    if (exists) return;
    this.pendingOrders.push({
      id:           'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      direction,
      triggerPrice: parseFloat(triggerPrice.toFixed(8)),
      tpPct,
      amount,
      createdAt:    Date.now(),
    });
    this.save();
  },

  // Her tick çağrılır — tetiklenen emirleri döner ve listeden çıkarır
  checkPendingOrders(currentPrice) {
    const triggered = [];
    this.pendingOrders = this.pendingOrders.filter(o => {
      const hit = o.direction === 'long'
        ? currentPrice <= o.triggerPrice   // BUY LIMIT: fiyat düşünce tetiklenir
        : currentPrice >= o.triggerPrice;  // SELL LIMIT: fiyat yükselince tetiklenir
      if (hit) { triggered.push(o); return false; }
      if (Date.now() - o.createdAt > 30 * 60 * 1000) return false; // 30dk süresi dolar
      return true;
    });
    return triggered;
  },

  getPendingOrders() { return this.pendingOrders; },

  clearAllPending() { this.pendingOrders = []; this.save(); },

  // ─── Trailing Stop ──────────────────────────────────────────
  // TP mesafesinin trailingActivation kadarına ulaşıldıysa aktif
  shouldActivateTrailing(trade, currentPrice) {
    if (!trade.tpPrice) return false;
    const tpDist     = Math.abs(trade.tpPrice - trade.entryPrice);
    const profitDist = trade.direction === 'long'
      ? currentPrice - trade.entryPrice
      : trade.entryPrice - currentPrice;
    return profitDist >= tpDist * this.state.trailingActivation;
  },

  // Trailing SL seviyesini hesapla (TP mesafesinin trailingMult oranı kadar geride)
  calcNewTrailingSL(trade, currentPrice) {
    const tpDist   = Math.abs(trade.tpPrice - trade.entryPrice);
    const trailDist = tpDist * this.state.trailingMult;
    return trade.direction === 'long'
      ? currentPrice - trailDist
      : currentPrice + trailDist;
  },

  // Trailing SL güncellemeli mi? (minimum adım kontrolü)
  shouldUpdateTrailingSL(trade, newSL) {
    if (trade.trailingSL == null) return true; // ilk aktivasyon
    const tpDist = Math.abs(trade.tpPrice - trade.entryPrice);
    const step   = tpDist * this.state.trailingStep;
    return trade.direction === 'long'
      ? newSL > trade.trailingSL + step
      : newSL < trade.trailingSL - step;
  },

  // ─── Öğrenme (işlem kapandığında çağrılır) ─────────────────
  learn(trade) {
    const isWin  = trade.profit > 0;
    const isLong = trade.direction === 'long';

    this.memory.push({
      profit:      trade.profit,
      direction:   trade.direction,
      closeReason: trade.closeReason,
      win:         isWin,
      ts:          Date.now(),
    });
    if (this.memory.length > 30) this.memory.shift();

    this.state.totalTrades++;
    this.state.totalPnL = parseFloat((this.state.totalPnL + trade.profit).toFixed(4));

    if (isLong) { this.state.longTotal++;  if (isWin) this.state.longWins++;  }
    else        { this.state.shortTotal++; if (isWin) this.state.shortWins++; }

    if (!isWin) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    let pauseMsg = null;
    if (this.state.consecutiveLosses >= 4) {
      this.state.pauseUntil      = Date.now() + 90000; // 90sn mola
      this.state.consecutiveLosses = 0;
      pauseMsg = '4 ardışık zarar → 90sn mola';
    }

    this._adapt();
    this.save();
    return pauseMsg;
  },

  // Adaptif parametre ayarı (yön bazlı lot + genel TP/trailing)
  _adapt() {
    const longWR  = this.state.longTotal  >= 5
      ? this.state.longWins  / this.state.longTotal  : 0.5;
    const shortWR = this.state.shortTotal >= 5
      ? this.state.shortWins / this.state.shortTotal : 0.5;

    // Başarılı yöne daha büyük lot (0.5x – 2.0x)
    this.state.longSizeMult  = parseFloat(Math.max(0.5, Math.min(2.0, 0.5 + longWR  * 1.5)).toFixed(2));
    this.state.shortSizeMult = parseFloat(Math.max(0.5, Math.min(2.0, 0.5 + shortWR * 1.5)).toFixed(2));

    // Genel win rate → tpMult ve trailing aktivasyon eşiği
    const totalWR = (this.state.longWins + this.state.shortWins) /
                    Math.max(1, this.state.longTotal + this.state.shortTotal);

    if (totalWR > 0.65) {
      // İyi performans → daha büyük TP hedefi, trailing daha erken aktif
      this.state.tpMult           = parseFloat(Math.min(2.0,  this.state.tpMult + 0.05).toFixed(2));
      this.state.trailingActivation = parseFloat(Math.max(0.30, this.state.trailingActivation - 0.02).toFixed(2));
      this.state.sizePercent      = parseFloat(Math.min(0.06, this.state.sizePercent * 1.04).toFixed(4));
    } else if (totalWR < 0.40) {
      // Kötü performans → daha küçük TP, trailing daha geç aktif
      this.state.tpMult           = parseFloat(Math.max(0.6,  this.state.tpMult - 0.05).toFixed(2));
      this.state.trailingActivation = parseFloat(Math.min(0.70, this.state.trailingActivation + 0.02).toFixed(2));
      this.state.sizePercent      = parseFloat(Math.max(0.01, this.state.sizePercent * 0.92).toFixed(4));
    }
  },

  // ─── İstatistikler ─────────────────────────────────────────
  getStats() {
    const paused  = Date.now() < this.state.pauseUntil;
    const longWR  = this.state.longTotal  > 0
      ? (this.state.longWins  / this.state.longTotal  * 100).toFixed(1) : '—';
    const shortWR = this.state.shortTotal > 0
      ? (this.state.shortWins / this.state.shortTotal * 100).toFixed(1) : '—';
    const totalWR = (this.state.longTotal + this.state.shortTotal) > 0
      ? ((this.state.longWins + this.state.shortWins) /
         (this.state.longTotal + this.state.shortTotal) * 100).toFixed(1) : '0.0';

    return {
      totalTrades:   this.state.totalTrades,
      totalPnL:      this.state.totalPnL.toFixed(2),
      winRate:       totalWR,
      longWR,        shortWR,
      longSizeMult:  this.state.longSizeMult,
      shortSizeMult: this.state.shortSizeMult,
      tpMult:        this.state.tpMult.toFixed(2),
      trailAct:      (this.state.trailingActivation * 100).toFixed(0),
      sizePercent:   (this.state.sizePercent * 100).toFixed(1),
      pendingCount:  this.pendingOrders.length,
      consLosses:    this.state.consecutiveLosses,
      paused,
      pauseSec:      Math.max(0, Math.ceil((this.state.pauseUntil - Date.now()) / 1000)),
    };
  },

  // ─── Kalıcı Depolama ───────────────────────────────────────
  save() {
    try {
      if (typeof storage !== 'undefined' && typeof storage.saveAgentState === 'function') {
        storage.saveAgentState({
          memory:        this.memory,
          pendingOrders: this.pendingOrders,
          state:         this.state,
        });
        return;
      }
    } catch(e) {}
  },

  load() {
    try {
      const saved = (typeof storage !== 'undefined' && typeof storage.getAgentState === 'function')
        ? storage.getAgentState()
        : null;
      if (!saved) return;
      if (saved.memory)        this.memory        = saved.memory;
      if (saved.pendingOrders) this.pendingOrders = saved.pendingOrders;
      if (saved.state)         this.state         = { ...this.state, ...saved.state };
    } catch(e) {}
  },

  reset() {
    this.memory        = [];
    this.pendingOrders = [];
    this.state = {
      tpMult: 1.0, trailingMult: 0.5, trailingActivation: 0.50,
      trailingStep: 0.10, pendingMult: 0.8, sizePercent: 0.02,
      totalTrades: 0, totalPnL: 0, pauseUntil: 0, consecutiveLosses: 0,
      longWins: 0, longTotal: 0, shortWins: 0, shortTotal: 0,
      longSizeMult: 1.0, shortSizeMult: 1.0,
    };
    this.save();
  },
};

try {
  if (typeof module !== 'undefined' && module.exports) module.exports = agent;
} catch (e) {}
