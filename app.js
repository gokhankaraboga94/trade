// Ana Trading Bot Motoru — Gerçek Zamanlı Binance Verileri
const bot = {
  isRunning: false,
  settings: {},
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  updateInterval: null,
  signalTimer: null,
  lastSignalTime: 0,
  tradeMarkers: [],

  async init() {
    try {
      if (this.updateInterval) clearInterval(this.updateInterval);
      if (this.signalTimer) clearInterval(this.signalTimer);
    } catch (e) {}

    this.settings = storage.getSettings();
    agent.load();                    // ajan hafızasını yükle
    this.loadSettings();
    this.buildMarketSelector();
    await this.initMarket();
    this.initChart();
    this.loadTrades();
    this.loadHistory();
    this.updateBalanceDisplay();
    this.updateStats();
    this._updateAgentStats();        // ajan panelini güncelle

    // Her 2 saniyede TP/SL/timeout kontrolü + ekran güncelle
    this.updateInterval = setInterval(() => this._tick(), 2000);

    // Periyodik strateji timer
    this._restartSignalTimer();

    try {
      const bs = (typeof storage !== 'undefined' && typeof storage.getBotState === 'function')
        ? storage.getBotState()
        : null;
      this.toggleTrading(!!bs?.running, { silent: true, persist: false });
    } catch (e) {}
  },

  // Piyasa motorunu başlat
  async initMarket() {
    const savedSymbol   = this.settings.symbol   || 'BTCUSDT';
    const savedInterval = this.settings.interval || '1m';

    // Fiyat güncellemesi geldiğinde
    market.onPriceUpdate = (price, candle) => {
      this.updatePriceDisplay(price, candle);
      this.updateChart();
    };

    // Mum kapandığında → strateji sinyali
    market.onCandleClose = (candle) => {
      if (this.isRunning) this._runStrategy();
    };

    this._updateStatus('Bağlanıyor...');
    await market.connect(savedSymbol, savedInterval);
    this._updateStatus('Aktif');
  },

  // Piyasa seçiciyi doldur
  buildMarketSelector() {
    const sel = document.getElementById('symbolSelect');
    const intSel = document.getElementById('intervalSelect');
    if (!sel || !intSel) return;

    sel.innerHTML = market.SYMBOLS.map(s =>
      `<option value="${s.value}" ${s.value === (this.settings.symbol || 'BTCUSDT') ? 'selected' : ''}>${s.label}</option>`
    ).join('');

    intSel.innerHTML = market.INTERVALS.map(i =>
      `<option value="${i.value}" ${i.value === (this.settings.interval || '1m') ? 'selected' : ''}>${i.label}</option>`
    ).join('');
  },

  // Piyasa değiştir
  async changeMarket() {
    const symbol   = document.getElementById('symbolSelect').value;
    const interval = document.getElementById('intervalSelect').value;

    this.settings.symbol   = symbol;
    this.settings.interval = interval;
    storage.saveSettings(this.settings);

    // Grafik ve marker'ları sıfırla
    this.tradeMarkers = [];
    this._updateStatus('Değiştiriliyor...');
    await market.connect(symbol, interval);
    this._initChartData();
    this._updateStatus('Aktif');

    // 24s istatistik güncelle
    this._load24hStats();
  },

  // 24s istatistikler
  async _load24hStats() {
    try {
      const data = await market.fetch24h(market.currentSymbol);
      const changeClass = parseFloat(data.priceChangePercent) >= 0 ? 'text-emerald-400' : 'text-rose-400';
      const sign = parseFloat(data.priceChangePercent) >= 0 ? '+' : '';
      document.getElementById('stat24hChange').innerHTML =
        `<span class="${changeClass}">${sign}${parseFloat(data.priceChangePercent).toFixed(2)}%</span>`;
      document.getElementById('stat24hHigh').textContent  = '$' + parseFloat(data.highPrice).toLocaleString();
      document.getElementById('stat24hLow').textContent   = '$' + parseFloat(data.lowPrice).toLocaleString();
      document.getElementById('stat24hVol').textContent   = parseFloat(data.volume).toLocaleString(undefined, {maximumFractionDigits: 0});
    } catch(e) {}
  },

  loadSettings() {
    document.getElementById('maxTrades').value       = this.settings.maxTrades      || 5;
    document.getElementById('tradeAmount').value     = this.settings.tradeAmount    || 100;
    document.getElementById('tpPercent').value       = this.settings.tpPercent      || 1.5;
    document.getElementById('strategySelect').value  = this.settings.strategy       || 'mixed';
    document.getElementById('signalInterval').value  = this.settings.signalInterval || 30;
    document.getElementById('minConfidence').value   = this.settings.minConfidence  || 30;
    const agentChk = document.getElementById('agentModeToggle');
    if (agentChk) agentChk.checked = !!this.settings.agentMode;
    this._applyAgentModeUI(!!this.settings.agentMode);
  },

  saveSettings() {
    const agentChk = document.getElementById('agentModeToggle');
    this.settings = {
      ...this.settings,
      maxTrades:      parseInt(document.getElementById('maxTrades').value)      || 5,
      tradeAmount:    parseFloat(document.getElementById('tradeAmount').value)  || 100,
      tpPercent:      parseFloat(document.getElementById('tpPercent').value)    || 1.5,
      strategy:       document.getElementById('strategySelect').value           || 'mixed',
      signalInterval: parseInt(document.getElementById('signalInterval').value) || 30,
      minConfidence:  parseInt(document.getElementById('minConfidence').value)  || 30,
      agentMode:      agentChk ? agentChk.checked : false,
    };
    storage.saveSettings(this.settings);
    this._applyAgentModeUI(this.settings.agentMode);
    this._restartSignalTimer();
    this._showToast('Ayarlar kaydedildi ✓', 'green');
  },

  _applyAgentModeUI(on) {
    const manualSec  = document.getElementById('manualSettingsSection');
    const agentPanel = document.getElementById('agentStatsPanel');
    if (manualSec)  manualSec.style.opacity  = on ? '0.4' : '1';
    if (agentPanel) agentPanel.style.display = on ? 'block' : 'none';
  },

  _restartSignalTimer() {
    if (this.signalTimer) clearInterval(this.signalTimer);
    const sec = (this.settings.signalInterval || 30) * 1000;
    this.signalTimer = setInterval(() => {
      if (this.isRunning) this._runStrategy();
    }, sec);
    this._log(`Sinyal timer: her ${this.settings.signalInterval || 30} saniyede bir`);
  },

  // ─── Grafik (TradingView Lightweight Charts) ─────────────────────────────────
  initChart() {
    const container = document.getElementById('chartContainer');
    if (!container || !window.LightweightCharts) return;

    this.chart = LightweightCharts.createChart(container, {
      width:  container.clientWidth,
      height: 320,
      layout: {
        background: { type: 'solid', color: '#0a1628' },
        textColor:  '#94a3b8',
        fontFamily: 'JetBrains Mono, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        scaleMargins: { top: 0.05, bottom: 0.22 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
      },
    });

    // Mum serisi
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor:          '#10b981',
      downColor:        '#ef4444',
      borderUpColor:    '#10b981',
      borderDownColor:  '#ef4444',
      wickUpColor:      '#10b981',
      wickDownColor:    '#ef4444',
    });

    // Hacim serisi (alt bölge)
    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat:    { type: 'volume' },
      priceScaleId:   'vol',
    });
    this.chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // Duyarlı yeniden boyutlandırma
    const ro = new ResizeObserver(() => {
      if (this.chart) this.chart.applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);

    this._initChartData();
    this._load24hStats();
  },

  _initChartData() {
    if (!this.candleSeries) return;
    const candles = market.candles;
    if (!candles.length) return;

    const ohlc = candles.map(c => ({
      time:  Math.floor(c.time / 1000),
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));
    this.candleSeries.setData(ohlc);

    this.volumeSeries.setData(candles.map(c => ({
      time:  Math.floor(c.time / 1000),
      value: c.volume,
      color: c.close >= c.open ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)',
    })));

    this.tradeMarkers = [];
    this._updateMarkers();
    this.chart.timeScale().fitContent();
  },

  updateChart() {
    if (!this.candleSeries) return;
    const candles = market.candles;
    if (!candles.length) return;

    const last = candles[candles.length - 1];
    this.candleSeries.update({
      time:  Math.floor(last.time / 1000),
      open:  last.open,
      high:  last.high,
      low:   last.low,
      close: last.close,
    });
    this.volumeSeries.update({
      time:  Math.floor(last.time / 1000),
      value: last.volume,
      color: last.close >= last.open ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)',
    });
    this._updateMarkers();
  },

  // Alım/satım marker'ları
  _addTradeMarker(type, price) {
    const candles = market.candles;
    if (!candles.length) return;
    const last = candles[candles.length - 1];
    this.tradeMarkers.push({
      time:  Math.floor(last.time / 1000),
      type,
      price,
    });
    this._updateMarkers();
  },

  _updateMarkers() {
    if (!this.candleSeries) return;
    const markers = this.tradeMarkers.map(m => ({
      time:     m.time,
      position: m.type === 'buy' ? 'belowBar' : 'aboveBar',
      color:    m.type === 'buy' ? '#10b981'  : '#ef4444',
      shape:    m.type === 'buy' ? 'arrowUp'  : 'arrowDown',
      text:     (m.type === 'buy' ? 'AL ' : 'SAT ') + '$' + m.price.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      size:     1,
    }));
    // Zaman sırasına göre sırala (zorunlu)
    markers.sort((a, b) => a.time - b.time);
    this.candleSeries.setMarkers(markers);
  },

  // ─── Fiyat Göstergesi ────────────────────────────────────────────────────
  updatePriceDisplay(price, candle) {
    const prices = market.priceHistory;
    if (prices.length >= 2) {
      const prev = prices[prices.length - 2];
      const pct  = ((price - prev) / prev) * 100;
      const el   = document.getElementById('priceDisplay');
      el.textContent = '$' + price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
      el.className   = 'text-xl font-bold ' + (pct >= 0 ? 'profit' : 'loss');

      const ind = document.getElementById('trendIndicator');
      if (pct > 0.1)       { ind.textContent = '▲ YUKARI'; ind.className = 'text-xs px-2 py-1 rounded bg-emerald-600 text-white'; }
      else if (pct < -0.1) { ind.textContent = '▼ AŞAĞI';  ind.className = 'text-xs px-2 py-1 rounded bg-rose-600 text-white'; }
      else                 { ind.textContent = '━ YATAY';  ind.className = 'text-xs px-2 py-1 rounded bg-slate-600 text-white'; }
    }
  },

  // ─── Ana tick döngüsü ────────────────────────────────────────────────────
  _tick() {
    const trades = storage.getTrades();
    trades.forEach(t => { if (t.status === 'open') this._checkExits(t); });

    // Limit emir kontrolu (her tick — gerçek zamanlı)
    if (this.settings.agentMode && market.currentPrice) {
      agent.checkPendingOrders(market.currentPrice).forEach(order => {
        const open = storage.getTrades().filter(t => t.status === 'open');
        if (open.length < (this.settings.maxTrades || 5) &&
            (auth.currentUser?.balance || 0) >= order.amount) {
          const label = order.direction === 'long' ? 'BUY LIMIT' : 'SELL LIMIT';
          this._log(`[⏳Limit] ${label} tetiklendi @ $${market.currentPrice.toLocaleString(undefined,{maximumFractionDigits:2})}`, order.direction === 'long' ? 'buy' : 'sell');
          this.openTrade(order.direction, order.amount, order.tpPct, `[Limit] ${label}`);
        }
      });
    }

    this.loadTrades();
    this.updateStats();
    if (this.settings.agentMode) this._updateAgentStats();
  },

  // TP + Trailing SL + Statik SL + Zaman bazlı çıkış
  _checkExits(trade) {
    const p = market.currentPrice;
    if (!p) return;

    // TP kontrolü
    const tpHit = trade.direction === 'long' ? p >= trade.tpPrice : p <= trade.tpPrice;
    if (tpHit) return this.closeTrade(trade, 'tp');

    // Trailing SL kontrolü (aktifse)
    if (trade.trailingSL != null) {
      const tsHit = trade.direction === 'long' ? p <= trade.trailingSL : p >= trade.trailingSL;
      if (tsHit) return this.closeTrade(trade, 'trailing_sl');
    }

    // Statik SL kontrolü (trailing yoksa)
    if (trade.slPrice && trade.trailingSL == null) {
      const slHit = trade.direction === 'long' ? p <= trade.slPrice : p >= trade.slPrice;
      if (slHit) return this.closeTrade(trade, 'sl');
    }

    // Zaman bazlı çıkış
    if (trade.holdUntil && Date.now() > trade.holdUntil) {
      return this.closeTrade(trade, 'timeout');
    }

    // Trailing stop güncelleme (ajan modu)
    if (this.settings.agentMode && agent.shouldActivateTrailing(trade, p)) {
      const newSL = agent.calcNewTrailingSL(trade, p);
      if (agent.shouldUpdateTrailingSL(trade, newSL)) {
        const updated = { ...trade, trailingSL: newSL, slPrice: newSL };
        storage.updateTrade(trade.id, updated);
        Object.assign(trade, updated); // yerel referansı güncelle
      }
    }
  },

  // Ana sinyal noktası: ajan modu veya klasik strateji
  _runStrategy() {
    if (this.settings.agentMode) return this._runAgent();
    return this._runClassicStrategy();
  },

  // ─── Ajan Modu (Dual Position) ──────────────────────────────────────────
  _runAgent() {
    const balance = auth.currentUser?.balance || 0;
    if (balance < 10) { this._log('Bakiye yetersiz', 'warn'); return; }

    const result = agent.decideDual(market.candles, balance);
    if (!result) { this._log('[Ajan] Yetersiz mum verisi', 'warn'); return; }
    if (result.paused) { this._log(`[Ajan] ${result.reason}`, 'warn'); return; }

    this._log(
      `[Ajan] Dual Mod | ATR:${result.meta.atrPct}% TP:±${result.tpPct}% Trail@${(agent.state.trailingActivation*100).toFixed(0)}% | L×${agent.state.longSizeMult} S×${agent.state.shortSizeMult} | Pending:${agent.getPendingOrders().length}`,
      'info'
    );

    const openTrades = storage.getTrades().filter(t => t.status === 'open');
    const maxTrades  = this.settings.maxTrades || 5;
    if (openTrades.length >= maxTrades) return;

    const openLong  = openTrades.filter(t => t.direction === 'long').length;
    const openShort = openTrades.filter(t => t.direction === 'short').length;

    // Her zaman 1 LONG + 1 SHORT tut (EnsureBalancedPositions gibi)
    if (openLong === 0) {
      this.openTrade('long',  result.long.amount,  result.long.tpPct,  '[Ajan] LONG');
    }
    if (openShort === 0 && storage.getTrades().filter(t => t.status === 'open').length < maxTrades) {
      this.openTrade('short', result.short.amount, result.short.tpPct, '[Ajan] SHORT');
    }
  },

  _runClassicStrategy() {
    const prices = market.priceHistory;
    if (prices.length < 20) {
      this._log('Yeterli fiyat verisi yok (' + prices.length + '/20)');
      return;
    }

    const minConf = this.settings.minConfidence || 30;
    const strat   = this.settings.strategy || 'mixed';
    const signal  = strategy.generateSignal(prices, strat);

    const rsi = signal.trend?.rsi?.toFixed(1) || '?';
    this._log(`[Strateji:${strat}] ${signal.action.toUpperCase()} | conf:${signal.confidence.toFixed(0)} rsi:${rsi} | ${signal.reason}`,
      signal.action !== 'hold' ? (signal.direction === 'long' ? 'buy' : 'sell') : 'info');

    if (signal.action === 'hold' || signal.confidence < minConf) return;

    const openTrades = storage.getTrades().filter(t => t.status === 'open');
    if (openTrades.length >= (this.settings.maxTrades || 5)) {
      this._log('Maks işlem limitine ulaşıldı', 'warn');
      return;
    }
    if (openTrades.filter(t => t.direction === signal.direction).length >= 2) return;

    this.openTrade(signal.direction, this.settings.tradeAmount || 100, this.settings.tpPercent || 1.5, signal.reason);
    this.lastSignalTime = Date.now();
  },

  // ─── İşlem Yönetimi ─────────────────────────────────────────────────────
  quickTrade() {
    const direction = document.getElementById('quickDirection').value;
    const amount    = parseFloat(document.getElementById('quickAmount').value) || 100;
    const tpPercent = parseFloat(document.getElementById('quickTP').value)    || 2;
    this.openTrade(direction, amount, tpPercent, 'Manuel');
  },

  openTrade(direction, amount, tpPercent, reason = '', extras = {}) {
    if (!auth.currentUser || auth.currentUser.balance < amount) {
      this._showToast('Yetersiz bakiye!', 'red');
      this._log('Yetersiz bakiye!', 'warn');
      return;
    }
    const entryPrice = market.currentPrice;
    if (!entryPrice) { this._showToast('Fiyat verisi yok!', 'red'); return; }

    const tpPrice  = strategy.calculateTP(entryPrice, direction, tpPercent);
    const slPrice  = extras.slPct  ? strategy.calculateSL(entryPrice, direction, extras.slPct) : null;
    const holdUntil = extras.holdSec ? Date.now() + extras.holdSec * 1000 : null;
    const trade = {
      id:        'trade_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      symbol:    market.currentSymbol,
      direction,
      entryPrice,
      amount,
      tpPrice,
      tpPercent,
      slPrice,
      slPercent: extras.slPct || null,
      holdUntil,
      status:    'open',
      reason,
      openedAt:  new Date().toISOString(),
      closedAt:  null,
      exitPrice: null,
      profit:    0,
      closeReason: null
    };

    storage.saveTrade(trade);
    auth.updateBalance(-amount);
    this._addTradeMarker(direction === 'long' ? 'buy' : 'sell', entryPrice);
    this.loadTrades();
    this.updateBalanceDisplay();
    const dirLabel = direction === 'long' ? '▲ LONG' : '▼ SHORT';
    const slInfo   = slPrice ? ` SL:$${slPrice.toLocaleString(undefined,{maximumFractionDigits:4})}` : '';
    const holdInfo = holdUntil ? ` ⏱${extras.holdSec}sn` : '';
    this._log(`${dirLabel} açıldı | $${entryPrice.toLocaleString(undefined,{maximumFractionDigits:4})} TP:${tpPercent}%${slInfo}${holdInfo} | ${reason}`, direction === 'long' ? 'buy' : 'sell');
    this._showToast(`${dirLabel} @ $${entryPrice.toLocaleString(undefined,{maximumFractionDigits:2})}`, direction === 'long' ? 'green' : 'red');
  },

  closeTrade(trade, reason = 'manual') {
    const exitPrice = market.currentPrice;
    const profit    = strategy.calculateProfit(trade.entryPrice, exitPrice, trade.amount, trade.direction);

    storage.updateTrade(trade.id, {
      ...trade, status: 'closed', exitPrice, profit,
      closeReason: reason, closedAt: new Date().toISOString()
    });
    storage.saveHistory({ ...trade, status: 'closed', exitPrice, profit, closeReason: reason, closedAt: new Date().toISOString() });

    auth.updateBalance(trade.amount + profit);
    this._addTradeMarker(trade.direction === 'long' ? 'sell' : 'buy', exitPrice);

    // Ajan modunda öğren
    if (this.settings.agentMode) {
      const pauseMsg = agent.learn({ profit, direction: trade.direction, closeReason: reason });
      if (pauseMsg) this._log(`[Ajan] ${pauseMsg}`, 'warn');

      // TP vurunca: aynı yönü yeniden aç + karşı taraf limit emir (MQL5 mantığı)
      if (reason === 'tp') {
        const result = agent.decideDual(market.candles, auth.currentUser?.balance || 0);
        if (result && !result.paused) {
          setTimeout(() => {
            // Aynı yönü yeniden aç
            const side = trade.direction === 'long' ? result.long : result.short;
            this.openTrade(trade.direction, side.amount, side.tpPct,
              `[Ajan] TP-Reopen-${trade.direction.toUpperCase()}`);

            // Karşı yön için limit emir ekle
            const oppDir  = trade.direction === 'long' ? 'short' : 'long';
            const oppSide = trade.direction === 'long' ? result.short : result.long;
            const pendingDist = exitPrice * (result.pendingPct / 100);
            // LONG TP → SELL LIMIT yukarda (fiyat yukarsı çıkınca tetiklenir)
            // SHORT TP → BUY LIMIT aşağıda (fiyat aşağı düşünce tetiklenir)
            const triggerPrice = trade.direction === 'long'
              ? exitPrice + pendingDist
              : exitPrice - pendingDist;
            agent.addPendingOrder(oppDir, triggerPrice, oppSide.tpPct, oppSide.amount);
            this._log(
              `[Ajan] ${oppDir === 'long' ? 'BUY LIMIT' : 'SELL LIMIT'} @ $${triggerPrice.toLocaleString(undefined,{maximumFractionDigits:2})} eklendi`,
              'info'
            );
          }, 300);
        }
      }

      this._updateAgentStats();
    }

    this.loadTrades();
    this.loadHistory();
    this.updateBalanceDisplay();
    this.updateStats();
    const sign = profit >= 0 ? '+' : '';
    const emoji = reason === 'tp' ? '🎯' : reason === 'trailing_sl' ? '🏃' : reason === 'sl' ? '🛡' : reason === 'timeout' ? '⏱' : '✋';
    this._log(`${emoji} İşlem kapandı [${reason}] | ${sign}$${profit.toFixed(2)}`, profit >= 0 ? 'buy' : 'sell');
    this._showToast(`${emoji} ${reason.toUpperCase()} | ${sign}$${profit.toFixed(2)}`, profit >= 0 ? 'green' : 'red');
  },

  closeSpecificTrade(tradeId) {
    const trade = storage.getTrades().find(t => t.id === tradeId);
    if (trade && trade.status === 'open') this.closeTrade(trade, 'manual');
  },

  closeAllTrades() {
    if (!confirm('Tüm açık işlemleri kapatmak istiyor musunuz?')) return;
    storage.getTrades().forEach(t => { if (t.status === 'open') this.closeTrade(t, 'mass_close'); });
  },

  toggleTrading(forceState, opts = {}) {
    const silent = !!opts.silent;
    const persist = opts.persist !== false;
    const next = typeof forceState === 'boolean' ? forceState : !this.isRunning;
    this.isRunning = next;
    const btn     = document.getElementById('masterToggle');
    const bigBtn  = document.getElementById('bigStartBtn');
    const banner  = document.getElementById('startBanner');
    const mode    = this.settings.agentMode ? '🤖 AJAN' : '📊 KLASİK';

    try {
      if (persist && typeof storage !== 'undefined' && typeof storage.saveBotState === 'function') {
        storage.saveBotState({ running: this.isRunning, updatedAt: new Date().toISOString() });
      }
    } catch (e) {}

    if (this.isRunning) {
      if (btn)    { btn.textContent = '⏹ Durdur'; btn.className = 'btn btn-danger px-3 py-2 text-xs'; }
      if (bigBtn) { bigBtn.textContent = '⏹ Durdur'; bigBtn.style.background = 'linear-gradient(135deg,#ef4444,#dc2626)'; }
      if (banner) banner.style.display = 'none';
      if (!silent) {
        this._log(`Robot BAŞLATILDI [${mode}] — Sinyal bekleniyor...`, 'buy');
        this._showToast(`Robot başlatıldı [${mode}]`, 'green');
      }
      setTimeout(() => this._runStrategy(), 800);
    } else {
      if (btn)    { btn.textContent = '▶ Başlat'; btn.className = 'btn btn-success px-3 py-2 text-xs'; }
      if (bigBtn) { bigBtn.textContent = '▶ Başlat'; bigBtn.style.background = 'linear-gradient(135deg,#10b981,#059669)'; }
      if (banner) banner.style.display = 'block';
      if (!silent) {
        this._log('Robot DURDURULDU', 'warn');
        this._showToast('Robot durduruldu', 'red');
      }
    }
  },

  // Ajan istatistik panelini güncelle
  _updateAgentStats() {
    const s = agent.getStats();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('agentWinRate',     s.winRate + '%');
    set('agentLongWR',      s.longWR  + (s.longWR  !== '—' ? '%' : ''));
    set('agentShortWR',     s.shortWR + (s.shortWR !== '—' ? '%' : ''));
    set('agentTotalTrades', s.totalTrades);
    set('agentPnL',         (parseFloat(s.totalPnL) >= 0 ? '+' : '') + '$' + s.totalPnL);
    set('agentTPMult',      s.tpMult + '×');
    set('agentTrailAct',    s.trailAct + '%');
    set('agentSize',        s.sizePercent + '%');
    set('agentLongMult',    s.longSizeMult + '×');
    set('agentShortMult',   s.shortSizeMult + '×');
    set('agentPending',     s.pendingCount);
    set('agentConsLoss',    s.consLosses);
    const statusEl = document.getElementById('agentStatus');
    if (statusEl) {
      statusEl.textContent = s.paused ? `⏸ Mola (${s.pauseSec}sn)` : (this.isRunning ? '🟢 Aktif' : '⚫ Bekliyor');
      statusEl.className   = s.paused ? 'text-amber-400 font-bold' : (this.isRunning ? 'text-emerald-400 font-bold' : 'text-slate-400');
    }
  },

  addBalance() {
    const input  = document.getElementById('addBalanceAmount');
    const amount = parseFloat(input?.value) || 0;
    if (amount <= 0 || amount > 1000000) { this._showToast('Geçersiz miktar!', 'red'); return; }
    auth.updateBalance(amount);
    this.updateBalanceDisplay();
    this.updateStats();
    this._log(`Bakiye eklendi: +$${amount.toLocaleString(undefined,{maximumFractionDigits:2})}`, 'buy');
    this._showToast(`+$${amount.toLocaleString(undefined,{maximumFractionDigits:2})} eklendi`, 'green');
    if (input) input.value = '';
  },

  // ─── Ekran Güncellemeleri ────────────────────────────────────────────────
  loadTrades() {
    const open = storage.getTrades().filter(t => t.status === 'open');
    document.getElementById('openTradesDisplay').textContent = open.length;

    const list = document.getElementById('tradesList');
    if (!open.length) {
      list.innerHTML = '<p class="text-slate-400 text-sm text-center py-6">Açık işlem yok</p>';
      return;
    }

    list.innerHTML = open.map(trade => {
      const p      = strategy.calculateProfit(trade.entryPrice, market.currentPrice || trade.entryPrice, trade.amount, trade.direction);
      const cls    = p >= 0 ? 'text-emerald-400' : 'text-rose-400';
      const sign   = p >= 0 ? '+' : '';
      const pct    = ((Math.abs(p) / trade.amount) * 100).toFixed(2);
      const isLong = trade.direction === 'long';
      const progress = Math.min(Math.abs(p / (trade.amount * trade.tpPercent / 100)) * 100, 100);
      const timeLeft = trade.holdUntil ? Math.max(0, Math.ceil((trade.holdUntil - Date.now()) / 1000)) : null;

      return `
        <div class="p-3 rounded-xl bg-slate-800/80 border border-slate-700 space-y-2">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="px-2 py-0.5 rounded text-xs font-bold ${isLong ? 'bg-emerald-600' : 'bg-rose-600'} text-white">
                ${isLong ? '▲ LONG' : '▼ SHORT'}
              </span>
              <span class="text-xs text-slate-500">${trade.symbol || ''}</span>
              ${timeLeft !== null ? `<span class="text-xs text-amber-400 mono">⏱${timeLeft}sn</span>` : ''}
              ${trade.reason ? `<span class="text-xs text-slate-600 truncate max-w-24">${trade.reason}</span>` : ''}
            </div>
            <button onclick="bot.closeSpecificTrade('${trade.id}')" class="px-2 py-1 rounded bg-rose-600/80 text-white text-xs hover:bg-rose-500 shrink-0">Kapat</button>
          </div>
          <div class="grid grid-cols-2 gap-1 text-xs">
            <span class="text-slate-400">Giriş: <span class="text-white mono">$${trade.entryPrice.toLocaleString(undefined,{maximumFractionDigits:4})}</span></span>
            <span class="text-slate-400">TP: <span class="text-emerald-400 mono">$${trade.tpPrice.toLocaleString(undefined,{maximumFractionDigits:4})}</span></span>
            ${trade.slPrice ? `<span class="text-slate-400">SL: <span class="text-rose-400 mono">$${trade.slPrice.toLocaleString(undefined,{maximumFractionDigits:4})}</span></span>` : '<span></span>'}
            <span class="text-slate-400">Miktar: <span class="text-white mono">$${trade.amount}</span></span>
          </div>
          <div class="flex justify-between items-center">
            <div class="flex-1 bg-slate-700 rounded-full h-1.5 mr-3">
              <div class="h-1.5 rounded-full ${p >= 0 ? 'bg-emerald-500' : 'bg-rose-500'} transition-all" style="width:${progress}%"></div>
            </div>
            <span class="text-sm font-bold ${cls}">${sign}$${p.toFixed(2)} (${sign}${pct}%)</span>
          </div>
        </div>`;
    }).join('');
  },

  loadHistory() {
    const history = storage.getHistory();
    const list    = document.getElementById('historyList');
    if (!history.length) {
      list.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-slate-400">Henüz işlem yok</td></tr>';
      return;
    }
    list.innerHTML = history.slice(0, 30).map(trade => {
      const cls  = trade.profit >= 0 ? 'text-emerald-400' : 'text-rose-400';
      const sign = trade.profit >= 0 ? '+' : '';
      const time = new Date(trade.closedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      return `
        <tr class="border-b border-slate-800 hover:bg-slate-800/50">
          <td class="py-2 text-slate-400 text-xs">${time}</td>
          <td class="py-2"><span class="px-1.5 py-0.5 rounded text-xs font-bold ${trade.direction==='long'?'bg-emerald-600':'bg-rose-600'} text-white">${trade.direction==='long'?'▲ L':'▼ S'}</span></td>
          <td class="py-2 text-xs text-slate-300">${trade.symbol||''}</td>
          <td class="py-2 font-mono text-xs">$${trade.entryPrice.toLocaleString(undefined,{maximumFractionDigits:4})}</td>
          <td class="py-2 font-mono text-xs">$${trade.exitPrice.toLocaleString(undefined,{maximumFractionDigits:4})}</td>
          <td class="py-2 font-bold text-sm ${cls}">${sign}$${trade.profit.toFixed(2)}</td>
        </tr>`;
    }).join('');
  },

  updateStats() {
    const history = storage.getHistory();
    const today   = new Date().toDateString();

    const dailyProfit = history.filter(h => new Date(h.closedAt).toDateString() === today)
                               .reduce((s, h) => s + h.profit, 0);
    const totalProfit = history.reduce((s, h) => s + h.profit, 0);

    const dEl = document.getElementById('dailyProfitDisplay');
    dEl.textContent = (dailyProfit >= 0 ? '+' : '') + '$' + dailyProfit.toFixed(2);
    dEl.className   = 'text-xl font-bold ' + (dailyProfit >= 0 ? 'profit' : 'loss');

    const tEl = document.getElementById('totalProfitDisplay');
    tEl.textContent = (totalProfit >= 0 ? '+' : '') + '$' + totalProfit.toFixed(2);
    tEl.className   = 'text-xl font-bold ' + (totalProfit >= 0 ? 'profit' : 'loss');
  },

  updateBalanceDisplay() {
    if (auth.currentUser)
      document.getElementById('balanceDisplay').textContent = '$' + parseFloat(auth.currentUser.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  _updateStatus(text) {
    const el = document.getElementById('botStatus');
    if (el) el.textContent = text;
  },

  // ─── Aktivite Logu ───────────────────────────────────────────────────────
  _log(msg, type = 'info') {
    const el = document.getElementById('activityLog');
    if (!el) return;
    const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = {
      info: 'text-slate-400',
      buy:  'text-emerald-400',
      sell: 'text-rose-400',
      warn: 'text-amber-400'
    }[type] || 'text-slate-400';
    const div = document.createElement('div');
    div.className = `flex gap-2 text-xs py-0.5 border-b border-slate-800/50`;
    div.innerHTML = `<span class="text-slate-600 mono shrink-0">${time}</span><span class="${cls}">${msg}</span>`;
    el.prepend(div);
    while (el.children.length > 30) el.removeChild(el.lastChild);
  },

  _showToast(msg, color = 'green') {
    const colors = { green: '#10b981', red: '#ef4444' };
    const toast  = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = `
      position:fixed;bottom:80px;right:16px;z-index:9999;
      background:${colors[color]||colors.green};color:white;
      padding:10px 16px;border-radius:10px;font-size:13px;font-weight:600;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);pointer-events:none;`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }
};

window.addEventListener('beforeunload', () => {
  if (bot.updateInterval) clearInterval(bot.updateInterval);
  if (bot.signalTimer)    clearInterval(bot.signalTimer);
  market.disconnect();
});
