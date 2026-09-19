import { BadRequestException } from '@nestjs/common';
import {
  selectUsernameChangeInput,
  selectUsernameInput,
} from 'src/common/utils/username-input.util';

describe('username input selection', () => {
  it('accepts exactly one plaintext or encrypted username', () => {
    expect(selectUsernameInput({ username: 'person@example.com' })).toEqual({
      value: 'person@example.com',
      isEncrypted: false,
    });
    expect(selectUsernameInput({ encryptedUsername: 'ciphertext' })).toEqual({
      value: 'ciphertext',
      isEncrypted: true,
    });
  });

  it.each([
    {},
    { username: '', encryptedUsername: '' },
    { username: 'person@example.com', encryptedUsername: 'ciphertext' },
    { username: null as unknown as string },
  ])('rejects missing, empty, null, or ambiguous username input: %p', (input) => {
    expect(() => selectUsernameInput(input)).toThrow(BadRequestException);
  });

  it('applies the same XOR rule to username changes', () => {
    expect(selectUsernameChangeInput({ newUsername: 'next@example.com' })).toEqual({
      value: 'next@example.com',
      isEncrypted: false,
    });
    expect(
      selectUsernameChangeInput({
        encryptedNewUsername: 'legacy-ciphertext',
      }),
    ).toEqual({ value: 'legacy-ciphertext', isEncrypted: true });
    expect(() =>
      selectUsernameChangeInput({
        newUsername: 'next@example.com',
        encryptedNewUsername: 'legacy-ciphertext',
      }),
    ).toThrow(BadRequestException);
  });
});
