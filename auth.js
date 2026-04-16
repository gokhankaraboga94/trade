// Üyelik ve Kimlik Doğrulama Sistemi
const auth = {
  currentUser: null,
  isRegisterMode: false,
  _booted: false,
  _mainShown: false,

  async init() {
    if (this._booted) return;
    this._booted = true;

    try {
      if (!window.firebase || !firebase.auth) return;
      firebase.auth().onAuthStateChanged(async (fbUser) => {
        if (!fbUser) {
          this.currentUser = null;
          this._mainShown = false;
          if (window.storage) storage.clearCurrentUser();
          document.getElementById('authScreen').classList.remove('hidden');
          document.getElementById('mainApp').classList.add('hidden');
          return;
        }

        const profile = await storage.getUserProfile(fbUser.uid);
        const name = profile?.name || fbUser.displayName || '';
        const balance = typeof profile?.balance === 'number' ? profile.balance : 10000;
        this.currentUser = { id: fbUser.uid, name, email: fbUser.email || profile?.email || '', balance };
        await this.showMainApp();
      });
    } catch (e) {}
  },

  toggleAuthMode() {
    this.isRegisterMode = !this.isRegisterMode;
    document.getElementById('loginForm').classList.toggle('hidden');
    document.getElementById('registerForm').classList.toggle('hidden');
  },

  async register() {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regPasswordConfirm').value;

    if (!name || !email || !password) {
      alert('Tüm alanları doldurun!');
      return;
    }

    if (password !== confirm) {
      alert('Şifreler eşleşmiyor!');
      return;
    }

    if (password.length < 6) {
      alert('Şifre en az 6 karakter olmalı!');
      return;
    }

    try {
      const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
      const uid = cred?.user?.uid;
      if (!uid) { alert('Kayıt başarısız!'); return; }

      if (cred.user && name) {
        try { await cred.user.updateProfile({ displayName: name }); } catch (e) {}
      }

      const profile = {
        uid,
        name,
        email,
        balance: 10000,
        createdAt: new Date().toISOString()
      };
      await storage.saveUserProfile(uid, profile);

      alert('Kayıt başarılı!');
    } catch (e) {
      alert(e?.message || 'Kayıt başarısız!');
    }
  },

  async login() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) {
      alert('E-posta ve şifre girin!');
      return;
    }

    try {
      await firebase.auth().signInWithEmailAndPassword(email, password);
    } catch (e) {
      alert(e?.message || 'E-posta veya şifre hatalı!');
    }
  },

  logout() {
    try {
      firebase.auth().signOut();
    } catch (e) {}
  },

  async showMainApp() {
    if (this._mainShown) return;
    this._mainShown = true;
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    document.getElementById('userDisplay').textContent = this.currentUser.name;
    storage.setCurrentUser(this.currentUser);
    await storage.pullUserData();

    try {
      storage.startRealtimeSync();
    } catch (e) {}

    try {
      const db = (typeof storage !== 'undefined' && storage._getDb) ? storage._getDb() : null;
      const uid = this.currentUser?.id;
      if (db && uid) {
        db.ref(`usersById/${uid}/balance`).on('value', (s) => {
          const v = s ? s.val() : null;
          if (typeof v === 'number') {
            if (this.currentUser) this.currentUser.balance = v;
            try { bot.updateBalanceDisplay(); } catch (e) {}
          }
        });
      }
    } catch (e) {}
    
    // Initialize bot
    await bot.init();
  },

  generateId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  },

  hashPassword(password) {
    // Simple hash for demo - use proper hashing in production
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
      const char = password.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  },

  updateBalance(amount) {
    if (this.currentUser) {
      this.currentUser.balance += amount;
      storage.updateUserBalance(this.currentUser.email, this.currentUser.balance);
      document.getElementById('balanceDisplay').textContent = '$' + this.currentUser.balance.toLocaleString();
    }
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => auth.init());
