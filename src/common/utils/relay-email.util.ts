import { randomBytes } from 'crypto';

/**
 * Relay email username validation pattern
 * - Must start and end with alphanumeric characters
 * - Can contain dots (.) and hyphens (-) only in the middle
 * - Single character usernames are allowed
 */
export const RELAY_USERNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

/**
 * Validate relay email username
 * @param username - The username to validate
 * @returns true if valid, false otherwise
 */
export function isValidRelayUsername(username: string): boolean {
  return RELAY_USERNAME_PATTERN.test(username);
}

/**
 * Generate random relay email username
 * Generates a 10-character alphanumeric string with a hyphen after the 4th character.
 * e.g. xx12-xxx34
 * @returns A random username
 */
export function generateRelayUsername(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const chars = letters.concat(numbers);
  const bytes = randomBytes(9);

  // First character should be a letter
  let pre = letters[bytes[0] % letters.length];
  let post = '';

  for (let i = 1; i < 4; i++) {
    pre += chars[bytes[i] % chars.length];
  }

  // Add hyphen after the 4th character
  for (let i = 4; i < 9; i++) {
    post += chars[bytes[i] % chars.length];
  }

  return `${pre}-${post}`;
}

/**
 * Error message for invalid relay username
 */
export const RELAY_USERNAME_ERROR_MESSAGE =
  'Username must start and end with alphanumeric characters, and can only contain letters, numbers, dots, and hyphens';
