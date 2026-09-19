import { BadRequestException } from '@nestjs/common';

export interface UsernameInput {
  username?: string;
  encryptedUsername?: string;
}

export interface UsernameChangeInput {
  newUsername?: string;
  encryptedNewUsername?: string;
}

export interface SelectedUsernameInput {
  value: string;
  isEncrypted: boolean;
}

export function selectUsernameInput(input: UsernameInput): SelectedUsernameInput {
  return selectValuePair(input.username, input.encryptedUsername, 'username', 'encryptedUsername');
}

export function selectUsernameChangeInput(input: UsernameChangeInput): SelectedUsernameInput {
  return selectValuePair(
    input.newUsername,
    input.encryptedNewUsername,
    'newUsername',
    'encryptedNewUsername',
  );
}

function selectValuePair(
  plaintextValue: string | undefined,
  encryptedValue: string | undefined,
  plaintextName: string,
  encryptedName: string,
): SelectedUsernameInput {
  const hasPlaintextField = plaintextValue !== undefined;
  const hasEncryptedField = encryptedValue !== undefined;
  const hasExactlyOneField = hasPlaintextField !== hasEncryptedField;
  const hasPlaintextValue = hasValue(plaintextValue);
  const hasEncryptedValue = hasValue(encryptedValue);

  if (!hasExactlyOneField) {
    throw new BadRequestException(`Provide exactly one of ${plaintextName} or ${encryptedName}`);
  }

  if (hasPlaintextField) {
    if (!hasPlaintextValue) {
      throw new BadRequestException(`${plaintextName} must not be empty`);
    }

    if (plaintextValue === undefined) {
      throw new BadRequestException('Username value is missing');
    }

    return {
      value: plaintextValue,
      isEncrypted: false,
    };
  }

  if (!hasEncryptedValue) {
    throw new BadRequestException(`${encryptedName} must not be empty`);
  }

  if (encryptedValue === undefined) {
    throw new BadRequestException('Encrypted username value is missing');
  }

  return {
    value: encryptedValue,
    isEncrypted: true,
  };
}

function hasValue(value: unknown): value is string {
  const isStringValue = typeof value === 'string';
  if (!isStringValue) {
    return false;
  }

  return value.trim().length > 0;
}
