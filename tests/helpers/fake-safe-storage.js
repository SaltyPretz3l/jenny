function createFakeSafeStorage() {
  return {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(value) {
      return Buffer.from(String(value || ''), 'utf8');
    },
    decryptString(buffer) {
      return Buffer.from(buffer).toString('utf8');
    },
  };
}

module.exports = {
  createFakeSafeStorage,
};
