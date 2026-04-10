// Trading Stratejileri ve Algoritmalar
const strategy = {
  // Trend analizi
  analyzeTrend(prices, period = 20) {
    if (prices.length < period) return { trend: 'neutral', strength: 0 };
    
    const recent = prices.slice(-period);
    const sma = this.calculateSMA(recent, period);
    const current = recent[recent.length - 1];
    
    // EMA hesapla
    const ema12 = this.calculateEMA(recent, 12);
    const ema26 = this.calculateEMA(recent, 26);
    
    // MACD
    const macd = ema12 - ema26;
    
    // RSI
    const rsi = this.calculateRSI(recent, 14);
    
    // Trend yönü — RSI bazlı normalize strength
    let trend = 'neutral';
    let strength = 0;
    const priceDiffPct = ((current - sma) / sma) * 100;  // %0.1 gibi
    const macdPct = (macd / sma) * 100;                  // normalize

    if (current > sma && macd > 0 && rsi > 50) {
      trend = 'uptrend';
      // RSI 50→100 → strength 0→50, priceDiff ve MACD bonus
      strength = Math.min((rsi - 50) + Math.abs(priceDiffPct) * 20 + Math.abs(macdPct) * 20, 100);
    } else if (current < sma && macd < 0 && rsi < 50) {
      trend = 'downtrend';
      strength = Math.min((50 - rsi) + Math.abs(priceDiffPct) * 20 + Math.abs(macdPct) * 20, 100);
    }
    
    return { trend, strength, rsi, macd, sma };
  },

  // Yatay bant (Range) analizi
  analyzeRange(prices, period = 20) {
    if (prices.length < period) return { isRange: false, support: 0, resistance: 0 };
    
    const recent = prices.slice(-period);
    const high = Math.max(...recent);
    const low = Math.min(...recent);
    const range = high - low;
    const current = recent[recent.length - 1];
    
    // Bollinger Bands
    const sma = this.calculateSMA(recent, period);
    const stdDev = this.calculateStdDev(recent, sma);
    const upperBand = sma + (stdDev * 2);
    const lowerBand = sma - (stdDev * 2);
    
    // Yatay bant koşulları
    const isRange = range < (sma * 0.05); // %5'den az değişim
    const position = (current - lowerBand) / (upperBand - lowerBand);
    
    return {
      isRange,
      support: lowerBand,
      resistance: upperBand,
      middle: sma,
      position,
      range
    };
  },

  // Kırılım (Breakout) tespiti
  detectBreakout(prices, period = 20) {
    if (prices.length < period + 5) return { breakout: false, direction: null };
    
    const recent = prices.slice(-period);
    const previous = prices.slice(-period - 5, -period);
    
    const high = Math.max(...recent);
    const low = Math.min(...recent);
    const prevHigh = Math.max(...previous);
    const prevLow = Math.min(...previous);
    
    const current = recent[recent.length - 1];
    
    let breakout = false;
    let direction = null;
    
    if (current > prevHigh * 1.01) {
      breakout = true;
      direction = 'up';
    } else if (current < prevLow * 0.99) {
      breakout = true;
      direction = 'down';
    }
    
    return { breakout, direction, level: breakout ? current : null };
  },

  // Volatilite hesaplama
  calculateVolatility(prices, period = 20) {
    if (prices.length < period) return 0;
    
    const recent = prices.slice(-period);
    const returns = [];
    
    for (let i = 1; i < recent.length; i++) {
      returns.push((recent[i] - recent[i-1]) / recent[i-1]);
    }
    
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
    
    return Math.sqrt(variance) * 100; // Yüzde olarak
  },

  // Ana karar fonksiyonu
  generateSignal(prices, strategyType = 'trend') {
    const trend = this.analyzeTrend(prices);
    const range = this.analyzeRange(prices);
    const breakout = this.detectBreakout(prices);
    const volatility = this.calculateVolatility(prices);
    
    let signal = { action: 'hold', direction: null, confidence: 0, reason: '' };
    
    switch (strategyType) {
      case 'trend':
        if (trend.trend === 'uptrend' && trend.strength > 35) {
          signal = { action: 'buy', direction: 'long', confidence: trend.strength, reason: `Yükseliş (RSI:${trend.rsi?.toFixed(0)})` };
        } else if (trend.trend === 'downtrend' && trend.strength > 35) {
          signal = { action: 'sell', direction: 'short', confidence: trend.strength, reason: `Düşüş (RSI:${trend.rsi?.toFixed(0)})` };
        }
        break;
        
      case 'range':
        if (range.isRange) {
          if (range.position < 0.2) {
            signal = { action: 'buy', direction: 'long', confidence: 70, reason: 'Destek seviyesinde' };
          } else if (range.position > 0.8) {
            signal = { action: 'sell', direction: 'short', confidence: 70, reason: 'Direnç seviyesinde' };
          }
        }
        break;
        
      case 'breakout':
        if (breakout.breakout) {
          if (breakout.direction === 'up') {
            signal = { action: 'buy', direction: 'long', confidence: 80, reason: 'Yukarı kırılım' };
          } else {
            signal = { action: 'sell', direction: 'short', confidence: 80, reason: 'Aşağı kırılım' };
          }
        }
        break;
        
      case 'mixed':
        // Karma strateji - öncelik sırası: kırılım → trend → bant
        if (breakout.breakout) {
          signal = {
            action: breakout.direction === 'up' ? 'buy' : 'sell',
            direction: breakout.direction === 'up' ? 'long' : 'short',
            confidence: 85,
            reason: `Kırılım (${breakout.direction === 'up' ? '▲' : '▼'})`
          };
        } else if (trend.trend === 'uptrend' && trend.strength > 30 && !range.isRange) {
          signal = { action: 'buy', direction: 'long', confidence: trend.strength, reason: `Trend ▲ (RSI:${trend.rsi?.toFixed(0)})` };
        } else if (trend.trend === 'downtrend' && trend.strength > 30 && !range.isRange) {
          signal = { action: 'sell', direction: 'short', confidence: trend.strength, reason: `Trend ▼ (RSI:${trend.rsi?.toFixed(0)})` };
        } else if (range.isRange) {
          if (range.position < 0.25) {
            signal = { action: 'buy', direction: 'long', confidence: 65, reason: 'Bant desteği' };
          } else if (range.position > 0.75) {
            signal = { action: 'sell', direction: 'short', confidence: 65, reason: 'Bant direnci' };
          }
        }
        break;
    }
    
    // Minimum confidence garantisi (sinyal varsa)
    if (signal.action !== 'hold' && signal.confidence < 30) signal.confidence = 30;

    // Volatilite çok yüksekse risk azalt
    if (volatility > 3) {
      signal.confidence *= 0.85;
      signal.reason += ' ⚡';
    }
    
    return {
      ...signal,
      trend,
      range,
      breakout,
      volatility
    };
  },

  // Yardımcı fonksiyonlar
  calculateSMA(prices, period) {
    const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  },

  calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  },

  calculateRSI(prices, period) {
    if (prices.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = 1; i <= period; i++) {
      const change = prices[prices.length - period + i] - prices[prices.length - period + i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  },

  calculateStdDev(prices, mean) {
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
    return Math.sqrt(variance);
  },

  // TP seviyesi hesaplama
  calculateTP(entryPrice, direction, percent) {
    const multiplier = direction === 'long' ? 1 : -1;
    return entryPrice * (1 + (multiplier * percent / 100));
  },

  // SL seviyesi hesaplama
  calculateSL(entryPrice, direction, percent) {
    const multiplier = direction === 'long' ? -1 : 1;
    return entryPrice * (1 + (multiplier * percent / 100));
  },

  // Kâr hesaplama
  calculateProfit(entryPrice, exitPrice, amount, direction) {
    const priceDiff = direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
    return (priceDiff / entryPrice) * amount;
  }
};
