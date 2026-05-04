import { describe, it, expect } from 'vitest';
import { encryptWithKey } from '../src/crypto/encrypt.js';
import { decryptWithKey } from '../src/crypto/decrypt.js';
import { AES_IV_LENGTH } from '../src/constants.js';
import type { DecryptionKey } from '../src/types.js';

/**
 * WebCrypto AES-256-GCM roundtrip tests.
 * These validate the local encrypt/decrypt path used for non-media assets.
 * No Lit Protocol, no wallet, no network — pure crypto.
 */
describe('AES-GCM roundtrip (encryptWithKey / decryptWithKey)', () => {
  async function generateKey(): Promise<Uint8Array> {
    const key = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const raw = await globalThis.crypto.subtle.exportKey('raw', key);
    return new Uint8Array(raw);
  }

  function buildDecryptionKey(raw: Uint8Array): DecryptionKey {
    return {
      raw,
      keyId: 'test-key',
      algorithm: 'aes-gcm',
    };
  }

  it('encrypts and decrypts a short message', async () => {
    const keyBytes = await generateKey();
    const plaintext = new TextEncoder().encode('Hello Elacity dDRM!');

    const { encrypted, iv } = await encryptWithKey(plaintext, keyBytes);

    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);

    const decrypted = await decryptWithKey(combined, buildDecryptionKey(keyBytes));
    expect(new TextDecoder().decode(decrypted)).toBe('Hello Elacity dDRM!');
  });

  it('encrypts and decrypts binary data', async () => {
    const keyBytes = await generateKey();
    const plaintext = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 64, 32]);

    const { encrypted, iv } = await encryptWithKey(plaintext, keyBytes);

    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);

    const decrypted = await decryptWithKey(combined, buildDecryptionKey(keyBytes));
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('produces an IV of correct length', async () => {
    const keyBytes = await generateKey();
    const plaintext = new TextEncoder().encode('test');

    const { iv } = await encryptWithKey(plaintext, keyBytes);
    expect(iv.length).toBe(AES_IV_LENGTH);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const keyBytes = await generateKey();
    const plaintext = new TextEncoder().encode('same input twice');

    const result1 = await encryptWithKey(plaintext, keyBytes);
    const result2 = await encryptWithKey(plaintext, keyBytes);

    const cipher1 = Array.from(result1.encrypted);
    const cipher2 = Array.from(result2.encrypted);
    expect(cipher1).not.toEqual(cipher2);
  });

  it('fails to decrypt with the wrong key', async () => {
    const keyBytes = await generateKey();
    const wrongKey = await generateKey();
    const plaintext = new TextEncoder().encode('secret');

    const { encrypted, iv } = await encryptWithKey(plaintext, keyBytes);

    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);

    await expect(
      decryptWithKey(combined, buildDecryptionKey(wrongKey))
    ).rejects.toThrow();
  });

  it('fails with unsupported algorithm', async () => {
    const keyBytes = await generateKey();
    const badKey: DecryptionKey = {
      raw: keyBytes,
      keyId: 'test',
      algorithm: 'aes-ctr',
    };

    await expect(
      decryptWithKey(new Uint8Array(32), badKey)
    ).rejects.toThrow('Unsupported algorithm');
  });

  it('handles empty plaintext', async () => {
    const keyBytes = await generateKey();
    const plaintext = new Uint8Array(0);

    const { encrypted, iv } = await encryptWithKey(plaintext, keyBytes);

    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);

    const decrypted = await decryptWithKey(combined, buildDecryptionKey(keyBytes));
    expect(decrypted.length).toBe(0);
  });

  it('handles large data (1MB)', async () => {
    const keyBytes = await generateKey();
    const plaintext = new Uint8Array(1024 * 1024);
    for (let offset = 0; offset < plaintext.length; offset += 65536) {
      const chunk = plaintext.subarray(offset, offset + 65536);
      globalThis.crypto.getRandomValues(chunk);
    }

    const { encrypted, iv } = await encryptWithKey(plaintext, keyBytes);

    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);

    const decrypted = await decryptWithKey(combined, buildDecryptionKey(keyBytes));
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });
});
