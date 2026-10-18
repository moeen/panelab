const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')

/**
 * Test-only safeStorage substitute. The key belongs to one fixture and is never written to disk.
 * This verifies application persistence, not macOS Keychain behavior.
 * @param {Buffer} key
 */
exports.encryption = function encryption(key) {
  if (key.length !== 32) throw new Error('Expected a 32-byte test key.')
  return {
    isAsyncEncryptionAvailable: async () => true,
    /** @param {string} text */
    encryptStringAsync: async (text) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), data])
    },
    /** @param {Buffer} data */
    decryptStringAsync: async (data) => {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      decipher.setAuthTag(data.subarray(12, 28))
      const result = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()])
      return { result: result.toString('utf8'), shouldReEncrypt: false }
    },
  }
}
