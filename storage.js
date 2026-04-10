// Veri Saklama Sistemi - LocalStorage
const storage = {
  _currentUserId: null,

  _trades: [],
  _history: [],
  _settings: null,
  _prices: [],
  _agentState: null,

  setCurrentUser(user) {
    this._currentUserId = user?.id || null;
  },

  clearCurrentUser() {
    this._currentUserId = null;
    this._trades = [];
    this._history = [];
    this._settings = null;
    this._prices = [];
    this._agentState = null;
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

        this._remoteSet(`${root}/trades`, this._trades);
        this._remoteSet(`${root}/history`, this._history);
        this._remoteSet(`${root}/settings`, this._settings);
        this._remoteSet(`${root}/prices`, this._prices);
        return;
      }

      this._trades = Array.isArray(data.trades) ? data.trades : [];
      this._history = Array.isArray(data.history) ? data.history : [];
      this._settings = { ...this._defaults(), ...(data.settings || {}) };
      this._prices = Array.isArray(data.prices) ? data.prices : [];
      this._agentState = data.agent || null;
    } catch (e) {}
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
    }
  },

  removeTrade(tradeId) {
    const trades = this._trades;
    const filtered = trades.filter(t => t.id !== tradeId);
    this._trades = filtered;

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/trades`, filtered);
  },

  // History
  saveHistory(record) {
    const history = this._history;
    history.unshift(record);
    // Keep only last 100 records
    if (history.length > 100) history.pop();

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/history`, history);
  },

  getHistory() {
    return this._history;
  },

  // Settings
  saveSettings(settings) {
    this._settings = { ...this._defaults(), ...(settings || {}) };

    const root = this._userRoot();
    if (root) this._remoteSet(`${root}/settings`, this._settings);
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
  }
};
