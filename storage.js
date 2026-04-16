// Veri Saklama Sistemi - LocalStorage
const storage = {
  _currentUserId: null,

  _trades: [],
  _history: [],
  _settings: null,
  _prices: [],
  _agentState: null,
  _botState: null,

  _listeners: [],
  _subscribers: [],

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._subscribers.push(fn);
    return () => {
      try { this._subscribers = this._subscribers.filter(x => x !== fn); } catch (e) {}
    };
  },

  _emitChange(type) {
    try { this._subscribers.forEach(fn => { try { fn(type); } catch (e) {} }); } catch (e) {}
  },

  setCurrentUser(user) {
    this._currentUserId = user?.id || null;
  },

  clearCurrentUser() {
    try { this.stopRealtimeSync(); } catch (e) {}
    this._currentUserId = null;
    this._trades = [];
    this._history = [];
    this._settings = null;
    this._prices = [];
    this._agentState = null;
    this._botState = null;
  },

  _encodeKey(key) {
    return String(key || '')
      .replace(/\./g, ',')
      .replace(/#/g, ',')
      .replace(/\$/g, ',')
      .replace(/\[/g, ',')
      .replace(/\]/g, ',');
  },

  _getDb() {
    try {
      if (!window.firebase) return null;
      if (!firebase.apps || !firebase.apps.length) return null;
      return firebase.database();
    } catch (e) {
      return null;
    }
  },

  _userRoot() {
    if (!this._currentUserId) return null;
    return `userData/${this._currentUserId}`;
  },

  _defaults() {
    return {
      maxTrades:      5,
      tradeAmount:    100,
      tpPercent:      1.5,
      strategy:       'mixed',
      signalInterval: 30,
      minConfidence:  55,
      agentMode:      true,
      symbol:         'BTCUSDT',
      interval:       '1m'
    };
  },

  _remoteSet(path, value) {
    try {
      const db = this._getDb();
      if (!db) return;
      db.ref(path).set(value).catch(() => {});
    } catch (e) {}
  },

  _remoteUpdate(path, updates) {
    try {
      const db = this._getDb();
      if (!db) return;
      db.ref(path).update(updates).catch(() => {});
    } catch (e) {}
  },

  async pullUserData() {
    try {
      const db = this._getDb();
      const root = this._userRoot();
      if (!db || !root) return;
      const snap = await db.ref(root).once('value');
      const data = snap.val();
      if (!data) {
        this._trades = [];
        this._history = [];
        this._settings = this._defaults();
        this._prices = [];
        this._agentState = null;
        this._botState = { running: false, updatedAt: new Date().toISOString() };

        this._remoteSet(`${root}/trades`, this._trades);
        this._remoteSet(`${root}/history`, this._history);
        this._remoteSet(`${root}/settings`, this._settings);
        this._remoteSet(`${root}/prices`, this._prices);
        this._remoteSet(`${root}/botState`, this._botState);
        try { this._emitChange('bootstrap'); } catch (e) {}
        return;
      }

      this._trades = Array.isArray(data.trades) ? data.trades : [];
      this._history = Array.isArray(data.history) ? data.history : [];
      this._settings = { ...this._defaults(), ...(data.settings || {}) };
      this._prices = Array.isArray(data.prices) ? data.prices : [];
      this._agentState = data.agent || null;
      this._botState = data.botState || { running: false, updatedAt: new Date().toISOString() };
      try { this._emitChange('pull'); } catch (e) {}
    } catch (e) {}
  },

  stopRealtimeSync() {
    try {
      const db = this._getDb();
      if (db && Array.isArray(this._listeners)) {
        this._listeners.forEach(l => {
          try { if (l && l.ref && l.cb) l.ref.off('value', l.cb); } catch (e) {}
        });
      }
    } catch (e) {}
    this._listeners = [];
  },

  startRealtimeSync() {
    this.stopRealtimeSync();
    const db = this._getDb();
    const root = this._userRoot();
    if (!db || !root) return;

    const bindValue = (path, onValue) => {
      try {
        const ref = db.ref(path);
        const cb = (snap) => {
          try { onValue(snap ? snap.val() : null); } catch (e) {}
        };
        ref.on('value', cb);
        this._listeners.push({ ref, cb });
      } catch (e) {}
    };

    bindValue(`${root}/trades`, (v) => {
      this._trades = Array.isArray(v) ? v : [];
      this._emitChange('trades');
    });
    bindValue(`${root}/history`, (v) => {
      this._history = Array.isArray(v) ? v : [];
      this._emitChange('history');
    });
    bindValue(`${root}/settings`, (v) => {
      this._settings = { ...this._defaults(), ...(v || {}) };
      this._emitChange('settings');
    });
    bindValue(`${root}/botState`, (v) => {
      this._botState = v || { running: false, updatedAt: new Date().toISOString() };
      this._emitChange('botState');
    });
  },

  async getUserProfile(uid) {
    try {
      const db = this._getDb();
      if (!db || !uid) return null;
      const snap = await db.ref(`usersById/${uid}`).once('value');
      return snap.val();
    } catch (e) {
      return null;
    }
  },

  async saveUserProfile(uid, profile) {
    try {
      const db = this._getDb();
      if (!db || !uid) return;
      await db.ref(`usersById/${uid}`).set(profile);
      if (profile?.email) {
        const k = this._encodeKey(profile.email);
        await db.ref(`usersByEmail/${k}`).set({ uid, email: profile.email });
      }
      const root = `userData/${uid}`;
      await db.ref(`${root}/profile`).set({
        name: profile?.name || '',
        email: profile?.email || '',
        balance: profile?.balance ?? 0
      });
    } catch (e) {}
  },

  updateUserBalance(email, newBalance) {
    const uid = this._currentUserId;
    if (!uid) return;
    this._remoteUpdate(`usersById/${uid}`, { balance: newBalance });
    this._remoteSet(`userData/${uid}/profile/balance`, newBalance);
  },

  // Trades
  saveTrade(trade) {
    this._trades.push(trade);

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/trades`, this._trades);
    try { this._emitChange('trades'); } catch (e) {}
  },

  getTrades() {
    return this._trades;
  },

  updateTrade(tradeId, updates) {
    const trades = this._trades;
    const index = trades.findIndex(t => t.id === tradeId);
    if (index !== -1) {
      trades[index] = { ...trades[index], ...updates };

      const root = this._userRoot();
      if (root) this._remoteSet(`${root}/trades`, trades);
      try { this._emitChange('trades'); } catch (e) {}
    }
  },

  removeTrade(tradeId) {
    const trades = this._trades;
    const filtered = trades.filter(t => t.id !== tradeId);
    this._trades = filtered;

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/trades`, filtered);
    try { this._emitChange('trades'); } catch (e) {}
  },

  // History
  saveHistory(record) {
    const history = this._history;
    history.unshift(record);
    // Keep only last 100 records
    if (history.length > 100) history.pop();

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/history`, history);
    try { this._emitChange('history'); } catch (e) {}
  },

  getHistory() {
    return this._history;
  },

  // Settings
  saveSettings(settings) {
    this._settings = { ...this._defaults(), ...(settings || {}) };

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/settings`, this._settings);
    try { this._emitChange('settings'); } catch (e) {}
  },

  getSettings() {
    if (!this._settings) this._settings = this._defaults();
    return this._settings;
  },

  // Price Data
  savePriceData(prices) {
    this._prices = Array.isArray(prices) ? prices : [];

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/prices`, this._prices);
  },

  getPriceData() {
    return this._prices;
  },

  saveAgentState(agentState) {
    this._agentState = agentState || null;

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/agent`, agentState);
  },

  getAgentState() {
    return this._agentState;
  },

  saveBotState(botState) {
    this._botState = botState || null;
    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/botState`, botState);
    try { this._emitChange('botState'); } catch (e) {}
  },

  getBotState() {
    return this._botState;
  }
};
